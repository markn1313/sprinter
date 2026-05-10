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

  // Cabin pre-set: when a trip transitions to `onboard`, look up the
  // passenger's saved climate prefs (warmer/cooler/fan delta accumulator)
  // and fire matching cabin requests so Dio sees their banner immediately.
  // No-op if no prefs saved yet — the prefs build up automatically as the
  // passenger taps cabin buttons over time.
  if (newStatus === "onboard") {
    void (async () => {
      try {
        const sb = supabaseAdmin();
        const { data: trip } = await sb
          .from("trips")
          .select("passenger_link_token")
          .eq("id", id)
          .maybeSingle();
        const pToken = trip?.passenger_link_token as string | null | undefined;
        if (!pToken) return;
        const { data: prefs } = await sb
          .from("passenger_prefs")
          .select("preferred_temp_f,preferred_fan,music_pref")
          .eq("token", pToken)
          .maybeSingle();
        if (!prefs) return;
        // Translate accumulated prefs into kind hints. We use a baseline of
        // 70°F / fan=2; deltas above/below trigger warmer/cooler/fan
        // suggestions. Single fire per onboard event so we don't spam.
        const requests: Array<{ kind: string; value?: string }> = [];
        const temp = (prefs.preferred_temp_f as number | null) ?? 70;
        const fan = (prefs.preferred_fan as number | null) ?? 2;
        if (temp >= 73) requests.push({ kind: "warmer", value: `target ${temp}°F` });
        else if (temp <= 67) requests.push({ kind: "cooler", value: `target ${temp}°F` });
        if (fan >= 4) requests.push({ kind: "fan_up", value: `target fan ${fan}` });
        else if (fan <= 1) requests.push({ kind: "fan_down", value: `target fan ${fan}` });
        if ((prefs.music_pref as string | null) === "music") requests.push({ kind: "music" });
        if ((prefs.music_pref as string | null) === "quiet") requests.push({ kind: "quiet" });
        for (const r of requests) {
          await sb.from("cabin_requests").insert({
            kind: r.kind,
            value: r.value ?? null,
            trip_id: id,
            requested_by: pToken,
          });
        }
        if (requests.length > 0) {
          logTripEvent({
            trip_id: id,
            kind: "cabin_preset",
            actor_token: ctx.token,
            payload: { auto_fired: requests.map((r) => r.kind) },
          });
        }
      } catch {
        // pre-set is best-effort; never block the action
      }
    })();
  }

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
