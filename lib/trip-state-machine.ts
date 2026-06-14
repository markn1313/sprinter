import { supabaseAdmin } from "./supabase";
import { logTripEvent } from "./log";

// Shared trip state machine. Single source of truth for every transition,
// callable from any endpoint that observes a fresh position:
//
//   - POST /api/bouncie/webhook         (Bouncie's server pushes a batch)
//   - GET  /api/position                (app poll, backup)
//   - POST /api/mark-location           (Mark's phone fix)        — optional
//   - POST /api/driver-location         (Dio's phone fix)         — optional
//
// Calling it from the Bouncie webhook is the critical improvement vs. the
// old design: it fires the moment the dongle reports, without needing any
// app to be open. The /api/position GET path remains as a backup for when
// Bouncie is offline (source=bouncie_cached). State updates are
// idempotent — every status flip is gated on the FROM status via
// .eq("status", "<from>"), so concurrent calls during a transition window
// no-op cleanly instead of double-firing.
//
// Mark's spec across the conversation:
//   "as soon as sprinter comes within 30m of a stop, that stop is gone
//    app-wide — same for pickup and dropoff."
//
// Implementation: the proximity check is the canonical arrival signal. It
// stamps arrived_at on the matching stop AND short-circuits status forward.
// The >400m + >5mph departure detection and the special-case current-location
// auto-onboard are kept only as fallbacks for tunnel-jump / GPS-skip edge
// cases.
//
// ARRIVE_M is 100m (per Mark): the van's OBD GPS carries real error and the
// dongle reports only every ~15–30s, so a tight radius made the van "miss"
// stops it actually reached. 100m = arrived applies uniformly to every
// pickup, every intermediate stop, and the final dropoff. Equal to GEOFENCE_M,
// so the arrival and the legacy geofence now fire together.
export const ARRIVE_M = 100;
const GEOFENCE_M = 100;
const DEPART_M = 400;
const DEPART_MPH = 5;

export interface PositionUpdate {
  lat: number;
  lng: number;
  speed_mph?: number | null;
}

interface TripStop {
  id: string;
  kind?: "pickup" | "dropoff" | "stop";
  address?: string;
  lat: number | null;
  lng: number | null;
  arrived_at?: string | null;
}

interface ActiveTrip {
  id: string;
  status: string;
  pickup_address: string | null;
  pickup_lat: number | null;
  pickup_lng: number | null;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  arrived_at_pickup_at: string | null;
  stops: TripStop[] | null;
}

