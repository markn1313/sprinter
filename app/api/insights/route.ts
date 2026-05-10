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

  // Pull recent positions (Bouncie source) for today + week. Sort ascending
  // so we can compute deltas over time.
  const { data: weekPositions } = await sb
    .from("vehicle_positions")
    .select("lat,lng,speed_mph,fuel_pct,mileage,ignition,recorded_at")
    .eq("source", "bouncie")
    .gte("recorded_at", weekStart)
    .order("recorded_at", { ascending: true });

  const positions = (weekPositions ?? []) as VPRow[];

  // Bucketize: today vs older-week
  const todayMs = new Date(todayStart).getTime();
  const todayPositions = positions.filter(
    (p) => new Date(p.recorded_at).getTime() >= todayMs,
  );

  // Miles: prefer odometer delta if mileage column populated, else
  // sum haversine distance between consecutive points (filtered to moving).
  const milesFromOdometer = (rows: VPRow[]): number | null => {
    const valid = rows.filter((r) => r.mileage != null && r.mileage > 0);
    if (valid.length < 2) return null;
    return Math.max(0, (valid[valid.length - 1].mileage as number) - (valid[0].mileage as number));
  };
  const milesFromHaversine = (rows: VPRow[]): number => {
    let total = 0;
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1];
      const b = rows[i];
      if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) continue;
      // Skip if obvious teleport (>2 mi between consecutive points = data issue)
      const seg = haversineMi(a.lat, a.lng, b.lat, b.lng);
      if (seg < 2 && (b.speed_mph ?? 0) >= 1) total += seg;
    }
    return total;
  };

  const todayMiles = milesFromOdometer(todayPositions) ?? milesFromHaversine(todayPositions);
  const weekMiles = milesFromOdometer(positions) ?? milesFromHaversine(positions);

  // Driving time = sum of intervals where speed > 1 mph
  const driveAndIdleSeconds = (rows: VPRow[]): { driving_s: number; idle_s: number } => {
    let drv = 0;
    let idle = 0;
    for (let i = 1; i < rows.length; i++) {
      const dt = (new Date(rows[i].recorded_at).getTime() - new Date(rows[i - 1].recorded_at).getTime()) / 1000;
      if (dt > 60) continue; // skip large gaps (parked/off)
      const moving = (rows[i].speed_mph ?? 0) > 1;
      if (moving) drv += dt;
      else if ((rows[i].ignition ?? false)) idle += dt;
    }
    return { driving_s: drv, idle_s: idle };
  };
  const today = driveAndIdleSeconds(todayPositions);
  const week = driveAndIdleSeconds(positions);

  // Average speed when moving
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
  const completedToday = tripRows.filter(
    (t) => t.completed_at && new Date(t.completed_at).getTime() >= todayMs,
  ).length;
  const completedWeek = tripRows.filter((t) => t.completed_at).length;

  // Top destinations from trip history (last ~30 days for stability) — return
  // address + count + last-used. Uses dropoff_address. Skipping null/unknown.
  const month = new Date(now - 30 * 86400_000).toISOString();
  const { data: destTrips } = await sb
    .from("trips")
    .select("dropoff_address,dropoff_lat,dropoff_lng,scheduled_at")
    .gte("scheduled_at", month)
    .not("dropoff_address", "is", null)
    .order("scheduled_at", { ascending: false })
    .limit(200);

  const destBuckets = new Map<string, { address: string; lat: number | null; lng: number | null; count: number; last: string }>();
  for (const t of (destTrips ?? []) as Array<{ dropoff_address: string; dropoff_lat: number | null; dropoff_lng: number | null; scheduled_at: string }>) {
    const addr = t.dropoff_address.trim();
    if (!addr) continue;
    const key = addr.toLowerCase();
    const existing = destBuckets.get(key);
    if (existing) {
      existing.count += 1;
      if (t.scheduled_at > existing.last) existing.last = t.scheduled_at;
    } else {
      destBuckets.set(key, { address: addr, lat: t.dropoff_lat, lng: t.dropoff_lng, count: 1, last: t.scheduled_at });
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
      avg_speed_mph: +avgSpeed(todayPositions).toFixed(1),
      fuel_cost_dollars: fuelCost(todayMiles),
      trips_completed: completedToday,
    },
    week: {
      miles: +weekMiles.toFixed(1),
      driving_minutes: Math.round(week.driving_s / 60),
      idle_minutes: Math.round(week.idle_s / 60),
      avg_speed_mph: +avgSpeed(positions).toFixed(1),
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
