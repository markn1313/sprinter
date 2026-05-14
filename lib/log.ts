import { supabaseAdmin } from "@/lib/supabase";

// Fire-and-forget loggers. They write to the timeseries / audit tables when
// they exist, swallow errors otherwise. No awaiting in callers — these run in
// the background of the request and shouldn't add latency.

interface VehiclePositionRow {
  trip_id?: string | null;
  source: "bouncie" | "driver_phone" | "mark_phone";
  lat?: number | null;
  lng?: number | null;
  heading?: number | null;
  speed_mph?: number | null;
  fuel_pct?: number | null;
  ignition?: boolean | null;
  battery_v?: number | null;
  mileage?: number | null;
}

// Throttling thresholds — a new sample is only written when it
// meaningfully differs from the previous sample FROM THE SAME SOURCE.
// At normal driving speeds (40 mph ≈ 18 m/s) the 5-m threshold means
// roughly one row every 0.3 s of motion is admitted, which the 3-s gap
// floor then collapses to ~one every 3 s. Fuel + speed thresholds catch
// stationary state changes (idling at a light, fueling up).
const MIN_MOVE_M = 5;
const MIN_SPEED_DELTA_MPH = 1;
const MIN_FUEL_DELTA = 0.005;
const MIN_GAP_S = 3;

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Resolves the trip the van is on RIGHT NOW. Each vehicle_positions row
// gets tagged so per-trip reconstruction queries can filter by trip_id
// instead of by time-window guessing.
async function activeTripId(): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin()
      .from("trips")
      .select("id")
      .in("status", ["scheduled", "dispatched", "at_pickup", "onboard", "at_dropoff"])
      .order("scheduled_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data?.id as string | null) ?? null;
  } catch {
    return null;
  }
}

// Returns true when the row is "worth" storing — first sample for the
// source, or meaningfully different from the last one. Read-only DB
// lookup (one indexed row).
async function shouldKeepSample(row: VehiclePositionRow): Promise<boolean> {
  if (row.lat == null || row.lng == null) return true;
  try {
    const { data } = await supabaseAdmin()
      .from("vehicle_positions")
      .select("lat,lng,speed_mph,fuel_pct,recorded_at")
      .eq("source", row.source)
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data || data.lat == null || data.lng == null) return true;
    const ageMs = Date.now() - new Date(data.recorded_at as string).getTime();
    // Time-gap floor: 3s during active state, 5min when the van is
    // parked + ignition-off (else parked heartbeats every few seconds
    // accumulate 1000+ rows/hour for zero information value).
    const parkedAndOff = row.ignition === false && (row.speed_mph ?? 0) < 1;
    const timeFloorMs = parkedAndOff ? 5 * 60_000 : MIN_GAP_S * 1000;
    if (ageMs >= timeFloorMs) return true;
    const movedM = haversineM(row.lat, row.lng, data.lat as number, data.lng as number);
    if (movedM >= MIN_MOVE_M) return true;
    const dSpeed = Math.abs((row.speed_mph ?? 0) - ((data.speed_mph as number | null) ?? 0));
    if (dSpeed >= MIN_SPEED_DELTA_MPH) return true;
    const dFuel = Math.abs((row.fuel_pct ?? 0) - ((data.fuel_pct as number | null) ?? 0));
    if (dFuel >= MIN_FUEL_DELTA) return true;
    return false;
  } catch {
    // If we can't query, default to insert — better a duplicate than a gap.
    return true;
  }
}

export function logVehiclePosition(row: VehiclePositionRow): void {
  // Don't await — let it complete after the response. Errors swallowed
  // because missing tables / transient failures shouldn't break the live
  // request. Pipeline: trip-id lookup + throttle check + insert.
  void Promise.resolve().then(async () => {
    try {
      if (!(await shouldKeepSample(row))) return;
      const tripId = row.trip_id ?? (await activeTripId());
      await supabaseAdmin().from("vehicle_positions").insert({ ...row, trip_id: tripId });
    } catch {
      // ignore
    }
  });
}

interface TripEventRow {
  trip_id: string;
  kind: string;
  actor_token?: string | null;
  payload?: Record<string, unknown>;
}

export function logTripEvent(row: TripEventRow): void {
  try {
    void Promise.resolve(
      supabaseAdmin().from("trip_events").insert({
        trip_id: row.trip_id,
        kind: row.kind,
        actor_token: row.actor_token ?? null,
        payload: row.payload ?? null,
      }),
    ).then(
      () => {},
      () => {},
    );
  } catch {
    // ignore
  }
}

interface PassengerPrefsRow {
  token: string;
  display_name?: string;
  preferred_temp_f?: number;
  preferred_fan?: number;
  music_pref?: string;
  notes?: string;
}

export function upsertPassengerPrefs(row: PassengerPrefsRow): void {
  try {
    void Promise.resolve(
      supabaseAdmin()
        .from("passenger_prefs")
        .upsert(
          { ...row, updated_at: new Date().toISOString() },
          { onConflict: "token" },
        ),
    ).then(
      () => {},
      () => {},
    );
  } catch {
    // ignore
  }
}
