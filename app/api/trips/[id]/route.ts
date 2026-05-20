import { NextResponse } from "next/server";
import { requireMark, requireTripActor } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { logTripEvent } from "@/lib/log";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  // Trip-actor (Mark OR the passenger whose token is tied to THIS trip)
  // may edit pickup/dropoff/scheduled_at — single-trip-mode means there
  // is at most one trip in flight at a time and its passenger is a
  // legitimate co-controller of the trip they're riding on.
  const ctx = await requireTripActor(token, id);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // pickup_*/dropoff_* dropped 2026-05-20 — those edits route through
  // PUT /api/trips/[id]/stops now (or POST /api/destinations for adds).
  // This endpoint only handles trip-level metadata: passenger name,
  // scheduled time, notes.
  const body = (await req.json().catch(() => null)) as
    | {
        passenger_name?: string;
        scheduled_at?: string;
        notes?: string;
      }
    | null;
  if (!body) return NextResponse.json({ error: "missing body" }, { status: 400 });

  const update: Record<string, unknown> = {};
  if (typeof body.passenger_name === "string" && body.passenger_name.trim()) {
    update.passenger_name = body.passenger_name.trim();
  }
  if (typeof body.scheduled_at === "string") update.scheduled_at = body.scheduled_at;
  if (typeof body.notes === "string") update.notes = body.notes;

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "no editable fields supplied" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin()
    .from("trips")
    .update(update)
    .eq("id", id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logTripEvent({ trip_id: id, kind: "edited", actor_token: ctx.token, payload: body as Record<string, unknown> });
  // Scheduled-time / notes / passenger-name edits don't move the driver,
  // so no plan-change push — that fires from the /stops PUT instead.
  return NextResponse.json({ trip: data });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = supabaseAdmin();
  // Log BEFORE the delete so the trip_events FK still resolves.
  logTripEvent({ trip_id: id, kind: "deleted", actor_token: ctx.token });
  // Revoke any guest links pointing at this trip first
  await sb.from("links").update({ revoked_at: new Date().toISOString() }).eq("trip_id", id);
  const { error } = await sb.from("trips").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
