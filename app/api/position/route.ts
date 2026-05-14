import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";
import { getVanPosition } from "@/lib/bouncie";
import { supabaseAdmin } from "@/lib/supabase";
import { logTripEvent } from "@/lib/log";
import { deriveHeading } from "@/lib/bearing";
import { fuseFromPhone } from "@/lib/fuse-position";

export const dynamic = "force-dynamic";

// 100m geofence — when the van enters this radius around a pickup or dropoff
// point AND the trip is in the right state, we advance status automatically.
// Saves Dio (and Mark) from tapping when his app is frozen or he's busy.
const GEOFENCE_M = 100;
// Mark's spec: "as soon as sprinter comes within 30m of it, that stop
// is gone." Triggers the canonical "we reached this place" signal —
// stamps arrived_at on stops, used to short-circuit status forward to
// onboard, and (downstream) hides the stop from the map, the trip
// card, and the ETA's `upcoming` list app-wide.
const ARRIVE_M = 30;

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const pos = await getVanPosition();

  // Bouncie's consumer tier reports every ~15–30s — at 55 mph that's a
  // third of a mile of position lag. When Mark's or Dio's phone is in
  // the van and reporting fresh GPS via /api/mark-location or
  // /api/driver-location, we use that for lat/lng (still keeping
  // Bouncie's vehicle-side speed/fuel/odometer).
  //
  // ONLY fuses on a live `bouncie` source — `bouncie_cached` means the
  // dongle hasn't pinged recently and the proximity baseline is stale.
  // fuseFromPhone() also self-gates on speed + tight proximity so a
  // parked van + Mark stepping out can't drag the van icon to his coords.
  if (pos.source === "bouncie") {
    const fused = await fuseFromPhone({
      lat: pos.lat,
      lng: pos.lng,
      speed_mph: pos.speed_mph,
      source: pos.source,
    });
    if (fused) {
      pos.lat = fused.lat;
      pos.lng = fused.lng;
      pos.updated_at = fused.reported_at;
    }
  }

  // Bouncie reports heading=0 on our tier. Compute a real bearing from the
  // last ~50m of vehicle_positions so the on-screen van icon points the
  // direction the van is actually going. Runs AFTER fusion so the bearing
  // reflects the (possibly phone-overridden) current point.
  if (pos.source === "bouncie" || pos.source === "bouncie_cached") {
    const derived = await deriveHeading(pos.lat, pos.lng);
    if (derived != null) pos.heading = derived;
  }

  // Persist latest to van_position ONLY when something actually changed.
  // Writing on every GET (when nothing changed) creates a realtime feedback
  // loop: CDC fires → subscriber refetches → /api/position writes again →
  // CDC fires again. Suppress when lat/lng/speed are essentially the same
  // AND updated_at hasn't advanced. Subscribers (TV map, Mark home) now
  // only get pushed events when there's a real change worth re-rendering.
  try {
    const sb = supabaseAdmin();
    const { data: prev } = await sb
      .from("van_position")
      .select("lat,lng,speed_mph,fuel_pct,updated_at")
      .eq("id", 1)
      .maybeSingle();
    const prevLat = (prev?.lat as number | null) ?? null;
    const prevLng = (prev?.lng as number | null) ?? null;
    const prevSpeed = (prev?.speed_mph as number | null) ?? null;
    const prevFuel = (prev?.fuel_pct as number | null) ?? null;
    const movedM =
      prevLat != null && prevLng != null
        ? Math.hypot((pos.lat - prevLat) * 111_111, (pos.lng - prevLng) * 111_111 * Math.cos((pos.lat * Math.PI) / 180))
        : Infinity;
    const speedDelta = Math.abs((pos.speed_mph ?? 0) - (prevSpeed ?? 0));
    const fuelDelta = Math.abs((pos.fuel_pct ?? 0) - (prevFuel ?? 0));
    const noPrev = !prev || prevLat == null;
    if (noPrev || movedM > 3 || speedDelta >= 1 || fuelDelta >= 0.005) {
      await sb
        .from("van_position")
        .update({
          lat: pos.lat,
          lng: pos.lng,
          heading: pos.heading,
          speed_mph: pos.speed_mph,
          fuel_pct: pos.fuel_pct,
          battery_v: pos.battery_v,
          mileage: pos.mileage,
          ignition: pos.ignition,
          source: pos.source,
          updated_at: pos.updated_at,
        })
        .eq("id", 1);
    }
  } catch {
    // non-fatal
  }

  // Fire-and-forget: append to vehicle_positions timeseries when we got a real
  // Bouncie sample. Also auto-advance trip status if the van crossed a
  // geofence (100m around pickup or dropoff) OR clearly DEPARTED a geofenced
  // point (>400m away, speed > 5 mph). Departure detection lets us walk a
  // trip through its whole state machine — dispatch → at_pickup → onboard →
  // at_stop_N → onboard → at_dropoff → complete — purely from location
  // changes, without any input from Mark, Dio, or the passenger.
  interface TripStop {
    id: string;
    kind: "pickup" | "dropoff" | "stop";
    address: string;
    lat: number | null;
    lng: number | null;
    arrived_at?: string | null;
  }
  const DEPART_M = 400;
  const DEPART_MPH = 5;

  if (pos.source === "bouncie") {
    let activeTrip: {
      id: string;
      status: string;
      pickup_address: string | null;
      pickup_lat: number | null;
      pickup_lng: number | null;
      dropoff_lat: number | null;
      dropoff_lng: number | null;
      arrived_at_pickup_at: string | null;
      stops: TripStop[] | null;
    } | null = null;
    try {
      // Includes `scheduled` so "Take me home" / Quick-Dispatch trips that
      // never explicitly transitioned through dispatch can still get
      // auto-advanced by movement.
      const { data } = await supabaseAdmin()
        .from("trips")
        .select("id,status,pickup_address,pickup_lat,pickup_lng,dropoff_lat,dropoff_lng,arrived_at_pickup_at,stops")
        .in("status", ["scheduled", "dispatched", "at_pickup", "onboard", "at_dropoff"])
        .order("scheduled_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      activeTrip = data ?? null;
    } catch {
      // ignore
    }
    // No vehicle_positions write here — the Bouncie webhook already
    // captured this sample when the dongle reported it. Writing again on
    // every client poll would duplicate every Bouncie sample 5-10× and
    // bloat the timeseries with no information gain.

    // Auto-advance based on geofence (best-effort, don't block response)
    if (activeTrip) {
      const speed = pos.speed_mph ?? 0;
      void (async () => {
        try {
          const sb = supabaseAdmin();
          const t = activeTrip!;
          const now = new Date().toISOString();

          // Universal-Pickup model: pickups are stops[]. "Pickup" = the
          // first not-yet-arrived stop. Legacy trips with only
          // trip.pickup_* fall back to those for compat.
          const stopsArrRaw: Array<{
            id: string;
            lat: number | null;
            lng: number | null;
            address?: string;
            arrived_at?: string | null;
          }> = Array.isArray(t.stops) ? t.stops : [];
          const hasAnyStop = stopsArrRaw.some((s) => s.lat != null && s.lng != null);

          // STOP ARRIVAL — Mark's spec: "as soon as sprinter comes
          // within 30m of it, that stop is gone." Purely proximity-
          // based, runs EVERY tick regardless of trip status. This is
          // the canonical "the van reached this place" signal used
          // app-wide: ETA strips arrived stops from `upcoming`,
          // map pins filter them out, the trip card no longer shows
          // them. Decoupled from the status state machine so a stuck
          // status (e.g. dispatched never fired because Dio's app
          // wasn't polling while accelerating) doesn't keep a pickup
          // visible after the van clearly arrived.
          let stopsArr = stopsArrRaw.slice();
          let pickupJustArrived = false;
          {
            let dirty = false;
            for (let i = 0; i < stopsArr.length; i++) {
              const s = stopsArr[i];
              if (
                !s.arrived_at &&
                s.lat != null &&
                s.lng != null &&
                haversineM(pos.lat, pos.lng, s.lat as number, s.lng as number) < ARRIVE_M
              ) {
                stopsArr[i] = { ...s, arrived_at: now };
                dirty = true;
                // The FIRST pending stop crossing the 30m gate = pickup
                // moment. Used below to short-circuit status forward
                // to onboard without waiting for the legacy 100m → 30m
                // two-step.
                if (i === stopsArrRaw.findIndex((x) => !x.arrived_at && x.lat != null && x.lng != null)) {
                  pickupJustArrived = true;
                }
                logTripEvent({
                  trip_id: t.id,
                  kind: "auto_at_stop",
                  payload: { stop_id: s.id, address: s.address, reason: "30m proximity" },
                });
              }
            }
            if (dirty) {
              await sb.from("trips").update({ stops: stopsArr }).eq("id", t.id);
            }
          }

          // Legacy pickup arrival: trip.pickup_lat with no stops[].
          // Stamp trip.arrived_at_pickup_at on 30m proximity.
          const legacyPickupReached =
            !hasAnyStop &&
            !t.arrived_at_pickup_at &&
            t.pickup_lat != null &&
            t.pickup_lng != null &&
            haversineM(pos.lat, pos.lng, t.pickup_lat, t.pickup_lng) < ARRIVE_M;
          if (legacyPickupReached) {
            await sb
              .from("trips")
              .update({ arrived_at_pickup_at: now })
              .eq("id", t.id)
              .is("arrived_at_pickup_at", null);
          }

          const firstPendingStop = stopsArr.find(
            (s) => !s.arrived_at && s.lat != null && s.lng != null,
          );
          const legacyPickup =
            !hasAnyStop && t.pickup_lat != null && t.pickup_lng != null
              ? { lat: t.pickup_lat, lng: t.pickup_lng }
              : null;
          const nextPickup = firstPendingStop
            ? { lat: firstPendingStop.lat as number, lng: firstPendingStop.lng as number }
            : legacyPickup;

          // scheduled → dispatched when the van is moving.
          if (t.status === "scheduled" && speed > DEPART_MPH) {
            await sb
              .from("trips")
              .update({ status: "dispatched", dispatched_at: now })
              .eq("id", t.id)
              .eq("status", "scheduled");
            logTripEvent({ trip_id: t.id, kind: "auto_dispatched", payload: { reason: "speed>" + DEPART_MPH } });
          }

          // dispatched → at_pickup when within 100m of the next
          // pickup point. (Brief intermediate state — usually we'll
          // flip past at_pickup straight to onboard via the
          // pickupJustArrived signal below.)
          if (
            t.status === "dispatched" &&
            nextPickup &&
            haversineM(pos.lat, pos.lng, nextPickup.lat, nextPickup.lng) < GEOFENCE_M
          ) {
            await sb
              .from("trips")
              .update({ status: "at_pickup", arrived_at_pickup_at: now })
              .eq("id", t.id)
              .eq("status", "dispatched");
            logTripEvent({ trip_id: t.id, kind: "auto_at_pickup", payload: { reason: "geofence" } });
          }

          // PICKUP→ONBOARD short-circuit. Triggered the moment a
          // pending pickup stop OR the legacy pickup crossed the 30m
          // gate. Skips the at_pickup intermediate so Mark's app /
          // Dio's app immediately reflect "moving on to dropoff."
          if (
            (pickupJustArrived || legacyPickupReached) &&
            (t.status === "scheduled" ||
              t.status === "dispatched" ||
              t.status === "at_pickup")
          ) {
            const updates: Record<string, string> = { status: "onboard", onboard_at: now };
            if (!t.arrived_at_pickup_at) updates.arrived_at_pickup_at = now;
            await sb.from("trips").update(updates).eq("id", t.id);
            logTripEvent({
              trip_id: t.id,
              kind: "auto_onboard",
              payload: { reason: "pickup arrived (30m)" },
            });
            t.status = "onboard"; // local mirror so later rules see the new state
          }

          // Anchor for the tunnel-fallback rule. Prefers trip.pickup_lat
          // (always set on dispatch-created trips), falls back to the
          // most-recently arrived stop.
          const arrivedStops = stopsArr
            .filter((s) => s.arrived_at && s.lat != null && s.lng != null)
            .sort(
              (a, b) =>
                new Date(b.arrived_at as string).getTime() -
                new Date(a.arrived_at as string).getTime(),
            );
          const pickupAnchor: { lat: number; lng: number } | null =
            t.pickup_lat != null && t.pickup_lng != null
              ? { lat: t.pickup_lat, lng: t.pickup_lng }
              : arrivedStops.length > 0
                ? {
                    lat: arrivedStops[0].lat as number,
                    lng: arrivedStops[0].lng as number,
                  }
                : null;

          // FALLBACK: van clearly drove away from the pickup point
          // (>400m and >5mph). Catches edge cases where the 30m gate
          // somehow missed (e.g. GPS jump from a tunnel skipped the
          // at_pickup→onboard transition window).
          if (
            t.status === "at_pickup" &&
            pickupAnchor &&
            speed > DEPART_MPH &&
            haversineM(pos.lat, pos.lng, pickupAnchor.lat, pickupAnchor.lng) > DEPART_M
          ) {
            await sb
              .from("trips")
              .update({ status: "onboard", onboard_at: now })
              .eq("id", t.id)
              .eq("status", "at_pickup");
            logTripEvent({
              trip_id: t.id,
              kind: "auto_onboard",
              payload: { reason: "departed pickup (>400m + >5mph)" },
            });
          }

          // DROPOFF ARRIVAL — Mark's spec, same shape as the pickup
          // rule: van within 30m of the dropoff = trip is done.
          // Skip the at_dropoff intermediate entirely so Mark's app
          // returns to its no-trip baseline (Pickup button, no
          // destination card) the moment he's actually been dropped
          // off. Stamps both arrived_at_dropoff_at and completed_at
          // in one update.
          if (
            (t.status === "onboard" || t.status === "at_dropoff") &&
            t.dropoff_lat != null &&
            t.dropoff_lng != null &&
            haversineM(pos.lat, pos.lng, t.dropoff_lat, t.dropoff_lng) < ARRIVE_M
          ) {
            await sb
              .from("trips")
              .update({
                status: "complete",
                arrived_at_dropoff_at: now,
                completed_at: now,
              })
              .eq("id", t.id)
              .in("status", ["onboard", "at_dropoff"]);
            logTripEvent({
              trip_id: t.id,
              kind: "auto_complete",
              payload: { reason: "within 30m of dropoff" },
            });
            t.status = "complete";
          }

          // FALLBACK: van clearly drove away from the dropoff
          // (>400m + >5mph). Same tunnel-jump guard as the pickup
          // fallback — kicks the trip from at_dropoff to complete
          // if it somehow skipped the 30m window.
          if (
            t.status === "at_dropoff" &&
            t.dropoff_lat != null &&
            t.dropoff_lng != null &&
            speed > DEPART_MPH &&
            haversineM(pos.lat, pos.lng, t.dropoff_lat, t.dropoff_lng) > DEPART_M
          ) {
            await sb
              .from("trips")
              .update({ status: "complete", completed_at: now })
              .eq("id", t.id)
              .eq("status", "at_dropoff");
            logTripEvent({
              trip_id: t.id,
              kind: "auto_complete",
              payload: { reason: "departed dropoff (>400m + >5mph)" },
            });
          }

          // scheduled → onboard for "current-location" pickups where the van
          // has clearly left pickup behind (>400m, moving). These are
          // "Take me home" / Quick-Dispatch trips that never go through the
          // explicit dispatch→at_pickup→onboard flow because Mark is already
          // in the van. Without this they stay `scheduled` forever and the
          // ETA route doubles back to the recorded pickup point.
          if (
            (t.status === "scheduled" || t.status === "dispatched") &&
            t.pickup_address &&
            /current\s+location|my\s+location|mark.?s\s+location/i.test(t.pickup_address) &&
            t.pickup_lat != null &&
            t.pickup_lng != null &&
            speed > DEPART_MPH &&
            haversineM(pos.lat, pos.lng, t.pickup_lat, t.pickup_lng) > DEPART_M
          ) {
            await sb
              .from("trips")
              .update({
                status: "onboard",
                dispatched_at: now,
                arrived_at_pickup_at: now,
                onboard_at: now,
              })
              .eq("id", t.id)
              .in("status", ["scheduled", "dispatched"]);
            logTripEvent({ trip_id: t.id, kind: "auto_onboard", payload: { reason: "left current-location pickup" } });
          }
        } catch {
          // non-fatal
        }
      })();
    }
  }

  return NextResponse.json(pos);
}
