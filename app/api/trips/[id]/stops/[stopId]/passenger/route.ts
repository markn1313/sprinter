import { NextResponse } from "next/server";
import { newToken, requireTripActor } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { logTripEvent } from "@/lib/log";

interface Stop {
  id: string;
  kind: "pickup" | "dropoff" | "stop";
  category?: string;
  address: string;
  lat: number | null;
  lng: number | null;
  passenger?: string | null;
  passenger_link_token?: string | null;
  arrived_at?: string | null;
  added_at: string;
}

// Set (or clear) the passenger name on a specific intermediate stop, and
// auto-mint a passenger-link token tied to the parent trip when a name is
// given. The token reuses the trip's `passenger_link_token` mechanic but
// is stored per-stop on the stop record, so Mark can have N pickups along
// the same trip (e.g. picking up two friends from different houses on the
// way to dinner) and text each one their own tracking link.
//
// Idempotent: if a stop already has a non-revoked, non-expired token and
// the passed name hasn't changed, the existing token is reused. If the
// name changes the old token is revoked and a fresh one is minted (so the
// old recipient's link stops working — useful if Mark fat-fingered the
// name and wants to overwrite).
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string; stopId: string }> },
) {
  const { id, stopId } = await params;
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  // Trip-actor (Mark OR THIS trip's passenger) may tag stop-level
  // passengers and mint per-stop sub-tokens. Lets a borrowing-friend
  // who's the trip's passenger add their girlfriend at an intermediate
  // stop and text her the tracker.
  const ctx = await requireTripActor(token, id);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { name?: string | null }
    | null;
  // `name === null` (or empty string) clears the passenger + revokes the
  // token. `name === undefined` is treated as missing-payload.
  if (!body || (body.name === undefined)) {
    return NextResponse.json({ error: "missing name" }, { status: 400 });
  }
  const trimmed = typeof body.name === "string" ? body.name.trim() : null;
  const finalName = trimmed && trimmed.length > 0 ? trimmed : null;

  const sb = supabaseAdmin();
  const { data: trip, error: tripErr } = await sb
    .from("trips")
    .select("id, scheduled_at, stops")
    .eq("id", id)
    .single();
  if (tripErr || !trip) {
    return NextResponse.json({ error: "trip not found" }, { status: 404 });
  }

  const stops: Stop[] = (trip.stops as Stop[] | undefined) ?? [];
  const idx = stops.findIndex((s) => s.id === stopId);
  if (idx < 0) {
    return NextResponse.json({ error: "stop not found" }, { status: 404 });
  }
  const stop = stops[idx];

  // CLEARING the passenger: blank the name + revoke any existing token.
  if (!finalName) {
    if (stop.passenger_link_token) {
      await sb
        .from("links")
        .update({ revoked_at: new Date().toISOString() })
        .eq("token", stop.passenger_link_token);
    }
    const updated: Stop = { ...stop, passenger: null, passenger_link_token: null };
    stops[idx] = updated;
    const { error: updErr } = await sb.from("trips").update({ stops }).eq("id", id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    logTripEvent({
      trip_id: id,
      kind: "stop_passenger_cleared",
      actor_token: ctx.token,
      payload: { stop_id: stopId, prev_name: stop.passenger ?? null },
    });
    return NextResponse.json({ stop: updated, token: null });
  }

  // SETTING the passenger. Reuse an existing token if the name matches
  // and the link is still alive; otherwise revoke any old token and mint
  // a fresh one tied to this trip + stop.
  if (
    stop.passenger_link_token &&
    stop.passenger?.toLowerCase() === finalName.toLowerCase()
  ) {
    const { data: existing } = await sb
      .from("links")
      .select("token, expires_at, revoked_at")
      .eq("token", stop.passenger_link_token)
      .maybeSingle();
    const stillValid =
      existing &&
      !existing.revoked_at &&
      (!existing.expires_at || new Date(existing.expires_at).getTime() > Date.now());
    if (stillValid) {
      return NextResponse.json({ stop, token: existing!.token, reused: true });
    }
  }

  // Revoke the prior token (different name OR expired) so it can't be
  // reused by an old recipient.
  if (stop.passenger_link_token) {
    await sb
      .from("links")
      .update({ revoked_at: new Date().toISOString() })
      .eq("token", stop.passenger_link_token);
  }

  const newT = newToken();
  // Stop-level passenger link expires 16h after the trip's scheduled time,
  // matching the trip-level invite-guest endpoint. The window has to outlive
  // the actual pickup so the recipient can watch the van approach.
  const expires_at = new Date(
    new Date(trip.scheduled_at).getTime() + 16 * 3600_000,
  ).toISOString();
  const { error: insErr } = await sb.from("links").insert({
    token: newT,
    role: "passenger",
    name: finalName,
    created_by: ctx.token,
    trip_id: id,
    expires_at,
  });
  if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 });

  const updated: Stop = { ...stop, passenger: finalName, passenger_link_token: newT };
  stops[idx] = updated;
  const { error: updErr } = await sb.from("trips").update({ stops }).eq("id", id);
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });

  logTripEvent({
    trip_id: id,
    kind: "stop_passenger_set",
    actor_token: ctx.token,
    payload: { stop_id: stopId, name: finalName },
  });
  return NextResponse.json({ stop: updated, token: newT, reused: false });
}
