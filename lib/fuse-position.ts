import { supabaseAdmin } from "./supabase";

// Bouncie's OBD dongle reports every ~15–30s on the consumer tier — at
// 55 mph that's a third of a mile of position lag. When Mark's phone is
// in the van and reporting fresh GPS via /api/mark-location (or Dio's via
// /api/driver-location), we have a far fresher position signal that we
// should prefer for lat/lng. Speed / fuel / odometer still come from
// Bouncie because those are vehicle-side data the phone can't supply.
//
// Gates (all required):
//   - Caller's Bouncie reading is LIVE, not bouncie_cached. Cached means
//     the dongle hasn't pinged recently; the proximity baseline is stale.
//   - Bouncie reports the van is actively moving (speed >= VAN_MIN_MPH).
//     This is the single most reliable "phone is in this van" signal we
//     have. A parked van has zero position lag to mitigate, and proximity
//     alone can't distinguish "phone in cabin" from "phone owner walked
//     into a neighboring shop." Skipping fusion when stopped is what
//     keeps the van icon planted at the real van when Mark steps out.
//   - Phone fix is < PHONE_FRESH_S old.
//   - Phone accuracy is < PHONE_ACC_MAX_M (filters out 2000 m bad fixes
//     we've seen indoors / behind glass).
//   - Phone is within PHONE_PROX_M of the Bouncie position. Tightened
//     from 200 m to 30 m — only a phone essentially inside the cabin
//     should ever pass this, even if the speed gate above is fuzzy.

const PHONE_FRESH_S = 10;
const PHONE_ACC_MAX_M = 100;
const PHONE_PROX_M = 30;
const VAN_MIN_MPH = 5;

interface PhoneFix {
  lat: number;
  lng: number;
  accuracy_m: number | null;
  reported_at: string;
}

interface BouncieRef {
  lat: number;
  lng: number;
  speed_mph?: number | null;
  source?: "bouncie" | "bouncie_cached" | "mock" | string;
}

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

async function loadFix(table: "mark_location" | "driver_location"): Promise<PhoneFix | null> {
  try {
    const { data } = await supabaseAdmin()
      .from(table)
      .select("lat,lng,accuracy_m,reported_at")
      .eq("id", 1)
      .maybeSingle();
    if (!data || data.lat == null || data.lng == null) return null;
    return data as PhoneFix;
  } catch {
    return null;
  }
}

export interface FusedFix {
  lat: number;
  lng: number;
  source: "phone-mark" | "phone-driver";
  accuracy_m: number | null;
  reported_at: string;
}

// Returns a fresher phone-based position when one passes all gates, else null.
// Caller decides what to do with it (typically: override Bouncie's lat/lng).
export async function fuseFromPhone(bouncie: BouncieRef): Promise<FusedFix | null> {
  // Top-of-function guards — short-circuit before any DB read so a stopped
  // van is never even a candidate for fusion. These are the most important
  // checks: they keep the van icon planted at the real van when Mark steps
  // out (proximity alone wasn't enough — a phone next door is still within
  // 200 m). See header comment for the full reasoning.
  if (bouncie.source && bouncie.source !== "bouncie") return null;
  if ((bouncie.speed_mph ?? 0) < VAN_MIN_MPH) return null;

  const [mark, driver] = await Promise.all([
    loadFix("mark_location"),
    loadFix("driver_location"),
  ]);
  const candidates: Array<{ fix: PhoneFix; source: FusedFix["source"] }> = [];
  if (mark) candidates.push({ fix: mark, source: "phone-mark" });
  if (driver) candidates.push({ fix: driver, source: "phone-driver" });

  let best: { fix: PhoneFix; source: FusedFix["source"]; ageS: number } | null = null;
  for (const c of candidates) {
    const ageS = (Date.now() - new Date(c.fix.reported_at).getTime()) / 1000;
    if (ageS > PHONE_FRESH_S) continue;
    if ((c.fix.accuracy_m ?? Infinity) > PHONE_ACC_MAX_M) continue;
    const distM = haversineM(bouncie.lat, bouncie.lng, c.fix.lat, c.fix.lng);
    if (distM > PHONE_PROX_M) continue;
    if (!best || ageS < best.ageS) best = { ...c, ageS };
  }
  if (!best) return null;
  return {
    lat: best.fix.lat,
    lng: best.fix.lng,
    accuracy_m: best.fix.accuracy_m,
    reported_at: best.fix.reported_at,
    source: best.source,
  };
}
