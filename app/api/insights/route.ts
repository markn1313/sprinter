import { NextResponse } from "next/server";
import { requireMark } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { fetchBouncieTrips, type BouncieTrip } from "@/lib/bouncie";
import { getDieselPrice } from "@/lib/fuel-price";

export const dynamic = "force-dynamic";

// Driving insights for the settings card. Numbers are pulled DIRECTLY
// from Bouncie's /v1/trips endpoint — they're already authoritative
// per-trip metrics (distance, totalIdleDuration, fuelConsumed,
// averageSpeed) computed from the ECU + odometer.
//
//   miles            sum(distance) over Bouncie trips in window
//   driving_minutes  sum((endTime - startTime) - totalIdleDuration)
//   idle_minutes     sum(totalIdleDuration)
//   avg_speed_mph    distance-weighted avg of averageSpeed
//   fuel_cost        sum(fuelConsumed) × current CA diesel $/gal
//                    (DB-cached price from EIA, see lib/fuel-price.ts)
//
// Bouncie's /v1/trips has a 7-day max span per request. 24h + 7-day
// windows each fit in one call; the 30-day window is built from 5
// parallel weekly calls and merged.

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

function aggregateBouncieTrips(trips: BouncieTrip[], pricePerGal: number): WindowAgg {
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
    fuel_cost_dollars: +(fuelGal * pricePerGal).toFixed(2),
  };
}

// Fetch trips covering an arbitrary span by issuing parallel ≤7-day
// Bouncie calls (their hard per-request cap) and merging the results.
// Used for the 30-day window; the 24h and 7d windows fit in one call.
async function fetchTripsOverSpan(spanDays: number, anchor: Date): Promise<BouncieTrip[]> {
  const tomorrow = new Date(anchor.getTime() + 86_400_000);
  const windowStart = new Date(anchor.getTime() - spanDays * 86_400_000);
  const buckets: { startsAfter: string; endsBefore: string }[] = [];
  let cursorEnd = tomorrow;
  while (cursorEnd > windowStart) {
    const start = new Date(Math.max(windowStart.getTime(), cursorEnd.getTime() - 7 * 86_400_000));
    buckets.push({ startsAfter: ymd(start), endsBefore: ymd(cursorEnd) });
    cursorEnd = start;
  }
  const results = await Promise.all(buckets.map((b) => fetchBouncieTrips(b)));
  // De-dup by transactionId — Bouncie won't return the same trip in two
  // adjacent windows, but be defensive in case start/end boundaries
  // overlap on the same date.
  const seen = new Set<string>();
  const merged: BouncieTrip[] = [];
  for (const batch of results) {
    for (const t of batch ?? []) {
      if (seen.has(t.transactionId)) continue;
      seen.add(t.transactionId);
      merged.push(t);
    }
  }
  return merged;
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = supabaseAdmin();
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 86_400_000);
  // Rolling cutoffs anchored to NOW. Bouncie's /v1/trips takes ymd
  // dates only, so we over-query and filter precisely by endTime.
  const cutoff24h = new Date(now.getTime() - 24 * 3600_000);
  const cutoff7d = new Date(now.getTime() - 7 * 86_400_000);
  const cutoff30d = new Date(now.getTime() - 30 * 86_400_000);

  // Run the three Bouncie windows + the price lookup in parallel.
  // 24h and 7d fit in a single Bouncie call each; the 30-day window
  // builds from 5 parallel weekly calls inside fetchTripsOverSpan.
  const startDate24h = new Date(cutoff24h.getTime() - 86_400_000);
  const startDate7d = new Date(tomorrow.getTime() - 7 * 86_400_000);

  const [last24hRaw, last7dRaw, last30dRaw, fuel] = await Promise.all([
    fetchBouncieTrips({ startsAfter: ymd(startDate24h), endsBefore: ymd(tomorrow) }),
    fetchBouncieTrips({ startsAfter: ymd(startDate7d), endsBefore: ymd(tomorrow) }),
    fetchTripsOverSpan(30, now),
    getDieselPrice(),
  ]);

  // Filter to trips whose endTime falls within the rolling window.
  // Open trips (endTime missing — still driving) are included if
  // they started within the window.
  const within = (cutoffMs: number) => (t: BouncieTrip) => {
    const refMs = t.endTime ? new Date(t.endTime).getTime() : t.startTime ? new Date(t.startTime).getTime() : 0;
    return refMs >= cutoffMs;
  };
  const last24hTrips = (last24hRaw ?? []).filter(within(cutoff24h.getTime()));
  const last7dTrips = (last7dRaw ?? []).filter(within(cutoff7d.getTime()));
  const last30dTrips = last30dRaw.filter(within(cutoff30d.getTime()));

  const today = aggregateBouncieTrips(last24hTrips, fuel.price);
  const week = aggregateBouncieTrips(last7dTrips, fuel.price);
  const month = aggregateBouncieTrips(last30dTrips, fuel.price);

  // Top destinations from trip history (any status — every address
  // sent to is fair game for the frequent-destinations strip).
  const destSince = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const [{ data: allTrips }, { data: hiddenRows }] = await Promise.all([
    sb
      .from("trips")
      .select("pickup_address,pickup_lat,pickup_lng,dropoff_address,dropoff_lat,dropoff_lng,scheduled_at")
      .gte("scheduled_at", destSince)
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
    today,
    week,
    month,
    top_destinations: topDestinations,
    fuel: {
      price_per_gal: +fuel.price.toFixed(3),
      source: fuel.source,
      effective_date: fuel.effective_date,
    },
    source: "bouncie_trips_api",
  });
}
