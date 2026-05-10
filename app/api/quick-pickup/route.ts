import { NextResponse } from "next/server";
import { requireMark } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { logTripEvent } from "@/lib/log";
import { cancelOpenTrips } from "@/lib/single-trip";
import { reverseGeocode } from "@/lib/geocode";

// Sentinel strings the client sends when the user taps a "pick me up here"
// or "take me home" button — we reverse-geocode the lat/lng to a real
// address before inserting the trip so history & the TV bottom strip don't
// echo "My current location" forever.
const SENTINEL_ADDRESSES = /^(my\s+current\s+location|my\s+location|mark.?s\s+location|current\s+location)$/i;

// One-tap "pick me up" — uses Mark's current GPS as pickup
export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | {
        lat?: number;
        lng?: number;
        address?: string;
        scheduled_at?: string;
        notes?: string;
        dropoff_address?: string;
        dropoff_lat?: number;
        dropoff_lng?: number;
      }
    | null;

  if (!body) return NextResponse.json({ error: "missing body" }, { status: 400 });

  // Single-trip mode: tapping Pickup replaces any prior open trip.
  await cancelOpenTrips(ctx.token);

  const sb = supabaseAdmin();

  // Default scheduled time: now (immediate dispatch)
  const scheduledAt = body.scheduled_at ?? new Date().toISOString();

  // Resolve pickup address. If the client sent a sentinel ("My current
  // location" / "Mark's location" / etc) and we have lat/lng, reverse-
  // geocode to get a real street address. Falls back to coords on failure.
  let pickupAddress: string = body.address ?? "Mark's location";
  if (
    typeof body.lat === "number" &&
    typeof body.lng === "number" &&
    (!body.address || SENTINEL_ADDRESSES.test(body.address.trim()))
  ) {
    const real = await reverseGeocode(body.lat, body.lng);
    if (real) pickupAddress = real;
    else pickupAddress = `${body.lat.toFixed(5)}, ${body.lng.toFixed(5)}`;
  }

  const { data: trip, error } = await sb
    .from("trips")
    .insert({
      passenger_name: "Mark",
      pickup_address: pickupAddress,
      pickup_lat: body.lat ?? null,
      pickup_lng: body.lng ?? null,
      dropoff_address: body.dropoff_address ?? null,
      dropoff_lat: body.dropoff_lat ?? null,
      dropoff_lng: body.dropoff_lng ?? null,
      scheduled_at: scheduledAt,
      status: "scheduled",
      notes: body.notes ?? "Pick me up",
      created_by: ctx.token,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  logTripEvent({
    trip_id: trip.id,
    kind: "created",
    actor_token: ctx.token,
    payload: {
      quick_pickup: true,
      lat: body.lat ?? null,
      lng: body.lng ?? null,
    },
  });

  // Update Mark's live location too
  if (typeof body.lat === "number" && typeof body.lng === "number") {
    await sb
      .from("mark_location")
      .update({
        lat: body.lat,
        lng: body.lng,
        reported_at: new Date().toISOString(),
      })
      .eq("id", 1);
  }

  return NextResponse.json({ trip });
}
