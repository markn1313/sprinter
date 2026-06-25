import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { timingSafeEqual } from "crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { Link } from "@/lib/types";

export const dynamic = "force-dynamic";

export const SESSION_COOKIE = "sprinter_session";
const MAX_AGE = 60 * 60 * 24 * 90; // 90 days

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Password login for the root page. On the correct password we mint a session
// cookie holding the active Mark link token and bounce the client to /m/<token>.
// The token is the real credential the dashboard checks (see lib/auth), so the
// cookie is httpOnly to keep it out of client-side JS.
export async function POST(req: Request) {
  const expectedPassword = process.env.SPRINTER_PASSWORD;
  const expectedUsername = process.env.SPRINTER_USERNAME || "mark";
  if (!expectedPassword) {
    return NextResponse.json({ error: "Login is not configured yet." }, { status: 500 });
  }

  let username = "";
  let password = "";
  try {
    const body = await req.json();
    username = typeof body?.username === "string" ? body.username : "";
    password = typeof body?.password === "string" ? body.password : "";
  } catch {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  // Username compare is case-insensitive; password is exact, constant-time.
  const okUser = safeEqual(username.trim().toLowerCase(), expectedUsername.toLowerCase());
  const okPass = !!password && safeEqual(password, expectedPassword);
  if (!okUser || !okPass) {
    return NextResponse.json({ error: "Incorrect username or password" }, { status: 401 });
  }

  // Use the newest active Mark link as the session token, so this keeps working
  // even if the link is ever rotated.
  const sb = supabaseAdmin();
  const { data } = await sb
    .from("links")
    .select("*")
    .eq("role", "mark")
    .is("revoked_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const link = data as Link | null;
  if (!link) {
    return NextResponse.json({ error: "No dashboard link found." }, { status: 500 });
  }

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, link.token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });

  return NextResponse.json({ ok: true, token: link.token });
}

// Logout: clear the session cookie.
export async function DELETE() {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return NextResponse.json({ ok: true });
}
