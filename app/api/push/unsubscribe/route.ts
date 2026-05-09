import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { endpoint?: string } | null;
  if (!body?.endpoint) {
    return NextResponse.json({ error: "missing endpoint" }, { status: 400 });
  }

  const sb = supabaseAdmin();
  // Only delete if the subscription belongs to this token
  const { error } = await sb
    .from("push_subscriptions")
    .delete()
    .eq("endpoint", body.endpoint)
    .eq("token", ctx.token);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
