// Rolling actual-MPG computation for Mark's Sprinter, sourced from
// Bouncie's /v1/trips endpoint (which exposes per-trip distance + actual
// fuelConsumed straight from the ECU).
//
// Why a custom methodology: the Sprinter's onboard "miles to empty"
// computer is a black box that uses some rolling avg we can't see. We
// match its accuracy by computing our OWN rolling avg from the trip-level
// truth data Bouncie already records, then multiplying by tank-gallons
// remaining. The result is a fully introspectable number — Mark can see
// exactly which trips contributed and what the window MPG is.
//
// Cache strategy: results are stored on the bouncie_credentials singleton
// row (columns mpg_*). Refreshed lazily — if older than MPG_CACHE_TTL_MS,
// the next caller triggers a recompute. Recompute is a single Bouncie
// API call (7-day window), bounded and idempotent.

import { fetchBouncieTrips } from "./bouncie";
import { supabaseAdmin } from "./supabase";

// 2024 Mercedes-Benz Sprinter 2500 passenger — verified spec.
// US tank: 24.5 gallons.
export const TANK_GALLONS = 24.5;

// Conservative fallback when we have no recent trip data (fresh install,
// API outage, etc). 22 mpg matches Mark's observed lifetime in early data;
// previous static value of 18 was meaningfully low for his diesel.
const FALLBACK_MPG = 22;

// Recompute when the cached value is older than 30 minutes. Bouncie
// records new trips at ignition-off so a sub-hour cache feels live.
const MPG_CACHE_TTL_MS = 30 * 60_000;

// Minimum trip-window data needed before we trust the rolling number.
// Below this, fall back to the constant — one short stop-and-go drive
// shouldn't drag the displayed range way off.
const MIN_WINDOW_MILES = 20;
const MIN_WINDOW_GALLONS = 1.0;

export interface MpgSnapshot {
  // Miles per gallon. Either a freshly-computed rolling avg or the
  // fallback constant — `source` says which.
  mpg: number;
  // How that mpg was derived.
  source: "bouncie_trips" | "fallback";
  // Window the rolling avg covers (null for fallback).
  window_miles: number | null;
  window_gallons: number | null;
  window_days: number | null;
  // When we last touched Bouncie. null = never (using fallback only).
  computed_at: string | null;
}

interface CachedMpg {
  mpg_recent: number | null;
  mpg_window_miles: number | null;
  mpg_window_gallons: number | null;
  mpg_window_days: number | null;
  mpg_computed_at: string | null;
}

async function loadCached(): Promise<CachedMpg | null> {
  try {
    const { data } = await supabaseAdmin()
      .from("bouncie_credentials")
      .select("mpg_recent, mpg_window_miles, mpg_window_gallons, mpg_window_days, mpg_computed_at")
      .eq("id", 1)
      .maybeSingle();
    return (data as CachedMpg) ?? null;
  } catch {
    return null;
  }
}

async function saveCached(snap: MpgSnapshot): Promise<void> {
  try {
    await supabaseAdmin()
      .from("bouncie_credentials")
      .update({
        mpg_recent: snap.mpg,
        mpg_window_miles: snap.window_miles,
        mpg_window_gallons: snap.window_gallons,
        mpg_window_days: snap.window_days,
        mpg_computed_at: snap.computed_at ?? new Date().toISOString(),
      })
      .eq("id", 1);
  } catch (err) {
    console.warn("[mpg] saveCached failed", (err as Error).message);
  }
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Pull the last `days` worth of trips and sum miles + gallons. Returns
// null if Bouncie can't be reached or no usable data exists.
async function computeFromBouncie(days: number = 7): Promise<MpgSnapshot | null> {
  const now = new Date();
  // Bouncie's API caps the window at one week per call. Stay within that.
  const cappedDays = Math.min(days, 7);
  const start = new Date(now.getTime() - cappedDays * 86_400_000);
  const trips = await fetchBouncieTrips({
    startsAfter: ymd(start),
    endsBefore: ymd(new Date(now.getTime() + 86_400_000)), // tomorrow → catches today's trips
  });
  if (!trips) return null;
  let miles = 0;
  let gallons = 0;
  for (const t of trips) {
    if (typeof t.distance === "number" && typeof t.fuelConsumed === "number" && t.fuelConsumed > 0) {
      miles += t.distance;
      gallons += t.fuelConsumed;
    }
  }
  if (miles < MIN_WINDOW_MILES || gallons < MIN_WINDOW_GALLONS) {
    // Not enough recent data to trust — caller will fall back.
    return null;
  }
  const mpg = miles / gallons;
  return {
    mpg,
    source: "bouncie_trips",
    window_miles: +miles.toFixed(1),
    window_gallons: +gallons.toFixed(2),
    window_days: cappedDays,
    computed_at: now.toISOString(),
  };
}

// Get the current MPG snapshot. Lazy refresh: returns cached if fresh,
// recomputes if stale, falls back to constant if neither cache nor
// Bouncie has usable data.
export async function getMpgSnapshot(): Promise<MpgSnapshot> {
  const cached = await loadCached();
  const cachedFresh =
    cached &&
    cached.mpg_recent != null &&
    cached.mpg_computed_at &&
    Date.now() - new Date(cached.mpg_computed_at).getTime() < MPG_CACHE_TTL_MS;
  if (cachedFresh && cached?.mpg_recent) {
    return {
      mpg: cached.mpg_recent,
      source: "bouncie_trips",
      window_miles: cached.mpg_window_miles,
      window_gallons: cached.mpg_window_gallons,
      window_days: cached.mpg_window_days,
      computed_at: cached.mpg_computed_at,
    };
  }
  // Stale or missing — try to recompute.
  const fresh = await computeFromBouncie(7);
  if (fresh) {
    await saveCached(fresh);
    return fresh;
  }
  // Bouncie unreachable or no data. Use cached value even if stale (still
  // more accurate than the constant), else fall back.
  if (cached?.mpg_recent != null) {
    return {
      mpg: cached.mpg_recent,
      source: "bouncie_trips",
      window_miles: cached.mpg_window_miles,
      window_gallons: cached.mpg_window_gallons,
      window_days: cached.mpg_window_days,
      computed_at: cached.mpg_computed_at,
    };
  }
  return {
    mpg: FALLBACK_MPG,
    source: "fallback",
    window_miles: null,
    window_gallons: null,
    window_days: null,
    computed_at: null,
  };
}

// Range estimate at the given fuel level, in miles. Returns null when
// fuelPct is missing.
export async function getRangeMiles(fuelPct: number | null | undefined): Promise<{
  range_miles: number | null;
  gallons_remaining: number | null;
  mpg: number;
  mpg_source: MpgSnapshot["source"];
  window_miles: number | null;
  window_days: number | null;
  computed_at: string | null;
}> {
  const snap = await getMpgSnapshot();
  if (fuelPct == null) {
    return {
      range_miles: null,
      gallons_remaining: null,
      mpg: snap.mpg,
      mpg_source: snap.source,
      window_miles: snap.window_miles,
      window_days: snap.window_days,
      computed_at: snap.computed_at,
    };
  }
  const gallons = TANK_GALLONS * fuelPct;
  const miles = gallons * snap.mpg;
  return {
    range_miles: Math.round(miles),
    gallons_remaining: +gallons.toFixed(2),
    mpg: +snap.mpg.toFixed(2),
    mpg_source: snap.source,
    window_miles: snap.window_miles,
    window_days: snap.window_days,
    computed_at: snap.computed_at,
  };
}
