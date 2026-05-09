import { NextResponse } from "next/server";
import { loadSession, requireDioOrMark } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { IssueKind } from "@/lib/types";

const KINDS: IssueKind[] = ["dent", "noise", "low_tire", "battery_low", "detail", "other"];

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role === "passenger") return NextResponse.json({ issues: [] });

  const { data, error } = await supabaseAdmin()
    .from("issues")
    .select("*")
    .order("reported_at", { ascending: false })
    .limit(50);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ issues: data });
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireDioOrMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { kind?: IssueKind; note?: string } | null;
  if (!body?.kind || !KINDS.includes(body.kind)) {
    return NextResponse.json({ error: "bad kind" }, { status: 400 });
  }
  const { data, error } = await supabaseAdmin()
    .from("issues")
    .insert({ kind: body.kind, note: body.note ?? null, reported_by: ctx.token })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ issue: data });
}
