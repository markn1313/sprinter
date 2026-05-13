import { NextResponse } from "next/server";
import { requireMark } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { logTripEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

// Manual escape hatch — Mark spots a stale / mistakenly-created trip
// and wants to clear it NOW instead of waiting for the cron sweep.
// Mark-only for v1: passengers and Dio shouldn't be able to cancel
// trips they're riding on / driving without an out-of-band conversation
// first. If we want to widen later, swap to requireTripActor.
//
// Same effect as the cron's auto-cancel: status → cancelled, attached
// passenger links revoked, trip_events row stamped.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = supabaseAdmin();
  const now = new Date().toISOString();
  // Only flip if it's still alive — avoids overwriting a real
  // completed_at on a finished trip.
  const { error } = await sb
    .from("trips")
    .update({ status: "cancelled", completed_at: now })
    .eq("id", id)
    .not("status", "in", "(complete,cancelled)");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  await sb.from("links").update({ revoked_at: now }).eq("trip_id", id);
  void logTripEvent({
    trip_id: id,
    kind: "cancelled",
    actor_token: ctx.token,
    payload: { manual: true },
  });
  return NextResponse.json({ ok: true });
}
