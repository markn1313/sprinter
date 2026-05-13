import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { logTripEvent } from "@/lib/log";
import { sendPushToRole, sendPushToTripPassenger } from "@/lib/push";

export const dynamic = "force-dynamic";

// Single shared thread for v1: Mark, Dio, and the active trip's passenger
// all live in one stream. Single-trip mode means there's only ever one
// passenger participating at a time, so cross-conversation pollution is
// minimal. Per-trip threads can be added later if it becomes noisy.
const DEFAULT_THREAD = "mark-driver";

type ChatRole = "mark" | "dio" | "passenger";

function allowed(role: string): role is ChatRole {
  return role === "mark" || role === "dio" || role === "passenger";
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!allowed(ctx.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(req.url);
  const thread = url.searchParams.get("thread") ?? DEFAULT_THREAD;
  const since = url.searchParams.get("since");

  let q = supabaseAdmin()
    .from("messages")
    .select("id,thread,sender_role,body,sent_at,read_at")
    .eq("thread", thread)
    .order("sent_at", { ascending: true })
    .limit(200);
  if (since) q = q.gt("sent_at", since);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Auto-mark messages from anyone-but-me as read.
  await supabaseAdmin()
    .from("messages")
    .update({ read_at: new Date().toISOString() })
    .eq("thread", thread)
    .neq("sender_role", ctx.role)
    .is("read_at", null);

  return NextResponse.json({ messages: data, role: ctx.role });
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!allowed(ctx.role)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { body?: string; thread?: string } | null;
  if (!body?.body || !body.body.trim()) {
    return NextResponse.json({ error: "missing body" }, { status: 400 });
  }
  const thread = body.thread ?? DEFAULT_THREAD;
  const { data, error } = await supabaseAdmin()
    .from("messages")
    .insert({
      thread,
      sender_role: ctx.role,
      sender_token: ctx.token,
      body: body.body.trim(),
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Best-effort: log against the active trip if one is in progress.
  // Also captured for the passenger-fan-out below.
  let activeTripId: string | null = null;
  try {
    const { data: activeTrip } = await supabaseAdmin()
      .from("trips")
      .select("id")
      .in("status", ["dispatched", "at_pickup", "onboard", "at_dropoff"])
      .order("scheduled_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    activeTripId = activeTrip?.id ?? null;
  } catch {
    // ignore
  }
  if (activeTripId) {
    void logTripEvent({
      trip_id: activeTripId,
      kind: "message_sent",
      actor_token: ctx.token,
      payload: {
        thread,
        sender_role: ctx.role,
        body_preview: data.body.slice(0, 80),
      },
    });
  }

  // Push every party EXCEPT the sender so all three (Mark, Dio, active
  // passenger) get the message. Passenger pushes are scoped to the
  // active trip's passenger token — there's no global "passenger" role
  // to push to since their tokens are per-trip.
  void (async () => {
    const title = ctx.role === "mark" ? "Mark" : ctx.role === "dio" ? "Driver" : "Passenger";
    const payload = {
      title,
      body: data.body.slice(0, 80),
      tag: "chat-" + thread,
    };
    const tasks: Promise<void>[] = [];
    if (ctx.role !== "mark") tasks.push(sendPushToRole("mark", payload));
    if (ctx.role !== "dio") tasks.push(sendPushToRole("dio", payload));
    if (ctx.role !== "passenger" && activeTripId) {
      tasks.push(sendPushToTripPassenger(activeTripId, payload));
    }
    try {
      await Promise.all(tasks);
    } catch {
      // non-fatal
    }
  })();

  return NextResponse.json({ message: data });
}
