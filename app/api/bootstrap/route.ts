import { NextResponse } from "next/server";
import { newToken } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

// One-time call: POST /api/bootstrap with header X-Bootstrap-Secret
// Creates Mark's token if no Mark link exists yet, otherwise returns existing.
// Idempotent.
export async function POST(req: Request) {
  const secret = process.env.BOOTSTRAP_SECRET;
  if (!secret) return NextResponse.json({ error: "BOOTSTRAP_SECRET not set" }, { status: 500 });
  const provided = req.headers.get("x-bootstrap-secret");
  if (provided !== secret) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const sb = supabaseAdmin();
  const existing = await sb.from("links").select("*").eq("role", "mark").maybeSingle();
  if (existing.data) {
    return NextResponse.json({ ok: true, token: existing.data.token, reused: true });
  }
  const token = newToken();
  const { error } = await sb.from("links").insert({
    token,
    role: "mark",
    name: "Mark",
    created_by: null,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, token, reused: false });
}
