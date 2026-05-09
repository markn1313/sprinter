import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

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

  const { data, error } = await supabaseAdmin()
    .from("cabin_requests")
    .insert({
      kind: body.kind,
      value: body.value ?? null,
      trip_id: body.trip_id ?? null,
      requested_by: ctx.token,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
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
