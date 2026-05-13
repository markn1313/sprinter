import { NextResponse } from "next/server";
import { newToken, requireMark } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { parseDispatch } from "@/lib/parse-dispatch";
import { geocode } from "@/lib/geocode";
import { route, Waypoint, STOP_WAIT_SECONDS } from "@/lib/routing";
import { getVanPosition } from "@/lib/bouncie";
import { logTripEvent } from "@/lib/log";
import { cancelOpenTrips } from "@/lib/single-trip";

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { input?: string; mintGuestLink?: boolean }
    | null;
  if (!body?.input || !body.input.trim()) {
    return NextResponse.json({ error: "missing input" }, { status: 400 });
  }

  const parsed = await parseDispatch(body.input);

  // Single-trip mode: a new dispatch replaces any open trip so the focus
  // selector only ever has one candidate. Avoids "ghost" trips hijacking
  // the live map.
  await cancelOpenTrips(ctx.token);

  // Geocode pickup + dropoff in parallel
  const [pickupGeo, dropoffGeo] = await Promise.all([
    geocode(parsed.pickupHint),
    geocode(parsed.dropoffHint),
  ]);

  // If we have both pickup + dropoff, route from current van position → pickup → dropoff
  let polyline: string | null = null;
  let distance_m: number | null = null;
  let duration_s: number | null = null;
  if (pickupGeo && dropoffGeo) {
    const van = await getVanPosition();
    const wp: Waypoint[] = [
      { lat: van.lat, lng: van.lng },
      { lat: pickupGeo.lat, lng: pickupGeo.lng },
      { lat: dropoffGeo.lat, lng: dropoffGeo.lng },
    ];
    const r = await route(wp);
    if (r) {
      polyline = r.polyline;
      distance_m = r.distance_m;
      // wp = [van, pickup, dropoff] — pickup is one intermediate stop so
      // add a single STOP_WAIT_SECONDS for boarding before dropoff. Routes
      // without a pickup (shouldn't happen here since pickup is required to
      // reach this branch) add zero.
      const intermediates = Math.max(0, wp.length - 2);
      duration_s = r.duration_s + intermediates * STOP_WAIT_SECONDS;
    }
  }

  // Universal-Pickup model: the dispatched pickup is a stop in stops[],
  // attributed to whoever will be picked up. When we'll mint a passenger
  // link below, we pre-mint the token so we can stamp it on the stop in
  // the same insert (avoids a follow-up patch). When the owner is the
  // passenger (parsed.isOwnerRiding), the stop is attributed to ctx.token.
  // Dual-write trip.pickup_* for back-compat — Phase 3 cuts readers over.
  const shouldMint = body.mintGuestLink !== false && !parsed.isOwnerRiding;
  const guestToken: string | null = shouldMint ? newToken() : null;
  const pickupStopToken = guestToken ?? ctx.token;
  const initialStops =
    pickupGeo
      ? [
          {
            id: crypto.randomUUID(),
            kind: "stop" as const,
            address: pickupGeo.display ?? parsed.pickupHint,
            lat: pickupGeo.lat,
            lng: pickupGeo.lng,
            passenger: parsed.passengerName,
            created_by_token: pickupStopToken,
            arrived_at: null,
            added_at: new Date().toISOString(),
          },
        ]
      : [];

  const sb = supabaseAdmin();
  const { data: trip, error } = await sb
    .from("trips")
    .insert({
      passenger_name: parsed.passengerName,
      pickup_address: pickupGeo?.display ?? parsed.pickupHint,
      pickup_lat: pickupGeo?.lat ?? null,
      pickup_lng: pickupGeo?.lng ?? null,
      dropoff_address: dropoffGeo?.display ?? parsed.dropoffHint,
      dropoff_lat: dropoffGeo?.lat ?? null,
      dropoff_lng: dropoffGeo?.lng ?? null,
      scheduled_at: parsed.scheduledAt,
      notes: parsed.rawNotes,
      created_by: ctx.token,
      status: "scheduled",
      route_polyline: polyline,
      route_distance_meters: distance_m,
      route_duration_seconds: duration_s,
      estimated_minutes: duration_s ? Math.round(duration_s / 60) : null,
      stops: initialStops,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logTripEvent({
    trip_id: trip.id,
    kind: "created",
    actor_token: ctx.token,
    payload: {
      passenger: parsed.passengerName,
      pickup: parsed.pickupHint,
      dropoff: parsed.dropoffHint,
      scheduled_at: parsed.scheduledAt,
    },
  });

  if (guestToken) {
    await sb.from("links").insert({
      token: guestToken,
      role: "passenger",
      name: parsed.passengerName,
      created_by: ctx.token,
      trip_id: trip.id,
      // Per-trip link expires 16 hours after the trip's scheduled pickup
      expires_at: new Date(new Date(parsed.scheduledAt).getTime() + 16 * 3600_000).toISOString(),
    });
    await sb.from("trips").update({ passenger_link_token: guestToken }).eq("id", trip.id);
  }

  return NextResponse.json({ trip, parsed, guestToken });
}
