import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";
import { getVanPosition } from "@/lib/bouncie";
import { getRangeMiles } from "@/lib/mpg";

export const dynamic = "force-dynamic";

// GET /api/range — returns the current Sprinter range using a rolling
// actual-MPG computed from Bouncie's per-trip fuel data, multiplied by
// gallons remaining in the tank. Replaces the old static 18-mpg estimate.
//
// Response shape:
// {
//   range_miles, gallons_remaining, fuel_pct,
//   mpg, mpg_source: "bouncie_trips" | "fallback",
//   window_miles, window_days, computed_at
// }
//
// Includes the methodology so the UI can show "475 mi (24 mpg × 19.5 gal,
// 7-day rolling)" if Mark wants the breakdown visible.
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const van = await getVanPosition();
  const fuelPct = van.fuel_pct;
  const r = await getRangeMiles(fuelPct);
  return NextResponse.json({
    ...r,
    fuel_pct: fuelPct,
    van_source: van.source,
    van_updated_at: van.updated_at,
  });
}
