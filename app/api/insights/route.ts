import { NextResponse } from "next/server";
import { requireMark } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { fetchBouncieTrips, type BouncieTrip } from "@/lib/bouncie";

export const dynamic = "force-dynamic";

// Driving insights for the settings card. Numbers are pulled DIRECTLY
// from Bouncie's /v1/trips endpoint — they're already authoritative
// per-trip metrics (distance, totalIdleDuration, fuelConsumed,
// averageSpeed) computed from the ECU + odometer. We were previously
// approximating these from raw vehicle_positions samples, which was
// strictly less accurate AND brittle to polling-rate changes. Now:
//
//   miles            sum(distance) over Bouncie trips in window
//   driving_minutes  sum((endTime - startTime) - totalIdleDuration)
//   idle_minutes     sum(totalIdleDuration)
//   avg_speed_mph    distance-weighted avg of averageSpeed
//   fuel_cost        sum(fuelConsumed) × $/gal (no MPG estimation
//                    needed — Bouncie reports actual gallons used)
//   trips_completed  count of OUR trips with status='complete'
//                    (different concept from a Bouncie 'drive')
//
// Bouncie's /v1/trips has a 7-day max span per request. "Today" and
// "This week" both fit; we still pass tomorrow's date as ends-before
// so trips that just ended are included.

const FUEL_PRICE_PER_GAL = 5; // CA diesel ballpark; tune as needed

interface TripRow {
  id: string;
  status: string;
  scheduled_at: string;
  completed_at: string | null;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface WindowAgg {
  miles: number;
  driving_minutes: number;
  idle_minutes: number;
  avg_speed_mph: number;
  fuel_cost_dollars: number;
}

function aggregateBouncieTrips(trips: BouncieTrip[]): WindowAgg {
  if (trips.length === 0) {
    return { miles: 0, driving_minutes: 0, idle_minutes: 0, avg_speed_mph: 0, fuel_cost_dollars: 0 };
  }
  let miles = 0;
  let idleSec = 0;
  let runtimeSec = 0;
  let fuelGal = 0;
  let speedWeighted = 0;
  let speedWeight = 0;
  for (const t of trips) {
    const d = t.distance ?? 0;
    miles += d;
    idleSec += t.totalIdleDuration ?? 0;
    const start = new Date(t.startTime).getTime();
    const end = new Date(t.endTime).getTime();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      runtimeSec += (end - start) / 1000;
    }
    if (typeof t.fuelConsumed === "number" && t.fuelConsumed > 0) fuelGal += t.fuelConsumed;
    if (typeof t.averageSpeed === "number" && d > 0) {
      // Weight average-speed by miles so a 60-mph highway trip dominates
      // a 5-mph parking-lot creep. Simple miles weighting tracks the
      // perceived average over the whole window.
      speedWeighted += t.averageSpeed * d;
      speedWeight += d;
    }
  }
  const drivingSec = Math.max(0, runtimeSec - idleSec);
  return {
    miles: +miles.toFixed(1),
    driving_minutes: Math.round(drivingSec / 60),
    idle_minutes: Math.round(idleSec / 60),
    avg_speed_mph: speedWeight > 0 ? +(speedWeighted / speedWeight).toFixed(1) : 0,
    fuel_cost_dollars: +(fuelGal * FUEL_PRICE_PER_GAL).toFixed(2),
  };
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = supabaseAdmin();
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 86_400_000);
  // PT-anchored "today" boundary. The cleanup endpoint uses local-date
  // semantics; Bouncie's trip API takes YYYY-MM-DD, so we work in
  // dates not millis here.
  const startOfTodayPT = new Date(now);
  startOfTodayPT.setHours(0, 0, 0, 0);
  const weekStartDate = new Date(tomorrow.getTime() - 7 * 86_400_000);

  // Two windows, parallel. Each Bouncie call is one HTTP round-trip
  // (cached server-side by Bouncie itself).
  const [todayTrips, weekTrips] = await Promise.all([
    fetchBouncieTrips({
      startsAfter: ymd(startOfTodayPT),
      endsBefore: ymd(tomorrow),
    }),
    fetchBouncieTrips({
      startsAfter: ymd(weekStartDate),
      endsBefore: ymd(tomorrow),
    }),
  ]);

  const today = aggregateBouncieTrips(todayTrips ?? []);
  const week = aggregateBouncieTrips(weekTrips ?? []);

  // Trip count: from OUR trips table, status='complete' only.
  // Different concept from a Bouncie drive (one Bouncie drive can
  // span multiple passenger transports, or vice versa).
  const weekStartIso = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const { data: trips } = await sb
    .from("trips")
    .select("id,status,scheduled_at,completed_at")
    .eq("status", "complete")
    .gte("scheduled_at", weekStartIso)
    .order("scheduled_at", { ascending: false });
  const tripRows = (trips ?? []) as TripRow[];
  const todayMs = startOfTodayPT.getTime();
  const completedToday = tripRows.filter(
    (t) => t.completed_at && new Date(t.completed_at).getTime() >= todayMs,
  ).length;
  const completedWeek = tripRows.length;

  // Top destinations from trip history (any status — every address
  // sent to is fair game for the frequent-destinations strip).
  const month = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const [{ data: allTrips }, { data: hiddenRows }] = await Promise.all([
    sb
      .from("trips")
      .select("pickup_address,pickup_lat,pickup_lng,dropoff_address,dropoff_lat,dropoff_lng,scheduled_at")
      .gte("scheduled_at", month)
      .order("scheduled_at", { ascending: false })
      .limit(300),
    sb.from("hidden_destinations").select("address_key"),
  ]);
  const hiddenSet = new Set<string>(
    ((hiddenRows ?? []) as Array<{ address_key: string }>).map((r) => r.address_key),
  );

  const destBuckets = new Map<string, { address: string; lat: number | null; lng: number | null; count: number; last: string }>();
  const skipRe = /current\s+location|my\s+location|^pickup$/i;
  for (const t of (allTrips ?? []) as Array<{
    pickup_address: string | null;
    pickup_lat: number | null;
    pickup_lng: number | null;
    dropoff_address: string | null;
    dropoff_lat: number | null;
    dropoff_lng: number | null;
    scheduled_at: string;
  }>) {
    for (const [addr, lat, lng] of [
      [t.dropoff_address, t.dropoff_lat, t.dropoff_lng] as const,
      [t.pickup_address, t.pickup_lat, t.pickup_lng] as const,
    ]) {
      if (!addr || skipRe.test(addr)) continue;
      const trimmed = addr.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (hiddenSet.has(key)) continue;
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
    today: { ...today, trips_completed: completedToday },
    week: { ...week, trips_completed: completedWeek },
    top_destinations: topDestinations,
    source: "bouncie_trips_api",
  });
}
