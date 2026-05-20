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
// Mark's spec:
//   "as soon as sprinter comes within 30m of a stop, that stop is gone
//    app-wide — same for pickup and dropoff."
//
// Stops-only model (2026-05-20):
//   trip.stops[] is the SINGLE source of truth for the destination chain.
//   stops[0]                = pickup
//   stops[stops.length - 1] = final destination (was: trip.dropoff_*)
//   middle                  = intermediate stops
//
// Implementation: 30m proximity check on each pending stop. First-stop
// arrival → onboard; last-stop arrival → complete. The legacy 100m
// at_pickup geofence and the >400m + >5mph departure detection are kept
// as fallbacks for tunnel-jump / GPS-skip edge cases.

export const ARRIVE_M = 30;
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
      .select("id,status,stops")
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

  // STOP ARRIVAL — min distance across the batch. Mark's spec: 30m =
  // arrived, app-wide. Runs first and independent of trip status so a
  // stuck status can't keep a stop visible after the van clearly passed.
  const stopsArr = stopsArrRaw.slice();
  let pickupJustArrived = false;
  let finalJustArrived = false;
  let stopsDirty = false;
  const lastIdx = stopsArr.length - 1;
  const firstPendingIdxBefore = stopsArrRaw.findIndex(
    (x) => !x.arrived_at && x.lat != null && x.lng != null,
  );
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
      if (i === firstPendingIdxBefore) pickupJustArrived = true;
      if (i === lastIdx) finalJustArrived = true;
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

  // PICKUP → ONBOARD short-circuit. The moment the FIRST pending stop
  // (which is the pickup) crossed the 30m gate, jump straight to onboard.
  // Skips at_pickup intermediate; Mark wants the pickup invisible the
  // instant the van reaches him.
  if (
    pickupJustArrived &&
    (t.status === "scheduled" ||
      t.status === "dispatched" ||
      t.status === "at_pickup")
  ) {
    await sb
      .from("trips")
      .update({ status: "onboard", onboard_at: now })
      .eq("id", t.id);
    logTripEvent({
      trip_id: t.id,
      kind: "auto_onboard",
      payload: { reason: "pickup arrived (30m proximity)" },
    });
    t.status = "onboard";
  }

  // FINAL DESTINATION → COMPLETE. The last stop in stops[] is the trip's
  // ultimate destination (the "dropoff" in the old model). When it arrives
  // AND every other stop has also arrived (defensive — handles the edge
  // case where the van geofences the final stop before circling back to a
  // skipped intermediate), the trip is complete.
  if (
    (t.status === "onboard" || t.status === "at_dropoff") &&
    finalJustArrived &&
    stopsArr.every((s) => s.arrived_at != null || s.lat == null)
  ) {
    await sb
      .from("trips")
      .update({
        status: "complete",
        completed_at: now,
      })
      .eq("id", t.id)
      .in("status", ["onboard", "at_dropoff"]);
    logTripEvent({
      trip_id: t.id,
      kind: "auto_complete",
      payload: { reason: "final destination arrived (30m proximity)" },
    });
    t.status = "complete";
    return; // trip's done, no further transitions
  }

  // 100m at_pickup intermediate — UX-only, lets Dio's app show
  // "Picking up..." briefly. Only fires if the 30m rule didn't already
  // jump us to onboard above. Anchored on the first pending stop.
  if (t.status === "dispatched") {
    const firstPending = stopsArr.find(
      (s) => !s.arrived_at && s.lat != null && s.lng != null,
    );
    if (
      firstPending &&
      haversineM(
        latest.lat,
        latest.lng,
        firstPending.lat as number,
        firstPending.lng as number,
      ) < GEOFENCE_M
    ) {
      // Note: arrived_at_pickup_at column dropped in 2026-05-20 schema
      // migration. The "when did we arrive at pickup" timestamp now lives
      // on stops[0].arrived_at (set when the 30m gate is crossed). The
      // at_pickup status itself is the 100m-window signal; no extra
      // timestamp needed.
      await sb
        .from("trips")
        .update({ status: "at_pickup" })
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
  // away). Anchored on the most recently arrived stop OR the first stop
  // overall if nothing arrived yet (truly stuck — shouldn't happen).
  if (t.status === "at_pickup") {
    const arrivedStopsByTime = stopsArr
      .filter((s) => s.arrived_at && s.lat != null && s.lng != null)
      .sort(
        (a, b) =>
          new Date(b.arrived_at as string).getTime() -
          new Date(a.arrived_at as string).getTime(),
      );
    const pickupAnchor =
      arrivedStopsByTime.length > 0
        ? {
            lat: arrivedStopsByTime[0].lat as number,
            lng: arrivedStopsByTime[0].lng as number,
          }
        : stopsArr[0]?.lat != null && stopsArr[0]?.lng != null
          ? { lat: stopsArr[0].lat as number, lng: stopsArr[0].lng as number }
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
  // fallback above, anchored on the final stop (which is the trip's
  // ultimate destination).
  if (t.status === "at_dropoff") {
    const finalStop = stopsArr[stopsArr.length - 1];
    if (
      finalStop?.lat != null &&
      finalStop?.lng != null &&
      speed > DEPART_MPH &&
      haversineM(
        latest.lat,
        latest.lng,
        finalStop.lat as number,
        finalStop.lng as number,
      ) > DEPART_M
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
