import { NextResponse } from "next/server";
import { loadSession, requireDioOrMark } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { DioStatusEmoji } from "@/lib/types";

const LABELS: Record<DioStatusEmoji, string> = {
  driving: "Driving",
  idle: "Idle",
  fueling: "Fueling",
  lunch: "On break",
  parked: "Parked",
  traffic: "In traffic",
  off: "Off shift",
};

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data } = await supabaseAdmin().from("dio_status").select("*").eq("id", 1).single();
  return NextResponse.json({ status: data });
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireDioOrMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { emoji?: DioStatusEmoji } | null;
  if (!body?.emoji || !(body.emoji in LABELS)) {
    return NextResponse.json({ error: "bad emoji" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin()
    .from("dio_status")
    .update({ emoji: body.emoji, label: LABELS[body.emoji], updated_at: new Date().toISOString() })
    .eq("id", 1)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ status: data });
}
