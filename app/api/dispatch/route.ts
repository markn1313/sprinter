import { NextResponse } from "next/server";
import { newToken, requireMark } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { parseDispatch } from "@/lib/parse-dispatch";
import { geocode } from "@/lib/geocode";
import { route, Waypoint } from "@/lib/routing";
import { getVanPosition } from "@/lib/bouncie";

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
      duration_s = r.duration_s;
    }
  }

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
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let guestToken: string | null = null;
  const shouldMint = body.mintGuestLink !== false && !parsed.isOwnerRiding;
  if (shouldMint) {
    guestToken = newToken();
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
