import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { TripStatus } from "@/lib/types";
import { logTripEvent } from "@/lib/log";
import { sendPushToRole, sendPushToTripPassenger } from "@/lib/push";

type Action = "dispatch" | "at_pickup" | "onboard" | "at_dropoff" | "complete" | "cancel";

const NEXT_STATUS: Record<Action, TripStatus> = {
  dispatch: "dispatched",
  at_pickup: "at_pickup",
  onboard: "onboard",
  at_dropoff: "at_dropoff",
  complete: "complete",
  cancel: "cancelled",
};

const TIMESTAMP_FIELD: Record<Action, string | null> = {
  dispatch: "dispatched_at",
  at_pickup: "arrived_at_pickup_at",
  onboard: "onboard_at",
  at_dropoff: "arrived_at_dropoff_at",
  complete: "completed_at",
  cancel: null,
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // Only Mark and Dio can advance a trip
  if (ctx.role !== "mark" && ctx.role !== "dio") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { action?: Action } | null;
  const action = body?.action;
  if (!action || !(action in NEXT_STATUS)) {
    return NextResponse.json({ error: "bad action" }, { status: 400 });
  }

  const sb = supabaseAdmin();
  const update: Record<string, string | number | null> = {
    status: NEXT_STATUS[action],
  };
  const ts = TIMESTAMP_FIELD[action];
  if (ts) update[ts] = new Date().toISOString();

  // On complete, compute actual_minutes and driver_pay_cents
  if (action === "complete") {
    const { data: trip } = await sb.from("trips").select("dispatched_at").eq("id", id).single();
    const { data: settings } = await sb.from("dio_settings").select("hourly_rate_cents").eq("id", 1).single();
    const startIso = trip?.dispatched_at ?? new Date().toISOString();
    const minutes = Math.max(1, Math.round((Date.now() - new Date(startIso).getTime()) / 60_000));
    update.actual_minutes = minutes;
    const rate = settings?.hourly_rate_cents ?? 3500;
    update.driver_pay_cents = Math.round((minutes / 60) * rate);
  }

  const { data, error } = await sb.from("trips").update(update).eq("id", id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const newStatus = NEXT_STATUS[action];
  logTripEvent({ trip_id: id, kind: "status:" + newStatus, actor_token: ctx.token });

  // Fire-and-forget push notifications based on the new status. Mark
  // initiated `dispatched` himself so we skip pushing him on that one.
  void (async () => {
    try {
      if (newStatus === "at_pickup") {
        await Promise.allSettled([
          sendPushToRole("mark", { title: "Driver has arrived", body: "The van is at pickup.", tag: "trip-" + id }),
          sendPushToTripPassenger(id, { title: "Driver has arrived", body: "Your ride is here.", tag: "trip-" + id }),
        ]);
      } else if (newStatus === "onboard") {
        await sendPushToRole("mark", { title: "Onboard", body: "Passenger is on board.", tag: "trip-" + id });
      } else if (newStatus === "at_dropoff") {
        await Promise.allSettled([
          sendPushToRole("mark", { title: "Arrived at destination", body: "Trip has reached the dropoff.", tag: "trip-" + id }),
          sendPushToTripPassenger(id, { title: "Arrived at destination", body: "You're here.", tag: "trip-" + id }),
        ]);
      } else if (newStatus === "complete") {
        await sendPushToRole("mark", { title: "Trip complete", body: "Driver has marked the trip complete.", tag: "trip-" + id });
      }
    } catch {
      // pushes never break the API request
    }
  })();

  return NextResponse.json({ trip: data });
}
