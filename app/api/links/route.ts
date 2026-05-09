import { NextResponse } from "next/server";
import { newToken, requireMark } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { Role } from "@/lib/types";

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { role: Role; name: string; trip_id?: string | null; expires_in_minutes?: number | null }
    | null;
  if (!body || !body.role || !body.name) {
    return NextResponse.json({ error: "missing role/name" }, { status: 400 });
  }
  if (body.role === "mark") {
    return NextResponse.json({ error: "cannot mint mark link" }, { status: 400 });
  }

  const sb = supabaseAdmin();

  // Dio and TV are singletons — reuse if already exists
  if (body.role === "dio" || body.role === "tv") {
    const existing = await sb.from("links").select("*").eq("role", body.role).is("revoked_at", null).maybeSingle();
    if (existing.data) {
      return NextResponse.json({ token: existing.data.token, reused: true });
    }
  }

  const newT = newToken();
  const expires_at =
    body.expires_in_minutes && body.expires_in_minutes > 0
      ? new Date(Date.now() + body.expires_in_minutes * 60_000).toISOString()
      : null;

  const { error } = await sb.from("links").insert({
    token: newT,
    role: body.role,
    name: body.name,
    created_by: ctx.token,
    trip_id: body.trip_id ?? null,
    expires_at,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ token: newT, reused: false });
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = supabaseAdmin();
  const { data, error } = await sb
    .from("links")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ links: data });
}
