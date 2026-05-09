// 2024 Mercedes-Benz Sprinter (Mark's van) — fuel + range estimates
// Tank: ~24.5 gal · Combined MPG ~18 (loaded passenger config) → ~440 mi full
const TANK_GALLONS = 24.5;
const COMBINED_MPG = 18;
const FULL_RANGE_MI = TANK_GALLONS * COMBINED_MPG;

export function rangeMiles(fuelPct: number | null | undefined): number | null {
  if (fuelPct == null) return null;
  return Math.round(FULL_RANGE_MI * fuelPct);
}
