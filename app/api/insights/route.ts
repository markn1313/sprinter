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

  // For driving / idle / avg-speed we sample every Nth row to keep the
  // payload reasonable. ~1000-row sample over a week is plenty resolution
  // for these aggregates given a 6s polling cadence (~100k rows/week).
  async function sampleRows(sinceIso: string, limit = 1500): Promise<VPRow[]> {
    const { data } = await sb
      .from("vehicle_positions")
      .select("lat,lng,speed_mph,fuel_pct,mileage,ignition,recorded_at")
      .eq("source", "bouncie")
      .gte("recorded_at", sinceIso)
      .order("recorded_at", { ascending: true })
      .limit(limit);
    return (data ?? []) as VPRow[];
  }

  const [todayMilesOdo, weekMilesOdo, todaySample, weekSample] = await Promise.all([
    odometerDelta(todayStart),
    odometerDelta(weekStart),
    sampleRows(todayStart, 800),
    sampleRows(weekStart, 1500),
  ]);

  const milesFromHaversine = (rows: VPRow[]): number => {
    let total = 0;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) continue;
      const seg = haversineMi(a.lat, a.lng, b.lat, b.lng);
      if (seg < 2 && (b.speed_mph ?? 0) >= 1) total += seg;
    }
    return total;
  };
  const todayMiles = todayMilesOdo ?? milesFromHaversine(todaySample);
  const weekMiles = weekMilesOdo ?? milesFromHaversine(weekSample);

  // Driving / idle from the time-bucketed sample. Sample is sparse but the
  // SUM of dt over moving samples * (sample_density_factor) is close enough
  // for a dashboard. We just sum directly here — overestimates idle if rows
  // are far apart, so we cap each gap at 5s before counting.
  const driveAndIdleSeconds = (rows: VPRow[]): { driving_s: number; idle_s: number } => {
    let drv = 0;
    let idle = 0;
    for (let i = 1; i < rows.length; i++) {
      const dt = Math.min(
        (new Date(rows[i].recorded_at).getTime() - new Date(rows[i - 1].recorded_at).getTime()) / 1000,
        15,
      );
      if (dt <= 0) continue;
      const moving = (rows[i].speed_mph ?? 0) > 1;
      if (moving) drv += dt;
      else if ((rows[i].ignition ?? false)) idle += dt;
    }
    // Density factor: extrapolate from sample to true elapsed. Sample
    // covers (sample-rows × ~6s) seconds; window covers (lastTs-firstTs).
    if (rows.length < 2) return { driving_s: 0, idle_s: 0 };
    const sampleSec = (new Date(rows[rows.length - 1].recorded_at).getTime() - new Date(rows[0].recorded_at).getTime()) / 1000;
    const samplePoints = rows.length;
    const factor = sampleSec > 0 && samplePoints > 0 ? sampleSec / (samplePoints * 6) : 1;
    return { driving_s: drv * Math.max(1, factor), idle_s: idle * Math.max(1, factor) };
  };
  const today = driveAndIdleSeconds(todaySample);
  const week = driveAndIdleSeconds(weekSample);

  const avgSpeed = (rows: VPRow[]): number => {
    const moving = rows.filter((r) => (r.speed_mph ?? 0) > 1);
    if (moving.length === 0) return 0;
    return moving.reduce((s, r) => s + (r.speed_mph as number), 0) / moving.length;
  };

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
      avg_speed_mph: +avgSpeed(todaySample).toFixed(1),
      fuel_cost_dollars: fuelCost(todayMiles),
      trips_completed: completedToday,
    },
    week: {
      miles: +weekMiles.toFixed(1),
      driving_minutes: Math.round(week.driving_s / 60),
      idle_minutes: Math.round(week.idle_s / 60),
      avg_speed_mph: +avgSpeed(weekSample).toFixed(1),
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
