import { NextResponse } from "next/server";
import { requireMark } from "@/lib/auth";
import { bouncieAuthUrl } from "@/lib/bouncie";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("t") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const origin = `${url.protocol}//${url.host}`;
  const redirectUri = `${origin}/api/bouncie/callback`;
  const state = `${ctx.token}:${Date.now()}`;
  const authUrl = bouncieAuthUrl(redirectUri, state);

  return NextResponse.redirect(authUrl, 302);
}
