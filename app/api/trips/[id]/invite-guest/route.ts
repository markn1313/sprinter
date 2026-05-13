import { NextResponse } from "next/server";
import { newToken, requireTripActor } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

// Mint (or reuse) a passenger link for an existing trip and pin it on the
// trip row. Idempotent: if the trip already has a non-revoked, non-expired
// passenger token, we just return it instead of creating another one.
//
// Mark OR the trip's passenger may invite — lets a passenger forward the
// tracker to whoever's meeting them at the destination.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireTripActor(token, id);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = supabaseAdmin();
  const { data: trip, error: tripErr } = await sb
    .from("trips")
    .select("id,passenger_name,scheduled_at,passenger_link_token")
    .eq("id", id)
    .single();
  if (tripErr || !trip) {
    return NextResponse.json({ error: "trip not found" }, { status: 404 });
  }

  if (trip.passenger_link_token) {
    const { data: existing } = await sb
      .from("links")
      .select("token,expires_at,revoked_at")
      .eq("token", trip.passenger_link_token)
      .maybeSingle();
    const stillValid =
      existing &&
      !existing.revoked_at &&
      (!existing.expires_at || new Date(existing.expires_at).getTime() > Date.now());
    if (stillValid) {
      return NextResponse.json({ token: trip.passenger_link_token, reused: true });
    }
  }

  const newT = newToken();
  // Per-trip link expires 16 hours after the scheduled pickup.
  const expires_at = new Date(
    new Date(trip.scheduled_at).getTime() + 16 * 3600_000,
  ).toISOString();

  const { error: insertErr } = await sb.from("links").insert({
    token: newT,
    role: "passenger",
    name: trip.passenger_name,
    created_by: ctx.token,
    trip_id: id,
    expires_at,
  });
  if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

  await sb.from("trips").update({ passenger_link_token: newT }).eq("id", id);
  return NextResponse.json({ token: newT, reused: false });
}
