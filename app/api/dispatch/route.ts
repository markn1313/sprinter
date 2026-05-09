import { NextResponse } from "next/server";
import { newToken, requireMark } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { parseDispatch } from "@/lib/parse-dispatch";

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

  const parsed = parseDispatch(body.input);
  const sb = supabaseAdmin();
  const { data: trip, error } = await sb
    .from("trips")
    .insert({
      passenger_name: parsed.passengerName,
      pickup_address: parsed.pickupHint,
      dropoff_address: parsed.dropoffHint,
      scheduled_at: parsed.scheduledAt,
      notes: parsed.rawNotes,
      created_by: ctx.token,
      status: "scheduled",
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let guestToken: string | null = null;
  if (body.mintGuestLink !== false) {
    guestToken = newToken();
    await sb.from("links").insert({
      token: guestToken,
      role: "passenger",
      name: parsed.passengerName,
      created_by: ctx.token,
      trip_id: trip.id,
      // Passenger links expire 12 hours after the scheduled pickup
      expires_at: new Date(new Date(parsed.scheduledAt).getTime() + 12 * 3600_000).toISOString(),
    });
    await sb.from("trips").update({ passenger_link_token: guestToken }).eq("id", trip.id);
  }

  return NextResponse.json({ trip, parsed, guestToken });
}
