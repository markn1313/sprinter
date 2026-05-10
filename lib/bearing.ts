import { supabaseAdmin } from "./supabase";

// Server-side bearing derivation from the vehicle_positions timeseries.
//
// Bouncie's heading field is reported as 0 on Mark's tier, so the TV/Mark
// apps compute bearing client-side from successive lng/lat samples. That
// approach has issues:
//   - Single 6-second poll diff is very noisy (GPS jitter ≈ 5–10m).
//   - Each client computes its own bearing, so apps can disagree.
//   - When the van moves slowly (parking lot), the per-poll movement is
//     below the noise threshold and the icon freezes pointing the wrong way.
//
// Doing it on the server using the FULL recent history fixes all three:
//   - We can pick a reference sample that's BASELINE_M meters back,
//     filtering out GPS noise.
//   - Every client sees the same bearing.
//   - Idle samples (speed ≤ 1mph) are excluded so the bearing reflects
//     actual driving direction, not standstill jitter.

const BASELINE_M = 50; // Min distance between current and reference sample
const LOOKBACK_S = 90; // Don't go further back than 90 seconds

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(fromLat: number, fromLng: number, toLat: number, toLng: number): number {
  const φ1 = (fromLat * Math.PI) / 180;
  const φ2 = (toLat * Math.PI) / 180;
  const Δλ = ((toLng - fromLng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  let θ = (Math.atan2(y, x) * 180) / Math.PI;
  if (θ < 0) θ += 360;
  return θ;
}

export async function deriveHeading(currentLat: number, currentLng: number): Promise<number | null> {
  try {
    const since = new Date(Date.now() - LOOKBACK_S * 1000).toISOString();
    const { data } = await supabaseAdmin()
      .from("vehicle_positions")
      .select("lat,lng,recorded_at,speed_mph")
      .eq("source", "bouncie")
      .gte("recorded_at", since)
      .gt("speed_mph", 1)
      .order("recorded_at", { ascending: false })
      .limit(30);
    const rows = (data ?? []) as Array<{ lat: number | null; lng: number | null; recorded_at: string; speed_mph: number | null }>;
    if (rows.length === 0) return null;

    // Walk back from most-recent looking for the first sample that's
    // BASELINE_M meters away from current. That gives a stable bearing
    // regardless of GPS noise on the most recent poll.
    for (const r of rows) {
      if (r.lat == null || r.lng == null) continue;
      const dist = haversineM(currentLat, currentLng, r.lat, r.lng);
      if (dist >= BASELINE_M) {
        return bearingDeg(r.lat, r.lng, currentLat, currentLng);
      }
    }
    return null;
  } catch {
    return null;
  }
}
