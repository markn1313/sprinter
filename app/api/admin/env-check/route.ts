// Temporary diagnostic — confirm which NEXT_PUBLIC_* vars Vercel exposed to
// the running runtime. DELETE THIS ROUTE once we figure out the issue.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const mask = (v: string | undefined): string =>
    v ? `len=${v.length} prefix=${v.slice(0, 10)}` : "MISSING";
  return NextResponse.json({
    NEXT_PUBLIC_MAPBOX_TOKEN: mask(process.env.NEXT_PUBLIC_MAPBOX_TOKEN),
    MAPBOX_TOKEN: mask(process.env.MAPBOX_TOKEN),
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: mask(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY),
    NEXT_PUBLIC_SUPABASE_URL: mask(process.env.NEXT_PUBLIC_SUPABASE_URL),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: mask(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  });
}
