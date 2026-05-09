import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { logTripEvent, upsertPassengerPrefs } from "@/lib/log";
import { sendPushToRole } from "@/lib/push";

const VALID_KINDS = [
  "cooler",
  "warmer",
  "fan_up",
  "fan_down",
  "music",
  "quiet",
  "restroom",
  "custom",
];

const CABIN_KIND_LABELS: Record<string, string> = {
  cooler: "Cooler please",
  warmer: "Warmer please",
  fan_up: "More fan",
  fan_down: "Less fan",
  music: "Play music",
  quiet: "Less music",
  restroom: "Restroom stop",
  custom: "Cabin request",
};

function cabinKindLabel(kind: string): string {
  return CABIN_KIND_LABELS[kind] ?? "Cabin request";
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { kind?: string; value?: string; trip_id?: string | null }
    | null;
  if (!body?.kind || !VALID_KINDS.includes(body.kind)) {
    return NextResponse.json({ error: "bad kind" }, { status: 400 });
  }
  const kind = body.kind;
  const value = body.value ?? null;
  const tripId = body.trip_id ?? null;

  const { data, error } = await supabaseAdmin()
    .from("cabin_requests")
    .insert({
      kind,
      value,
      trip_id: tripId,
      requested_by: ctx.token,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Audit log on the trip if scoped to one
  if (tripId) {
    logTripEvent({
      trip_id: tripId,
      kind: "cabin_request:" + kind,
      actor_token: ctx.token,
      payload: { value },
    });
  }

  // If a passenger made the request, learn from it: bump their preferred temp
  // / fan based on the request kind. Read existing prefs first so we can apply
  // a delta. If anything fails we just skip — preferences are best-effort.
  if (ctx.role === "passenger") {
    void (async () => {
      try {
        const sb = supabaseAdmin();
        const { data: existing } = await sb
          .from("passenger_prefs")
          .select("preferred_temp_f,preferred_fan,music_pref")
          .eq("token", ctx.token)
          .maybeSingle();
        const baseTemp = existing?.preferred_temp_f ?? 70;
        const baseFan = existing?.preferred_fan ?? 2;
        if (kind === "warmer") {
          upsertPassengerPrefs({ token: ctx.token, preferred_temp_f: baseTemp + 1 });
        } else if (kind === "cooler") {
          upsertPassengerPrefs({ token: ctx.token, preferred_temp_f: baseTemp - 1 });
        } else if (kind === "fan_up") {
          upsertPassengerPrefs({ token: ctx.token, preferred_fan: baseFan + 1 });
        } else if (kind === "fan_down") {
          upsertPassengerPrefs({ token: ctx.token, preferred_fan: baseFan - 1 });
        }
      } catch {
        // skip
      }
    })();
  }

  // Fire-and-forget push to the driver
  void (async () => {
    try {
      await sendPushToRole("dio", {
        title: "Cabin request",
        body: cabinKindLabel(kind),
        url: `/d/${ctx.token}?focus=cabin`,
        tag: "cabin",
      });
    } catch {
      // non-fatal
    }
  })();

  return NextResponse.json({ request: data });
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const onlyPending = url.searchParams.get("pending") === "1";
  let q = supabaseAdmin()
    .from("cabin_requests")
    .select("*")
    .order("requested_at", { ascending: false })
    .limit(40);
  if (onlyPending) q = q.is("acknowledged_at", null);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ requests: data });
}

export async function PATCH(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  // Only Dio or Mark can acknowledge
  if (ctx.role === "passenger") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  if (!body?.id) return NextResponse.json({ error: "missing id" }, { status: 400 });
  const { error } = await supabaseAdmin()
    .from("cabin_requests")
    .update({ acknowledged_at: new Date().toISOString() })
    .eq("id", body.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
