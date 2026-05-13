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
//   4. vehicle_positions older than POSITIONS_RETENTION_DAYS. The
//      timeseries is append-only and grows ~hundreds of rows / hour
//      when Bouncie's webhook is active; prune to keep Supabase
//      storage and realtime payload sizes sane.

const PRE_STALE_HOURS = 2;
const MID_STALE_HOURS = 6;
const CABIN_STALE_MINUTES = 30;
const POSITIONS_RETENTION_DAYS = 30;

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
  const positionsCutoff = new Date(now.getTime() - POSITIONS_RETENTION_DAYS * 86400_000).toISOString();

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

  // 4) Prune old vehicle_positions. Supabase doesn't return a count
  // by default; we just delete and report based on rowsdeleted.
  const { count: prunedPositions } = await sb
    .from("vehicle_positions")
    .delete({ count: "exact" })
    .lt("recorded_at", positionsCutoff);

  return NextResponse.json({
    ok: true,
    at: nowIso,
    cancelled_pre_onboard: preStale.length,
    cancelled_mid_trip: midStale.length,
    cabin_requests_acked: ackedCabin?.length ?? 0,
    positions_pruned: prunedPositions ?? 0,
  });
}
