import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { logTripEvent } from "@/lib/log";

export const dynamic = "force-dynamic";

// Periodic stale-state sweeper. Scheduled via vercel.json cron every
// 15 min on production. Authenticated via Vercel's CRON_SECRET header:
// Vercel cron sends Authorization: Bearer <CRON_SECRET> and we reject
// any other caller.
//
// What gets cleaned up:
//
//   1. Pre-onboard trips (scheduled / dispatched / at_pickup) whose
//      scheduled_at is more than PRE_STALE_HOURS ago. The state
//      machine never advanced them — either the trip was a test, the
//      driver bailed, or geofence never triggered. Cancel + revoke
//      any passenger links.
//
//   2. Mid-trip trips (onboard / at_dropoff) whose scheduled_at is
//      more than MID_STALE_HOURS ago. Long rides are real but 6h
//      without auto-completing is a stuck state — cancel.
//
//   3. Cabin requests unacknowledged for more than CABIN_STALE_MINUTES.
//      Don't want them blinking on Dio's screen forever.
//
// vehicle_positions are kept INDEFINITELY by design — once we
// throttled the writes (skip near-duplicate samples in the webhook +
// dropped /api/position's duplicate write entirely), the table grows
// at ~10k rows/day instead of ~159k, which means even 10 years of
// data fits inside the 8 GB Supabase Pro allowance for $0 extra.
// Keeping every Bouncie + phone GPS sample lets Mark reconstruct ANY
// trip's exact path + speed + fuel curve at any time in the future.

const PRE_STALE_HOURS = 2;
const MID_STALE_HOURS = 6;
const CABIN_STALE_MINUTES = 30;

interface StaleTrip {
  id: string;
  status: string;
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 500 });
  }
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const sb = supabaseAdmin();
  const now = new Date();
  const nowIso = now.toISOString();
  const preCutoff = new Date(now.getTime() - PRE_STALE_HOURS * 3600_000).toISOString();
  const midCutoff = new Date(now.getTime() - MID_STALE_HOURS * 3600_000).toISOString();
  const cabinCutoff = new Date(now.getTime() - CABIN_STALE_MINUTES * 60_000).toISOString();

  // 1) Stale pre-onboard trips
  const { data: pre } = await sb
    .from("trips")
    .select("id, status")
    .in("status", ["scheduled", "dispatched", "at_pickup"])
    .lt("scheduled_at", preCutoff);
  const preStale = (pre ?? []) as StaleTrip[];
  if (preStale.length > 0) {
    const ids = preStale.map((t) => t.id);
    await sb.from("trips").update({ status: "cancelled", completed_at: nowIso }).in("id", ids);
    await sb.from("links").update({ revoked_at: nowIso }).in("trip_id", ids);
    for (const t of preStale) {
      void logTripEvent({
        trip_id: t.id,
        kind: "auto_cancelled_stale",
        payload: { reason: `scheduled_at + ${PRE_STALE_HOURS}h elapsed`, prev_status: t.status },
      });
    }
  }

  // 2) Stale mid-trip trips
  const { data: mid } = await sb
    .from("trips")
    .select("id, status")
    .in("status", ["onboard", "at_dropoff"])
    .lt("scheduled_at", midCutoff);
  const midStale = (mid ?? []) as StaleTrip[];
  if (midStale.length > 0) {
    const ids = midStale.map((t) => t.id);
    await sb.from("trips").update({ status: "cancelled", completed_at: nowIso }).in("id", ids);
    await sb.from("links").update({ revoked_at: nowIso }).in("trip_id", ids);
    for (const t of midStale) {
      void logTripEvent({
        trip_id: t.id,
        kind: "auto_cancelled_stale",
        payload: { reason: `scheduled_at + ${MID_STALE_HOURS}h elapsed`, prev_status: t.status },
      });
    }
  }

  // 3) Auto-ack stale cabin requests
  const { data: ackedCabin } = await sb
    .from("cabin_requests")
    .update({ acknowledged_at: nowIso })
    .lt("requested_at", cabinCutoff)
    .is("acknowledged_at", null)
    .select("id");

  return NextResponse.json({
    ok: true,
    at: nowIso,
    cancelled_pre_onboard: preStale.length,
    cancelled_mid_trip: midStale.length,
    cabin_requests_acked: ackedCabin?.length ?? 0,
  });
}
