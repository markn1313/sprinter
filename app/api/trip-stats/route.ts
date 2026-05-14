import { NextResponse } from "next/server";
import { requireTripActor } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { getDieselPrice } from "@/lib/fuel-price";
import { getMpgSnapshot } from "@/lib/mpg";

export const dynamic = "force-dynamic";

// Per-trip metrics for the post-trip recap card.
//
// Source priority:
//
//   distance:    vehicle_positions haversine sum (real-time, always
//                available — every sample is tagged with trip_id by
//                the Bouncie webhook). Used as primary.
//
//                bouncie_trips's per-drive `distance` field is more
//                accurate when available, but lags by ~15 min for
//                in-progress drives and the OR-by-window query missed
//                drives whose `end_time` is still null. So we use
//                bouncie_trips ONLY as a sanity-check tiebreaker —
//                if the haversine sum and bouncie's distance disagree
//                by more than 20%, prefer bouncie's (it's been driven
//                through their own filtering).
//
//   fuel:        sum(bouncie_trips.fuel_consumed) when ALL overlapping
//                drives have a non-null fuel_consumed; else fall back
//                to distance / current rolling MPG. Multiplied by
//                current CA diesel price.
//
//   max_speed:   max(vehicle_positions.speed_mph) across the trip.
//
//   duration:    completed_at - dispatched_at wall clock.
//
// Auth: opens to the trip's passenger as well as Mark (the recap
// card renders on the passenger app too).

function haversineM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
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
  const url = new URL(req.url);
  const tripId = url.searchParams.get("trip");
  if (!tripId) return NextResponse.json({ error: "missing trip" }, { status: 400 });
  const ctx = await requireTripActor(token, tripId);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = supabaseAdmin();
  const { data: trip } = await sb
    .from("trips")
    .select("dispatched_at,completed_at")
    .eq("id", tripId)
    .maybeSingle();
  if (!trip) return NextResponse.json({ error: "not found" }, { status: 404 });

  const since = (trip.dispatched_at as string | null) ?? new Date(0).toISOString();
  const until = (trip.completed_at as string | null) ?? new Date().toISOString();
  const sinceMs = new Date(since).getTime();
  const untilMs = new Date(until).getTime();
  const durationMin = Math.max(0, Math.round((untilMs - sinceMs) / 60_000));

  // PRIMARY: vehicle_positions tagged with trip_id. Sum haversine
  // distances between consecutive samples. Always available — webhook
  // tags every sample with the active trip's id when it's received.
  const { data: samples } = await sb
    .from("vehicle_positions")
    .select("lat,lng,speed_mph,recorded_at")
    .eq("trip_id", tripId)
    .order("recorded_at", { ascending: true })
    .limit(5000);

  let milesFromGps = 0;
  let maxSpeed = 0;
  let prev: { lat: number; lng: number } | null = null;
  for (const s of (samples ?? []) as Array<{
    lat: number | null;
    lng: number | null;
    speed_mph: number | null;
    recorded_at: string;
  }>) {
    if (s.lat == null || s.lng == null) continue;
    if (typeof s.speed_mph === "number" && s.speed_mph > maxSpeed) {
      maxSpeed = s.speed_mph;
    }
    if (prev) {
      const m = haversineM(prev.lat, prev.lng, s.lat, s.lng);
      // Skip absurd jumps — > 500m between consecutive samples means
      // a teleport (GPS drift, ignition cycle). Capping it prevents
      // a single bad reading from inflating the total.
      if (m < 500) {
        milesFromGps += m / 1609.344;
      }
    }
    prev = { lat: s.lat, lng: s.lng };
  }

  // SANITY CHECK: pull bouncie_trips overlapping the window so we can
  // cross-reference. Query rewritten to handle end_time=null (still-
  // in-progress drives): a drive overlaps the trip window if it
  // STARTED before the window ended AND (it hasn't ended yet, OR it
  // ended after the window started).
  const winStartIso = new Date(sinceMs - 60_000).toISOString();
  const winEndIso = new Date(untilMs + 60_000).toISOString();
  const { data: drives } = await sb
    .from("bouncie_trips")
    .select("distance,fuel_consumed,end_time")
    .lte("start_time", winEndIso)
    .or(`end_time.is.null,end_time.gte.${winStartIso}`);

  let milesFromDrives = 0;
  let fuelFromDrives = 0;
  let driveHasNullDistance = false;
  let driveHasNullFuel = false;
  for (const d of (drives ?? []) as Array<{
    distance: number | null;
    fuel_consumed: number | null;
    end_time: string | null;
  }>) {
    if (typeof d.distance === "number") milesFromDrives += d.distance;
    else driveHasNullDistance = true;
    if (typeof d.fuel_consumed === "number") fuelFromDrives += d.fuel_consumed;
    else driveHasNullFuel = true;
  }

  // Prefer bouncie's per-drive distance when ALL matching drives have
  // a value AND it's within 20% of the GPS sum (sanity guardrail). If
  // any overlapping drive is still in progress (distance null), fall
  // back to the GPS haversine which is always real-time.
  let miles = milesFromGps;
  if (!driveHasNullDistance && milesFromDrives > 0) {
    const ratio = milesFromGps > 0 ? milesFromDrives / milesFromGps : 1;
    if (ratio > 0.8 && ratio < 1.25) miles = milesFromDrives;
  }

  // Fuel: prefer Bouncie's fuel_consumed when fully known; else
  // estimate via distance / rolling MPG.
  let fuelGal = 0;
  if (!driveHasNullFuel && fuelFromDrives > 0) {
    fuelGal = fuelFromDrives;
  } else if (miles > 0) {
    const mpgSnap = await getMpgSnapshot();
    if (mpgSnap.mpg > 0) fuelGal = miles / mpgSnap.mpg;
  }

  const { price: dieselPrice } = await getDieselPrice();
  const fuelCost = +(fuelGal * dieselPrice).toFixed(2);

  return NextResponse.json({
    miles: +miles.toFixed(1),
    duration_min: durationMin,
    max_speed_mph: Math.round(maxSpeed),
    fuel_cost_dollars: fuelCost,
    fuel_price_per_gal: +dieselPrice.toFixed(3),
  });
}
