import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { endpoint?: string; p256dh?: string; auth?: string; user_agent?: string }
    | null;
  if (!body?.endpoint || !body.p256dh || !body.auth) {
    return NextResponse.json({ error: "missing subscription fields" }, { status: 400 });
  }

  const sb = supabaseAdmin();
  const { error } = await sb
    .from("push_subscriptions")
    .upsert(
      {
        token: ctx.token,
        endpoint: body.endpoint,
        p256dh: body.p256dh,
        auth: body.auth,
        user_agent: body.user_agent ?? null,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: "endpoint" },
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
