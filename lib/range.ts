// DEPRECATED. The static range estimate has moved to lib/mpg.ts which
// uses a rolling actual MPG computed from Bouncie's per-trip fuel data.
//
// This file remains as a sync-callable fallback for any UI rendered in a
// no-network state (e.g. cold-start before /api/range responds). It uses
// the same tank size + the conservative-but-not-laughable fallback MPG.
// Anything new should call the /api/range endpoint via useRange() instead.
const TANK_GALLONS = 24.5;
const FALLBACK_MPG = 22;

export function rangeMiles(fuelPct: number | null | undefined): number | null {
  if (fuelPct == null) return null;
  return Math.round(TANK_GALLONS * fuelPct * FALLBACK_MPG);
}
