import { NextResponse } from "next/server";
import { requireMark } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { type BouncieTrip } from "@/lib/bouncie";
import { getDieselPrice, getAvgDieselPrice } from "@/lib/fuel-price";

export const dynamic = "force-dynamic";

// Driving insights for the settings card. Source = Supabase bouncie_trips
// table (populated by the nightly cron via lib/bouncie.syncBouncieTrips).
//
//   miles            sum(distance) over trips in window
//   driving_minutes  sum((endTime - startTime) - totalIdleDuration)
//   idle_minutes     sum(totalIdleDuration)
//   avg_speed_mph    distance-weighted avg of averageSpeed
//   fuel_cost        sum(fuelConsumed) × current CA diesel $/gal
//                    (DB-cached price from EIA, see lib/fuel-price.ts)
//
// Previous version called Bouncie's /v1/trips live for the 24h + 7d
// windows. Bouncie's API was returning the same (incomplete) result set
// for both, even though the queries differed and the synced table had
// 5 trips in the past 7 days. The table is the single source of truth
// — fresher than yesterday at worst, since the cron syncs nightly, plus
// the realtime sync triggered on every Bouncie webhook.

interface WindowAgg {
  miles: number;
  driving_minutes: number;
  idle_minutes: number;
  avg_speed_mph: number;
  fuel_cost_dollars: number;
  // Per-window diesel rate applied to fuel_cost — for "Last 24h"
  // this is the latest EIA datapoint, for "Last 7 days" / "Last 30
  // days" it's the average over the window. Exposed so the UI can
  // show "@ $X.XX/gal" beside each box's fuel total.
  fuel_price_per_gal: number;
}

function aggregateBouncieTrips(trips: BouncieTrip[], pricePerGal: number): WindowAgg {
  if (trips.length === 0) {
    return { miles: 0, driving_minutes: 0, idle_minutes: 0, avg_speed_mph: 0, fuel_cost_dollars: 0, fuel_price_per_gal: +pricePerGal.toFixed(3) };
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
    fuel_price_per_gal: +pricePerGal.toFixed(3),
  };
}

// Row shape from the bouncie_trips table (snake_case Postgres) — convert
// to the camelCase BouncieTrip shape the aggregator expects.
interface BouncieTripRow {
  transaction_id: string;
  start_time: string;
  end_time: string;
  start_odometer: number;
  end_odometer: number;
  distance: number;
  fuel_consumed: number | null;
  average_speed: number;
  max_speed: number;
  total_idle_duration: number;
  imei: string;
}

// Returns the Date corresponding to midnight (00:00) in LA time, N
// calendar days before today (in LA). Used to anchor "Last 7/30 days"
// to a calendar window the user can mentally verify against, rather
// than a rolling 168h window that drifts out by minutes overnight.
//
// Computes LA's UTC offset from `now` by formatting the same instant
// in both UTC and LA and diffing the hour fields — picks up DST
// transitions automatically. Hand-rolled rather than pulling date-fns-tz
// in to keep the route slim.
function laMidnightDaysAgo(now: Date, daysBack: number): Date {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const today = fmt.format(now); // "2026-05-21"
  const [y, m, d] = today.split("-").map(Number);
  // Compute LA's UTC offset for this calendar date: noon UTC formatted
  // in LA tells us what hour 12:00Z is over there.
  const probe = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const laHour = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    hour12: false,
  }).format(probe);
  const offsetHours = 12 - parseInt(laHour, 10); // PDT=7, PST=8
  return new Date(Date.UTC(y, m - 1, d - daysBack, offsetHours, 0, 0));
}

