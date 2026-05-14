import { NextResponse } from "next/server";
import { newToken, requireMark } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Generic "track my van" link — not tied to any specific trip.
// Mints a passenger-role link with trip_id=null so the recipient
// lands on /p/<token> and sees the live van position, but no trip
// details (since there's no trip to show).
//
// Use case: Mark just wants somebody to see where the van is right
// now without first creating a trip. The dedicated invite-guest
// endpoint requires a trip; this one doesn't.
//
// Idempotent over a 24h window: if Mark already has an unrevoked,
// unexpired tracker link, we return it. Tapping the share button
// repeatedly re-shares the same link instead of polluting the
// links table.
//
// Mark-only. Passengers don't get to mint their own tracker links.
const TRACKER_EXPIRY_HOURS = 24;

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = supabaseAdmin();
  const now = Date.now();

  // Look for an existing tracker — passenger role + null trip_id +
  // unexpired + unrevoked. Returns the most recent one. The created_by
  // filter scopes to links Mark himself minted (so we don't accidentally
  // hand out somebody else's tracker).
  const { data: existing } = await sb
    .from("links")
    .select("token,expires_at,revoked_at")
    .eq("role", "passenger")
    .is("trip_id", null)
    .eq("created_by", ctx.token)
    .is("revoked_at", null)
    .order("expires_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (
    existing &&
    !existing.revoked_at &&
    (!existing.expires_at || new Date(existing.expires_at).getTime() > now)
  ) {
    return NextResponse.json({ token: existing.token, reused: true });
  }

  const newT = newToken();
  const expires_at = new Date(now + TRACKER_EXPIRY_HOURS * 3600_000).toISOString();
  const { error } = await sb.from("links").insert({
    token: newT,
    role: "passenger",
    name: "Van tracker",
    created_by: ctx.token,
    trip_id: null,
    expires_at,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ token: newT, reused: false });
}
