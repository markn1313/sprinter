import { NextResponse } from "next/server";
import { requireMark } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Mark's blacklist of pickup/dropoff addresses that should NOT show up in
// the "Take me to…" quick-dispatch chips. The key is lowercased+trimmed so
// all case variants hide together.

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data } = await supabaseAdmin()
    .from("hidden_destinations")
    .select("address_key,address,hidden_at")
    .order("hidden_at", { ascending: false });
  return NextResponse.json({ hidden: data ?? [] });
}

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { address?: string } | null;
  const address = body?.address?.trim();
  if (!address) return NextResponse.json({ error: "missing address" }, { status: 400 });
  const key = address.toLowerCase();
  const { error } = await supabaseAdmin()
    .from("hidden_destinations")
    .upsert({ address_key: key, address }, { onConflict: "address_key" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, address_key: key });
}

export async function DELETE(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const address = url.searchParams.get("address")?.trim();
  if (!address) return NextResponse.json({ error: "missing address" }, { status: 400 });
  const key = address.toLowerCase();
  const { error } = await supabaseAdmin()
    .from("hidden_destinations")
    .delete()
    .eq("address_key", key);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
