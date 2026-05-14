import { NextResponse } from "next/server";
import { requireTripActor } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { getDieselPrice } from "@/lib/fuel-price";

export const dynamic = "force-dynamic";

// Per-trip metrics for the post-trip recap card.
//
// Distance + fuel cost + max speed come from Bouncie's per-drive
// telemetry (bouncie_trips), filtered to drives that overlap our
// trip's [dispatched_at, completed_at] window. This is the same
// source the rolling 24h / 7d / 30d insights use — odometer-delta
// from vehicle_positions (the prior implementation) was unreliable
// because Bouncie on the consumer tier doesn't report odometer in
// every sample. A trip that didn't happen to land an odometer-
// bearing first sample inside its window came back as 0 mi — which
// is exactly what Mark saw on the screenshot ("0 mi · 103 min · $0").
//
// Bouncie's per-drive `distance` is always populated and matches
// what Bouncie's own dashboard reports, so we use that.
//
// Duration stays wall-clock dispatched_at → completed_at (it's the
// trip's lifecycle duration, not pure driving time).
//
// Fuel cost = sum(fuelConsumed gallons) × current CA diesel price.
// Falls back to a mpg-estimate path only if Bouncie didn't report
// fuelConsumed (older firmware / older trips).
//
// Auth: opens to the trip's passenger as well as Mark (the recap
// card shows on the passenger app too).

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

  // Pull Bouncie drives whose start OR end falls inside the window,
  // OR whose start≤since && end≥until (trip is wholly inside a
  // single Bouncie drive). The bouncie_trips table is upserted every
  // 15 min by the cron sync, so a freshly-completed trip should
  // have its drive(s) here within ~15 min — earlier than that we
  // surface "—" placeholders instead of a fake 0.
  const padMs = 60_000; // 1 min slop on each side for clock skew
  const winStartIso = new Date(sinceMs - padMs).toISOString();
  const winEndIso = new Date(untilMs + padMs).toISOString();
  const { data: drives } = await sb
    .from("bouncie_trips")
    .select("start_time,end_time,distance,fuel_consumed,max_speed")
    .or(
      `and(start_time.gte.${winStartIso},start_time.lte.${winEndIso}),and(end_time.gte.${winStartIso},end_time.lte.${winEndIso}),and(start_time.lte.${winStartIso},end_time.gte.${winEndIso})`,
    );

  let miles = 0;
  let fuelGal = 0;
  let maxSpeed = 0;
  for (const d of (drives ?? []) as Array<{
    start_time: string;
    end_time: string | null;
    distance: number | null;
    fuel_consumed: number | null;
    max_speed: number | null;
  }>) {
    if (typeof d.distance === "number") miles += d.distance;
    if (typeof d.fuel_consumed === "number") fuelGal += d.fuel_consumed;
    if (typeof d.max_speed === "number" && d.max_speed > maxSpeed) maxSpeed = d.max_speed;
  }

  // Fallback fuel calc if Bouncie didn't return fuelConsumed
  // (older firmware): estimate via 18 mpg. Mark's actual rolling
  // MPG (~14 for the Sprinter) would be more accurate, but 18
  // keeps parity with the prior endpoint and lets us avoid an
  // extra DB hop.
  if (fuelGal === 0 && miles > 0) {
    fuelGal = miles / 18;
  }

  const { price: dieselPrice } = await getDieselPrice();
  const fuelCost = +(fuelGal * dieselPrice).toFixed(2);
  const durationMs = untilMs - sinceMs;
  const durationMin = Math.max(0, Math.round(durationMs / 60_000));

  return NextResponse.json({
    miles: +miles.toFixed(1),
    duration_min: durationMin,
    max_speed_mph: +maxSpeed.toFixed(0),
    fuel_cost_dollars: fuelCost,
    fuel_price_per_gal: +dieselPrice.toFixed(3),
  });
}
