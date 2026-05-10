import { NextResponse } from "next/server";
import { requireMark } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Per-trip metrics from vehicle_positions: distance (odometer delta),
// duration (dispatched → completed), max speed, fuel cost.
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const tripId = url.searchParams.get("trip");
  if (!tripId) return NextResponse.json({ error: "missing trip" }, { status: 400 });

  const sb = supabaseAdmin();
  const { data: trip } = await sb
    .from("trips")
    .select("dispatched_at,completed_at")
    .eq("id", tripId)
    .maybeSingle();
  if (!trip) return NextResponse.json({ error: "not found" }, { status: 404 });

  const since = (trip.dispatched_at as string | null) ?? new Date(0).toISOString();
  const until = (trip.completed_at as string | null) ?? new Date().toISOString();

  // Odometer delta — min and max mileage during the trip window
  const [{ data: minRow }, { data: maxRow }, { data: maxSpeedRow }] = await Promise.all([
    sb
      .from("vehicle_positions")
      .select("mileage")
      .gte("recorded_at", since)
      .lte("recorded_at", until)
      .not("mileage", "is", null)
      .order("recorded_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    sb
      .from("vehicle_positions")
      .select("mileage")
      .gte("recorded_at", since)
      .lte("recorded_at", until)
      .not("mileage", "is", null)
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    sb
      .from("vehicle_positions")
      .select("speed_mph")
      .gte("recorded_at", since)
      .lte("recorded_at", until)
      .order("speed_mph", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const lo = minRow?.mileage as number | null | undefined;
  const hi = maxRow?.mileage as number | null | undefined;
  const miles = lo != null && hi != null ? Math.max(0, hi - lo) : 0;
  const maxSpeed = (maxSpeedRow?.speed_mph as number | null) ?? 0;
  const durationMs = new Date(until).getTime() - new Date(since).getTime();
  const durationMin = Math.max(0, Math.round(durationMs / 60_000));
  const fuelCost = +((miles / 18) * 5).toFixed(2);

  return NextResponse.json({
    miles: +miles.toFixed(1),
    duration_min: durationMin,
    max_speed_mph: +maxSpeed.toFixed(0),
    fuel_cost_dollars: fuelCost,
  });
}
