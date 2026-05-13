import { NextResponse } from "next/server";
import { requireMark } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { getMpgSnapshot } from "@/lib/mpg";

export const dynamic = "force-dynamic";

interface TripRow {
  id: string;
  status: string;
  scheduled_at: string;
  dispatched_at: string | null;
  completed_at: string | null;
  pickup_address: string | null;
  dropoff_address: string | null;
}

// Aggregate driving insights computed live from vehicle_positions +
// trips. All Bouncie-derived stats use GAP-BASED AGGREGATION over the
// timeseries — for each consecutive pair of samples, the time gap (up
// to MAX_GAP_S) is counted toward driving / idle / off based on the
// row's state. This is robust to irregular reporting rates (Bouncie
// sends a flurry of rows while driving and almost nothing when parked),
// where the previous fraction-of-rows × elapsed-time formula
// over-counted "driving" by 5-10x.

// Gap cap — a 10-hour parking gap between two driving sessions should
// NOT count as 10 hours of "off" time on a given day; we cap each gap
// so a single missing-reporting window can't dominate the totals.
const MAX_GAP_S = 60;
const FUEL_PRICE_PER_GAL = 5; // CA diesel rough mid-point

// Per-window aggregate computed from a single ordered scan of Bouncie
// vehicle_positions rows. One round trip to the DB per window.
interface MotionAgg {
  miles: number; // GPS haversine sum across moving samples
  driving_seconds: number;
  idle_seconds: number;
  avg_speed_mph: number;
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

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = supabaseAdmin();
  const now = Date.now();
  const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
  const weekStart = new Date(now - 7 * 86400_000).toISOString();

  interface PositionRow {
    recorded_at: string;
    lat: number | null;
    lng: number | null;
    speed_mph: number | null;
    ignition: boolean | null;
  }

  // Single ordered scan of Bouncie rows → driving/idle seconds + miles
  // + avg speed. Skips off-ignition samples for time aggregates so a
  // van parked overnight doesn't claim hours of "idle." GPS-derived
  // miles (haversine between consecutive moving samples) is more
  // resilient than Bouncie's odometer field, which has reporting gaps.
  async function motionFor(sinceIso: string): Promise<MotionAgg> {
    const { data } = await sb
      .from("vehicle_positions")
      .select("recorded_at, lat, lng, speed_mph, ignition")
      .eq("source", "bouncie")
      .gte("recorded_at", sinceIso)
      .order("recorded_at", { ascending: true })
      .limit(100000); // safety cap; a week of throttled data is ~30k rows
    const rows = (data ?? []) as PositionRow[];
    if (rows.length === 0) return { miles: 0, driving_seconds: 0, idle_seconds: 0, avg_speed_mph: 0 };
    let drivingSec = 0;
    let idleSec = 0;
    let totalMeters = 0;
    let movingMphSum = 0;
    let movingMphCount = 0;
    let prev: PositionRow | null = null;
    for (const row of rows) {
      const moving = (row.speed_mph ?? 0) > 1;
      if (prev) {
        const gapSec = Math.min(
          MAX_GAP_S,
          Math.max(0, (new Date(row.recorded_at).getTime() - new Date(prev.recorded_at).getTime()) / 1000),
        );
        if (moving) drivingSec += gapSec;
        else if (row.ignition === true) idleSec += gapSec;
        // ignition off → don't count toward either bucket

        if (
          moving &&
          row.lat != null &&
          row.lng != null &&
          prev.lat != null &&
          prev.lng != null
        ) {
          totalMeters += haversineM(prev.lat, prev.lng, row.lat, row.lng);
        }
      }
      if (moving && row.speed_mph != null) {
        movingMphSum += row.speed_mph;
        movingMphCount += 1;
      }
      prev = row;
    }
    return {
      miles: totalMeters / 1609.344,
      driving_seconds: drivingSec,
      idle_seconds: idleSec,
      avg_speed_mph: movingMphCount > 0 ? movingMphSum / movingMphCount : 0,
    };
  }

  // Run all three windows + the rolling-MPG snapshot in parallel.
  const [today, week, mpgSnap, tripsRes] = await Promise.all([
    motionFor(todayStart),
    motionFor(weekStart),
    getMpgSnapshot(),
    sb
      .from("trips")
      .select("id,status,scheduled_at,dispatched_at,completed_at,pickup_address,dropoff_address")
      .gte("scheduled_at", weekStart)
      .order("scheduled_at", { ascending: false }),
  ]);

  // Fuel cost uses rolling actual MPG (lib/mpg.ts pulls last-7-days
  // distance/fuel from Bouncie's /v1/trips). Falls back to 22 mpg if
  // Bouncie is unreachable. Previously hard-coded to 18 mpg, which
  // inflated cost by ~25% vs reality on Mark's diesel.
  const mpg = mpgSnap.mpg;
  const fuelCost = (miles: number): number =>
    +(miles / Math.max(1, mpg) * FUEL_PRICE_PER_GAL).toFixed(2);

  // Trip counts: ONLY trips with status='complete' count as completed.
  // Previously this filtered by completed_at IS NOT NULL, but the
  // stale-trip cron sweep writes completed_at when CANCELLING, so
  // cancelled trips were being counted as completed.
  const tripRows = ((tripsRes.data ?? []) as TripRow[]).filter((t) => t.status === "complete");
  const todayMs = new Date(todayStart).getTime();
  const completedToday = tripRows.filter(
    (t) => t.completed_at && new Date(t.completed_at).getTime() >= todayMs,
  ).length;
  const completedWeek = tripRows.length;

  // Top destinations from trip history (UNFILTERED by status — every
  // address you've sent the van to is fair game for the frequent-
  // destinations chip strip).
  const month = new Date(now - 30 * 86400_000).toISOString();
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
    today: {
      miles: +today.miles.toFixed(1),
      driving_minutes: Math.round(today.driving_seconds / 60),
      idle_minutes: Math.round(today.idle_seconds / 60),
      avg_speed_mph: +today.avg_speed_mph.toFixed(1),
      fuel_cost_dollars: fuelCost(today.miles),
      trips_completed: completedToday,
    },
    week: {
      miles: +week.miles.toFixed(1),
      driving_minutes: Math.round(week.driving_seconds / 60),
      idle_minutes: Math.round(week.idle_seconds / 60),
      avg_speed_mph: +week.avg_speed_mph.toFixed(1),
      fuel_cost_dollars: fuelCost(week.miles),
      trips_completed: completedWeek,
    },
    top_destinations: topDestinations,
    // Surfaced so the UI can show "based on 22.5 mpg rolling" if we
    // ever want to expose the methodology. Not rendered today.
    mpg_used: +mpg.toFixed(2),
    mpg_source: mpgSnap.source,
  });
}
