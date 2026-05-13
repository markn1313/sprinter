import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";
import { getVanPosition } from "@/lib/bouncie";
import { supabaseAdmin } from "@/lib/supabase";
import { logVehiclePosition, logTripEvent } from "@/lib/log";
import { deriveHeading } from "@/lib/bearing";
import { fuseFromPhone } from "@/lib/fuse-position";

export const dynamic = "force-dynamic";

// 100m geofence — when the van enters this radius around a pickup or dropoff
// point AND the trip is in the right state, we advance status automatically.
// Saves Dio (and Mark) from tapping when his app is frozen or he's busy.
const GEOFENCE_M = 100;

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
      stops: TripStop[] | null;
    } | null = null;
    try {
      // Includes `scheduled` so "Take me home" / Quick-Dispatch trips that
      // never explicitly transitioned through dispatch can still get
      // auto-advanced by movement.
      const { data } = await supabaseAdmin()
        .from("trips")
        .select("id,status,pickup_address,pickup_lat,pickup_lng,dropoff_lat,dropoff_lng,stops")
        .in("status", ["scheduled", "dispatched", "at_pickup", "onboard", "at_dropoff"])
        .order("scheduled_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      activeTrip = data ?? null;
    } catch {
      // ignore
    }
    logVehiclePosition({
      source: "bouncie",
      lat: pos.lat,
      lng: pos.lng,
      heading: pos.heading,
      speed_mph: pos.speed_mph,
      fuel_pct: pos.fuel_pct,
      ignition: pos.ignition,
      mileage: pos.mileage,
      trip_id: activeTrip?.id,
    });

    // Auto-advance based on geofence (best-effort, don't block response)
    if (activeTrip) {
      const speed = pos.speed_mph ?? 0;
      void (async () => {
        try {
          const sb = supabaseAdmin();
          const t = activeTrip!;
          const now = new Date().toISOString();

          // scheduled → dispatched when the van is moving. Driver took the
          // wheel and started toward pickup without tapping anything.
          if (t.status === "scheduled" && speed > DEPART_MPH) {
            await sb
              .from("trips")
              .update({ status: "dispatched", dispatched_at: now })
              .eq("id", t.id)
              .eq("status", "scheduled");
            logTripEvent({ trip_id: t.id, kind: "auto_dispatched", payload: { reason: "speed>" + DEPART_MPH } });
          }

          // dispatched → at_pickup when within 100m of pickup
          if (
            t.status === "dispatched" &&
            t.pickup_lat != null &&
            t.pickup_lng != null &&
            haversineM(pos.lat, pos.lng, t.pickup_lat, t.pickup_lng) < GEOFENCE_M
          ) {
            await sb
              .from("trips")
              .update({ status: "at_pickup", arrived_at_pickup_at: now })
              .eq("id", t.id)
              .eq("status", "dispatched");
            logTripEvent({ trip_id: t.id, kind: "auto_at_pickup", payload: { reason: "geofence" } });
          }

          // at_pickup → onboard once the van moves away from pickup with
          // speed (departure detection — passenger is in the van, driver
          // pulled out).
          if (
            t.status === "at_pickup" &&
            t.pickup_lat != null &&
            t.pickup_lng != null &&
            speed > DEPART_MPH &&
            haversineM(pos.lat, pos.lng, t.pickup_lat, t.pickup_lng) > DEPART_M
          ) {
            await sb
              .from("trips")
              .update({ status: "onboard", onboard_at: now })
              .eq("id", t.id)
              .eq("status", "at_pickup");
            logTripEvent({ trip_id: t.id, kind: "auto_onboard", payload: { reason: "departed pickup" } });
          }

          // Multi-stop: while onboard, mark intermediate stops as arrived
          // when the van enters the 100m geofence. Stops are stored as a
          // JSON array on the trip row; we mutate in place and PATCH the
          // whole array back.
          if (t.status === "onboard" && Array.isArray(t.stops) && t.stops.length > 0) {
            const stops = t.stops;
            let dirty = false;
            for (const s of stops) {
              if (
                s.kind === "stop" &&
                !s.arrived_at &&
                s.lat != null &&
                s.lng != null &&
                haversineM(pos.lat, pos.lng, s.lat, s.lng) < GEOFENCE_M
              ) {
                s.arrived_at = now;
                dirty = true;
                logTripEvent({ trip_id: t.id, kind: "auto_at_stop", payload: { stop_id: s.id, address: s.address } });
              }
            }
            if (dirty) {
              await sb.from("trips").update({ stops }).eq("id", t.id);
            }
          }

          // onboard → at_dropoff when within 100m of dropoff
          if (
            t.status === "onboard" &&
            t.dropoff_lat != null &&
            t.dropoff_lng != null &&
            haversineM(pos.lat, pos.lng, t.dropoff_lat, t.dropoff_lng) < GEOFENCE_M
          ) {
            await sb
              .from("trips")
              .update({ status: "at_dropoff", arrived_at_dropoff_at: now })
              .eq("id", t.id)
              .eq("status", "onboard");
            logTripEvent({ trip_id: t.id, kind: "auto_at_dropoff", payload: { reason: "geofence" } });
          }

          // at_dropoff → complete once the van moves away from dropoff
          // with speed (departure detection — passenger off-loaded, van
          // is heading somewhere else). Skipping the explicit "complete"
          // tap means the trip-history view and recap card update on
          // their own.
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
            logTripEvent({ trip_id: t.id, kind: "auto_complete", payload: { reason: "departed dropoff" } });
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
