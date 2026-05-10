import { NextResponse } from "next/server";
import { requireMark } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

interface VPRow {
  lat: number | null;
  lng: number | null;
  speed_mph: number | null;
  fuel_pct: number | null;
  mileage: number | null;
  ignition: boolean | null;
  recorded_at: string;
}

interface TripRow {
  id: string;
  status: string;
  scheduled_at: string;
  dispatched_at: string | null;
  completed_at: string | null;
  pickup_address: string | null;
  dropoff_address: string | null;
}

// Aggregate insights: today's miles, week's miles, # trips, top destinations,
// idle time, average speed. Computed live from vehicle_positions timeseries
// + trips table. No materialized view — at our cadence (every 6s = 14k
// rows/day, 100k/week) live aggregation is fine.
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = supabaseAdmin();
  const now = Date.now();
  const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const weekStart = new Date(now - 7 * 86400_000).toISOString();

  // Mileage delta = max-min (Bouncie's odometer is monotonic). Two cheap
  // ordered-limited queries beat pulling thousands of rows. Returns null
  // if odometer isn't reporting.
  async function odometerDelta(sinceIso: string): Promise<number | null> {
    const [{ data: minRow }, { data: maxRow }] = await Promise.all([
      sb
        .from("vehicle_positions")
        .select("mileage")
        .eq("source", "bouncie")
        .gte("recorded_at", sinceIso)
        .not("mileage", "is", null)
        .order("recorded_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
      sb
        .from("vehicle_positions")
        .select("mileage")
        .eq("source", "bouncie")
        .gte("recorded_at", sinceIso)
        .not("mileage", "is", null)
        .order("recorded_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ]);
    const lo = minRow?.mileage as number | null | undefined;
    const hi = maxRow?.mileage as number | null | undefined;
    if (lo == null || hi == null) return null;
    return Math.max(0, hi - lo);
  }

  // Direct count queries: each Bouncie row ≈ 5–6s of state.
  // count(speed > 1) × pollInterval ≈ driving seconds — much more accurate
  // than sampling a sparse window.
  async function counts(sinceIso: string): Promise<{ moving: number; idle: number }> {
    const [movingRes, idleRes] = await Promise.all([
      sb
        .from("vehicle_positions")
        .select("*", { count: "exact", head: true })
        .eq("source", "bouncie")
        .gte("recorded_at", sinceIso)
        .gt("speed_mph", 1),
      sb
        .from("vehicle_positions")
        .select("*", { count: "exact", head: true })
        .eq("source", "bouncie")
        .gte("recorded_at", sinceIso)
        .lte("speed_mph", 1)
        .eq("ignition", true),
    ]);
    return { moving: movingRes.count ?? 0, idle: idleRes.count ?? 0 };
  }

  // Average speed: pull a capped sample of moving rows and average.
  async function avgSpeedFor(sinceIso: string): Promise<number> {
    const { data } = await sb
      .from("vehicle_positions")
      .select("speed_mph")
      .eq("source", "bouncie")
      .gte("recorded_at", sinceIso)
      .gt("speed_mph", 1)
      .limit(1000);
    if (!data || data.length === 0) return 0;
    const sum = (data as Array<{ speed_mph: number }>).reduce((a, r) => a + r.speed_mph, 0);
    return sum / data.length;
  }

  const POLL_S = 6;
  const [todayMilesOdo, weekMilesOdo, todayCounts, weekCounts, todayAvg, weekAvg] = await Promise.all([
    odometerDelta(todayStart),
    odometerDelta(weekStart),
    counts(todayStart),
    counts(weekStart),
    avgSpeedFor(todayStart),
    avgSpeedFor(weekStart),
  ]);

  const today = { driving_s: todayCounts.moving * POLL_S, idle_s: todayCounts.idle * POLL_S };
  const week = { driving_s: weekCounts.moving * POLL_S, idle_s: weekCounts.idle * POLL_S };
  const todayMiles = todayMilesOdo ?? 0;
  const weekMiles = weekMilesOdo ?? 0;
  const avgSpeed = (which: "today" | "week"): number => (which === "today" ? todayAvg : weekAvg);

  // Trip cost estimate. Sprinter ~ 18 mpg combined. Fuel cost ~ $5/gal CA.
  // Driver pay would be tracked separately; this is just fuel.
  const fuelCost = (miles: number): number => +(miles / 18 * 5).toFixed(2);

  // Trips this week + top destinations
  const { data: trips } = await sb
    .from("trips")
    .select("id,status,scheduled_at,dispatched_at,completed_at,pickup_address,dropoff_address")
    .gte("scheduled_at", weekStart)
    .order("scheduled_at", { ascending: false });

  const tripRows = (trips ?? []) as TripRow[];
  const todayMs = new Date(todayStart).getTime();
  const completedToday = tripRows.filter(
    (t) => t.completed_at && new Date(t.completed_at).getTime() >= todayMs,
  ).length;
  const completedWeek = tripRows.filter((t) => t.completed_at).length;

  // Top destinations from trip history. Combine PICKUP + DROPOFF addresses
  // because a frequent pickup is usually "home" — and we want it to be one
  // tap away when Mark is OUT and wants to go back. Filter "current
  // location" / "my location" sentinel pickups (those carry no info).
  const month = new Date(now - 30 * 86400_000).toISOString();
  const { data: allTrips } = await sb
    .from("trips")
    .select("pickup_address,pickup_lat,pickup_lng,dropoff_address,dropoff_lat,dropoff_lng,scheduled_at")
    .gte("scheduled_at", month)
    .order("scheduled_at", { ascending: false })
    .limit(300);

  const destBuckets = new Map<string, { address: string; lat: number | null; lng: number | null; count: number; last: string }>();
  const skipRe = /current\s+location|my\s+location|^pickup$/i;
  for (const t of (allTrips ?? []) as Array<{ pickup_address: string | null; pickup_lat: number | null; pickup_lng: number | null; dropoff_address: string | null; dropoff_lat: number | null; dropoff_lng: number | null; scheduled_at: string }>) {
    for (const [addr, lat, lng] of [
      [t.dropoff_address, t.dropoff_lat, t.dropoff_lng] as const,
      [t.pickup_address, t.pickup_lat, t.pickup_lng] as const,
    ]) {
      if (!addr || skipRe.test(addr)) continue;
      const trimmed = addr.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      const existing = destBuckets.get(key);
      if (existing) {
        existing.count += 1;
        if (t.scheduled_at > existing.last) existing.last = t.scheduled_at;
      } else {
        destBuckets.set(key, { address: trimmed, lat, lng, count: 1, last: t.scheduled_at });
      }
    }
  }
  const topDestinations = Array.from(destBuckets.values())
    .sort((a, b) => b.count - a.count || (b.last > a.last ? 1 : -1))
    .slice(0, 6);

  return NextResponse.json({
    today: {
      miles: +todayMiles.toFixed(1),
      driving_minutes: Math.round(today.driving_s / 60),
      idle_minutes: Math.round(today.idle_s / 60),
      avg_speed_mph: +avgSpeed("today").toFixed(1),
      fuel_cost_dollars: fuelCost(todayMiles),
      trips_completed: completedToday,
    },
    week: {
      miles: +weekMiles.toFixed(1),
      driving_minutes: Math.round(week.driving_s / 60),
      idle_minutes: Math.round(week.idle_s / 60),
      avg_speed_mph: +avgSpeed("week").toFixed(1),
      fuel_cost_dollars: fuelCost(weekMiles),
      trips_completed: completedWeek,
    },
    top_destinations: topDestinations,
  });
}

function haversineMi(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3959;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
