import { NextResponse } from "next/server";
import { exchangeAuthCode, saveCredentials, attachVehicle } from "@/lib/bouncie";
import { loadSession } from "@/lib/auth";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";
  const markToken = state.split(":")[0];

  // Validate state's mark token
  const ctx = await loadSession(markToken);
  if (!ctx || ctx.role !== "mark") {
    return new NextResponse("Bouncie callback: invalid state", { status: 403 });
  }
  if (!code) return new NextResponse("Bouncie callback: missing code", { status: 400 });

  const origin = `${url.protocol}//${url.host}`;
  const redirectUri = `${origin}/api/bouncie/callback`;

  const tokenResp = await exchangeAuthCode(code, redirectUri);
  if (!tokenResp) {
    return new NextResponse("Bouncie token exchange failed — check server logs", { status: 502 });
  }

  await saveCredentials(tokenResp);
  await attachVehicle();

  return NextResponse.redirect(`${origin}/m/${markToken}?bouncie=connected`, 302);
}
