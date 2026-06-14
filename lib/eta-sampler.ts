import { supabaseAdmin } from "./supabase";
import { CONGESTION_TIME_FACTOR } from "./routing";

// ETA calibration sampler. Records Mapbox's RAW (unpadded) driving-traffic
// prediction from the van's current position to the dropoff (through any
// pending stops) into eta_samples, at the cadence the Bouncie webhook fires,
// throttled per trip. Comparing these predictions to the trip's actual
// completion time later yields the true Sprinter slowdown factor, so we can
// calibrate SPRINTER_TIME_FACTOR off real data instead of a guess.
//
// Deliberately best-effort and isolated: any failure (no Mapbox token, API
// error, no active trip) is swallowed by the caller so calibration sampling
// can never affect position ingestion or the state machine.

// At most one Mapbox sample per trip per this many seconds (cost / rate-limit
// guard). The webhook may fire more often than this; the throttle dedupes.
const SAMPLE_THROTTLE_S = 30;

interface Latest {
  lat: number;
  lng: number;
  speed_mph?: number | null;
}
interface Stop {
  lat?: number | null;
  lng?: number | null;
  arrived_at?: string | null;
}

export async function sampleTripEta(latest: Latest): Promise<void> {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) return;
  const sb = supabaseAdmin();

  // The active in-motion trip with a known dropoff. Scheduled trips aren't
  // moving yet; complete/cancelled aren't relevant.
  const { data: trip } = await sb
    .from("trips")
    .select("id,status,dropoff_lat,dropoff_lng,stops")
    .in("status", ["dispatched", "at_pickup", "onboard", "at_dropoff"])
    .order("scheduled_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!trip || trip.dropoff_lat == null || trip.dropoff_lng == null) return;

  // Throttle: skip if we already sampled this trip within SAMPLE_THROTTLE_S.
  const { data: last } = await sb
    .from("eta_samples")
    .select("recorded_at")
    .eq("trip_id", trip.id)
    .order("recorded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (last?.recorded_at) {
    const ageS = (Date.now() - new Date(last.recorded_at).getTime()) / 1000;
    if (ageS < SAMPLE_THROTTLE_S) return;
  }

  // Route: van -> each pending stop (in array/visit order) -> dropoff. Mirrors
  // what the app's own ETA routes through, so the prediction is apples-to-apples.
  const pending = (Array.isArray(trip.stops) ? trip.stops : []).filter(
    (s: Stop) => !s.arrived_at && s.lat != null && s.lng != null,
  ) as Stop[];
  const coords = [
    [latest.lng, latest.lat],
    ...pending.map((s) => [s.lng as number, s.lat as number]),
    [trip.dropoff_lng as number, trip.dropoff_lat as number],
  ]
    .map((c) => `${c[0]},${c[1]}`)
    .join(";");

  // overview=full + per-segment annotations so we get the congestion class,
  // duration, and distance of every segment of the remaining route — the raw
  // material for a per-congestion-class slowdown factor (jam ≈ 1.0, free-flow
  // larger because the van does ~60 where Mapbox assumes ~75).
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coords}` +
    `?access_token=${token}&overview=full&geometries=polyline6` +
    `&annotations=congestion,duration,distance`;

  const referer = process.env.MAPBOX_REFERER ?? "https://sprinter-tau.vercel.app/";
  const res = await fetch(url, { headers: { Referer: referer } });
  if (!res.ok) return;
  const j = (await res.json()) as {
    routes?: Array<{
      duration: number;
      distance: number;
      legs?: Array<{
        duration: number;
        distance: number;
        annotation?: {
          congestion?: string[];
          duration?: number[];
          distance?: number[];
        };
      }>;
    }>;
  };
  const r = j.routes?.[0];
  if (!r) return;

  const rawToDest = Math.round(r.duration);
  const leg0 = r.legs?.[0];

  // Bucket every segment of every remaining leg by its congestion class,
  // summing predicted duration + distance. Per class, dur_s/dist_m is the speed
  // Mapbox assumes there — what we calibrate the van's real speed against.
  const CLASSES = ["low", "moderate", "heavy", "severe", "unknown"] as const;
  const breakdown: Record<string, { dist_m: number; dur_s: number; segments: number }> =
    Object.fromEntries(CLASSES.map((c) => [c, { dist_m: 0, dur_s: 0, segments: 0 }]));
  for (const leg of r.legs ?? []) {
    const cong = leg.annotation?.congestion ?? [];
    const durs = leg.annotation?.duration ?? [];
    const dists = leg.annotation?.distance ?? [];
    for (let i = 0; i < cong.length; i++) {
      const cls = (CLASSES as readonly string[]).includes(cong[i]) ? cong[i] : "unknown";
      const b = breakdown[cls];
      b.dur_s += durs[i] ?? 0;
      b.dist_m += dists[i] ?? 0;
      b.segments += 1;
    }
  }
  // Round for storage; drop empty classes to keep the JSON tight.
  const congestionBreakdown: Record<string, { dist_m: number; dur_s: number; segments: number }> = {};
  for (const c of CLASSES) {
    if (breakdown[c].segments > 0) {
      congestionBreakdown[c] = {
        dist_m: Math.round(breakdown[c].dist_m),
        dur_s: Math.round(breakdown[c].dur_s),
        segments: breakdown[c].segments,
      };
    }
  }

  // Segmented padded duration — the SAME per-congestion factors the live ETA
  // now applies. padded_duration_s reflects what the app would have shown;
  // time_factor is the effective blended factor for this route's mix.
  let paddedSeg = 0;
  for (const c of CLASSES) paddedSeg += breakdown[c].dur_s * (CONGESTION_TIME_FACTOR[c] ?? 1.15);
  const paddedDurationS = Math.round(paddedSeg);
  const effectiveFactor = rawToDest > 0 ? paddedDurationS / rawToDest : null;

  await sb.from("eta_samples").insert({
    trip_id: trip.id,
    van_lat: latest.lat,
    van_lng: latest.lng,
    speed_mph: latest.speed_mph ?? null,
    status: trip.status,
    n_pending_stops: pending.length,
    dest_lat: trip.dropoff_lat,
    dest_lng: trip.dropoff_lng,
    mapbox_distance_m: Math.round(r.distance),
    mapbox_raw_duration_s: rawToDest,
    padded_duration_s: paddedDurationS,
    time_factor: effectiveFactor,
    next_mapbox_distance_m: leg0 ? Math.round(leg0.distance) : null,
    next_mapbox_raw_duration_s: leg0 ? Math.round(leg0.duration) : null,
    congestion_breakdown: congestionBreakdown,
  });
}