function rowToTrip(r: BouncieTripRow): BouncieTrip {
  return {
    transactionId: r.transaction_id,
    startTime: r.start_time,
    endTime: r.end_time,
    startOdometer: r.start_odometer,
    endOdometer: r.end_odometer,
    distance: r.distance,
    fuelConsumed: r.fuel_consumed,
    averageSpeed: r.average_speed,
    maxSpeed: r.max_speed,
    totalIdleDuration: r.total_idle_duration,
    imei: r.imei,
  };
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = supabaseAdmin();
  const now = new Date();
  // Cutoffs:
  //   24h  → rolling, last 24 hours ("today-ish") — the "H" in the
  //          label tells the user this one's hour-precise.
  //   7d   → calendar-day-anchored: today + the previous 6 calendar
  //          days in LA time. Rolling 168h had the user complaining
  //          "Last 7 days is missing my trip from last week" because
  //          a trip ending at 00:26 fell out of the 168h window by
  //          43 minutes when checked after midnight UTC. Calendar
  //          anchoring matches every other product's "Last 7 days"
  //          semantics.
  //   30d  → same: today + previous 29 calendar days, LA-anchored.
  const cutoff24h = new Date(now.getTime() - 24 * 3600_000);
  const cutoff7d = laMidnightDaysAgo(now, 6);
  const cutoff30d = laMidnightDaysAgo(now, 29);

  // ONE query for the widest window — bucket client-side. Way more
  // reliable than the previous live-Bouncie approach, which was
  // returning the 24h subset for the 7d query (Bouncie API bug or
  // quirk). The bouncie_trips table is kept fresh by the nightly cron
  // + the realtime webhook handler.
  const [tripsRes, fuel24h, fuel7d, fuel30d] = await Promise.all([
    sb
      .from("bouncie_trips")
      .select("transaction_id,imei,start_time,end_time,start_odometer,end_odometer,distance,fuel_consumed,average_speed,max_speed,total_idle_duration")
      .gte("end_time", cutoff30d.toISOString())
      .order("end_time", { ascending: false }),
    getDieselPrice(),
    getAvgDieselPrice(7),
    getAvgDieselPrice(30),
  ]);

  const allRows = (tripsRes.data ?? []) as BouncieTripRow[];
  const allTrips30d = allRows.map(rowToTrip);

  // Bucket by reference time (endTime when present, startTime for
  // in-flight trips with no end yet).
  const within = (cutoffMs: number) => (t: BouncieTrip) => {
    const refMs = t.endTime ? new Date(t.endTime).getTime() : t.startTime ? new Date(t.startTime).getTime() : 0;
    return refMs >= cutoffMs;
  };
  const last24hTrips = allTrips30d.filter(within(cutoff24h.getTime()));
  const last7dTrips = allTrips30d.filter(within(cutoff7d.getTime()));
  const last30dTrips = allTrips30d.filter(within(cutoff30d.getTime()));

  const today = aggregateBouncieTrips(last24hTrips, fuel24h.price);
  const week = aggregateBouncieTrips(last7dTrips, fuel7d.price);
  const month = aggregateBouncieTrips(last30dTrips, fuel30d.price);

  // Top destinations from trip history (any status — every address
  // sent to is fair game for the frequent-destinations strip).
  const destSince = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const [{ data: allTrips }, { data: hiddenRows }] = await Promise.all([
    sb
      .from("trips")
      .select("stops,scheduled_at")
      .gte("scheduled_at", destSince)
      .order("scheduled_at", { ascending: false })
      .limit(300),
    sb.from("hidden_destinations").select("address_key"),
  ]);
  const hiddenSet = new Set<string>(
    ((hiddenRows ?? []) as Array<{ address_key: string }>).map((r) => r.address_key),
  );

  // EVERY stop counts as a destination — multi-stop trips now contribute
  // each address, not just pickup/dropoff. Bucket by rounded lat/lng
  // (~11m) so e.g. "123 Main" and "123 Main St" at the same coords merge;
  // fall back to a lowercased address key when coords are missing.
  type StopRow = {
    address?: string | null;
    lat?: number | null;
    lng?: number | null;
  };
  type TripRow = { stops: StopRow[] | null; scheduled_at: string };
  const destBuckets = new Map<string, { address: string; lat: number | null; lng: number | null; count: number; last: string }>();
  const skipRe = /current\s+location|my\s+location|^pickup$/i;
  for (const t of (allTrips ?? []) as TripRow[]) {
    for (const s of t.stops ?? []) {
      const addr = s.address;
      if (!addr || skipRe.test(addr)) continue;
      const trimmed = addr.trim();
      if (!trimmed) continue;
      const addrKey = trimmed.toLowerCase();
      if (hiddenSet.has(addrKey)) continue;
      const hasCoords = typeof s.lat === "number" && typeof s.lng === "number";
      const key = hasCoords
        ? `${(s.lat as number).toFixed(4)},${(s.lng as number).toFixed(4)}`
        : addrKey;
      const existing = destBuckets.get(key);
      if (existing) {
        existing.count += 1;
        if (t.scheduled_at > existing.last) existing.last = t.scheduled_at;
      } else {
        destBuckets.set(key, {
          address: trimmed,
          lat: hasCoords ? (s.lat as number) : null,
          lng: hasCoords ? (s.lng as number) : null,
          count: 1,
          last: t.scheduled_at,
        });
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
      // Backwards-compatible top-level fuel block — represents the
      // "current" rate (Last 24h). Each window also carries its own
      // fuel_price_per_gal for per-window averages (see WindowAgg).
      price_per_gal: +fuel24h.price.toFixed(3),
      source: fuel24h.source,
      effective_date: fuel24h.effective_date,
    },
    source: "bouncie_trips_api",
  });
}
