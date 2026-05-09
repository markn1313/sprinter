import { NextResponse } from "next/server";
import { loadSession, requireMark } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as
    | { lat?: number; lng?: number; accuracy_m?: number }
    | null;
  if (!body || typeof body.lat !== "number" || typeof body.lng !== "number") {
    return NextResponse.json({ error: "missing lat/lng" }, { status: 400 });
  }
  await supabaseAdmin()
    .from("mark_location")
    .update({
      lat: body.lat,
      lng: body.lng,
      accuracy_m: body.accuracy_m ?? null,
      reported_at: new Date().toISOString(),
    })
    .eq("id", 1);
  return NextResponse.json({ ok: true });
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data } = await supabaseAdmin()
    .from("mark_location")
    .select("lat,lng,accuracy_m,reported_at")
    .eq("id", 1)
    .maybeSingle();
  if (!data?.lat) return NextResponse.json({ location: null });
  return NextResponse.json({ location: data });
}