function haversineM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function loadActiveTrip(): Promise<ActiveTrip | null> {
  try {
    const { data } = await supabaseAdmin()
      .from("trips")
      .select(
        "id,status,pickup_address,pickup_lat,pickup_lng,dropoff_lat,dropoff_lng,arrived_at_pickup_at,stops",
      )
      .in("status", [
        "scheduled",
        "dispatched",
        "at_pickup",
        "onboard",
        "at_dropoff",
      ])
      .order("scheduled_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data as ActiveTrip | null) ?? null;
  } catch {
    return null;
  }
}

// Run the state machine against a single position update.
export async function advanceTripState(pos: PositionUpdate): Promise<void> {
  return advanceTripStateForBatch([pos]);
}

// Run the state machine against a BATCH of samples (from the Bouncie
// webhook — typically 5-20 samples ~1s apart). Uses MIN distance to each
// pending waypoint across the whole batch so a brief sub-30m pass-through
// is caught even when the latest sample is already past the gate. Status
// transitions evaluate against the LAST sample (the current state).
export async function advanceTripStateForBatch(
  samples: PositionUpdate[],
): Promise<void> {
  if (samples.length === 0) return;
  const t = await loadActiveTrip();
  if (!t) return;

  const sb = supabaseAdmin();
  const now = new Date().toISOString();
  const latest = samples[samples.length - 1];
  const speed = latest.speed_mph ?? 0;

  const stopsArrRaw: TripStop[] = Array.isArray(t.stops) ? t.stops : [];
  const hasAnyStop = stopsArrRaw.some((s) => s.lat != null && s.lng != null);

  // STOP ARRIVAL — min distance across the batch. Mark's spec: within
  // ARRIVE_M (100m) = arrived, app-wide. Runs first and independent of trip status so a
  // stuck status can't keep a stop visible after the van clearly passed.
  const stopsArr = stopsArrRaw.slice();
  let pickupJustArrived = false;
  let stopsDirty = false;
  for (let i = 0; i < stopsArr.length; i++) {
    const s = stopsArr[i];
    if (s.arrived_at || s.lat == null || s.lng == null) continue;
    let minDist = Infinity;
    for (const p of samples) {
      const d = haversineM(p.lat, p.lng, s.lat as number, s.lng as number);
      if (d < minDist) minDist = d;
    }
    if (minDist < ARRIVE_M) {
      stopsArr[i] = { ...s, arrived_at: now };
      stopsDirty = true;
      const firstPendingIdx = stopsArrRaw.findIndex(
        (x) => !x.arrived_at && x.lat != null && x.lng != null,
      );
      if (i === firstPendingIdx) pickupJustArrived = true;
      logTripEvent({
        trip_id: t.id,
        kind: "auto_at_stop",
        payload: {
          stop_id: s.id,
          address: s.address,
          reason: `${ARRIVE_M}m proximity (min ${minDist.toFixed(0)}m)`,
        },
      });
    }
  }
  if (stopsDirty) {
    await sb.from("trips").update({ stops: stopsArr }).eq("id", t.id);
  }

  // Legacy pickup arrival — for trips that pre-date the stops[] model.
  let legacyPickupReached = false;
  if (
    !hasAnyStop &&
    !t.arrived_at_pickup_at &&
    t.pickup_lat != null &&
    t.pickup_lng != null
  ) {
    let minDist = Infinity;
    for (const p of samples) {
      const d = haversineM(p.lat, p.lng, t.pickup_lat, t.pickup_lng);
      if (d < minDist) minDist = d;
    }
    if (minDist < ARRIVE_M) {
      legacyPickupReached = true;
      await sb
        .from("trips")
        .update({ arrived_at_pickup_at: now })
        .eq("id", t.id)
        .is("arrived_at_pickup_at", null);
    }
  }

  // scheduled → dispatched on movement.
  if (t.status === "scheduled" && speed > DEPART_MPH) {
    await sb
      .from("trips")
      .update({ status: "dispatched", dispatched_at: now })
      .eq("id", t.id)
      .eq("status", "scheduled");
    logTripEvent({
      trip_id: t.id,
      kind: "auto_dispatched",
      payload: { reason: "speed>" + DEPART_MPH },
    });
    t.status = "dispatched";
  }

  // PICKUP → ONBOARD short-circuit. The moment ANY pending pickup stop
  // (or legacy pickup) crossed the 30m gate, jump straight to onboard.
  // Skips at_pickup intermediate; Mark wants the pickup invisible the
  // instant the van reaches him.
  if (
    (pickupJustArrived || legacyPickupReached) &&
    (t.status === "scheduled" ||
      t.status === "dispatched" ||
      t.status === "at_pickup")
  ) {
    const updates: Record<string, string> = {
      status: "onboard",
      onboard_at: now,
    };
    if (!t.arrived_at_pickup_at) updates.arrived_at_pickup_at = now;
    await sb.from("trips").update(updates).eq("id", t.id);
    logTripEvent({
      trip_id: t.id,
      kind: "auto_onboard",
      payload: { reason: `pickup arrived (${ARRIVE_M}m proximity)` },
    });
    t.status = "onboard";
  }

  // DROPOFF → COMPLETE. Same 30m rule for the dropoff. Skip at_dropoff
  // intermediate so Mark's app returns to the no-trip baseline the
  // moment he's actually dropped off.
  if (
    (t.status === "onboard" || t.status === "at_dropoff") &&
    t.dropoff_lat != null &&
    t.dropoff_lng != null
  ) {
    let minDist = Infinity;
    for (const p of samples) {
      const d = haversineM(p.lat, p.lng, t.dropoff_lat, t.dropoff_lng);
      if (d < minDist) minDist = d;
    }
    if (minDist < ARRIVE_M) {
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
        payload: {
          reason: `dropoff arrived (${ARRIVE_M}m proximity, min ${minDist.toFixed(0)}m)`,
        },
      });
      t.status = "complete";
      return; // trip's done, no further transitions
    }
  }

  // 100m at_pickup intermediate — UX-only, lets Dio's app show
  // "Picking up..." briefly. Only fires if the 30m rule didn't already
  // jump us to onboard above.
  if (t.status === "dispatched") {
    const firstPending = stopsArr.find(
      (s) => !s.arrived_at && s.lat != null && s.lng != null,
    );
    const nextPickup = firstPending
      ? { lat: firstPending.lat as number, lng: firstPending.lng as number }
      : !hasAnyStop && t.pickup_lat != null && t.pickup_lng != null
        ? { lat: t.pickup_lat, lng: t.pickup_lng }
        : null;
    if (
      nextPickup &&
      haversineM(latest.lat, latest.lng, nextPickup.lat, nextPickup.lng) <
        GEOFENCE_M
    ) {
      await sb
        .from("trips")
        .update({ status: "at_pickup", arrived_at_pickup_at: now })
        .eq("id", t.id)
        .eq("status", "dispatched");
      logTripEvent({
        trip_id: t.id,
        kind: "auto_at_pickup",
        payload: { reason: "100m geofence" },
      });
      t.status = "at_pickup";
    }
  }

  // Tunnel fallback (at_pickup → onboard): van departed pickup
  // >400m + >5mph. Catches GPS-jump scenarios where the 30m proximity
  // window was somehow skipped (in-tunnel sample loss + emerging far
  // away).
  if (t.status === "at_pickup") {
    const arrivedStopsByTime = stopsArr
      .filter((s) => s.arrived_at && s.lat != null && s.lng != null)
      .sort(
        (a, b) =>
          new Date(b.arrived_at as string).getTime() -
          new Date(a.arrived_at as string).getTime(),
      );
    const pickupAnchor =
      t.pickup_lat != null && t.pickup_lng != null
        ? { lat: t.pickup_lat, lng: t.pickup_lng }
        : arrivedStopsByTime.length > 0
          ? {
              lat: arrivedStopsByTime[0].lat as number,
              lng: arrivedStopsByTime[0].lng as number,
            }
          : null;
    if (
      pickupAnchor &&
      speed > DEPART_MPH &&
      haversineM(latest.lat, latest.lng, pickupAnchor.lat, pickupAnchor.lng) >
        DEPART_M
    ) {
      await sb
        .from("trips")
        .update({ status: "onboard", onboard_at: now })
        .eq("id", t.id)
        .eq("status", "at_pickup");
      logTripEvent({
        trip_id: t.id,
        kind: "auto_onboard",
        payload: { reason: "departed pickup (tunnel fallback)" },
      });
      t.status = "onboard";
    }
  }

  // Tunnel fallback (at_dropoff → complete): same shape as the pickup
  // fallback above.
  if (
    t.status === "at_dropoff" &&
    t.dropoff_lat != null &&
    t.dropoff_lng != null
  ) {
    if (
      speed > DEPART_MPH &&
      haversineM(latest.lat, latest.lng, t.dropoff_lat, t.dropoff_lng) >
        DEPART_M
    ) {
      await sb
        .from("trips")
        .update({ status: "complete", completed_at: now })
        .eq("id", t.id)
        .eq("status", "at_dropoff");
      logTripEvent({
        trip_id: t.id,
        kind: "auto_complete",
        payload: { reason: "departed dropoff (tunnel fallback)" },
      });
      t.status = "complete";
    }
  }
}
