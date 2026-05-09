import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";
import { getVanPosition } from "@/lib/bouncie";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const pos = await getVanPosition();

  // Also persist latest so realtime subscribers (other dashboards) get pushed
  try {
    await supabaseAdmin()
      .from("van_position")
      .update({
        lat: pos.lat,
        lng: pos.lng,
        heading: pos.heading,
        speed_mph: pos.speed_mph,
        fuel_pct: pos.fuel_pct,
        battery_v: pos.battery_v,
        mileage: pos.mileage,
        ignition: pos.ignition,
        source: pos.source,
        updated_at: pos.updated_at,
      })
      .eq("id", 1);
  } catch {
    // non-fatal
  }

  return NextResponse.json(pos);
}
