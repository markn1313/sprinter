import { NextResponse } from "next/server";
import { loadSession, requireMark } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

// Mark-only — Dio app never sees money
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { data, error } = await supabaseAdmin()
    .from("expenses")
    .select("*")
    .order("recorded_at", { ascending: false })
    .limit(100);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ expenses: data });
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx || ctx.role === "passenger") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as
    | { trip_id?: string | null; category: string; amount_cents: number; note?: string }
    | null;
  if (!body?.category || !body.amount_cents) {
    return NextResponse.json({ error: "missing fields" }, { status: 400 });
  }
  const { data, error } = await supabaseAdmin()
    .from("expenses")
    .insert({
      trip_id: body.trip_id ?? null,
      category: body.category,
      amount_cents: body.amount_cents,
      note: body.note ?? null,
      recorded_by: ctx.token,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ expense: data });
}
