import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";
import { getVanPosition } from "@/lib/bouncie";
import { supabaseAdmin } from "@/lib/supabase";
import { logVehiclePosition } from "@/lib/log";

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

  // Fire-and-forget: append to vehicle_positions timeseries when we got a real
  // Bouncie sample. Look up the active trip id (if any) to scope the row.
  if (pos.source === "bouncie") {
    let activeTripId: string | undefined;
    try {
      const { data: activeTrip } = await supabaseAdmin()
        .from("trips")
        .select("id")
        .in("status", ["dispatched", "at_pickup", "onboard", "at_dropoff"])
        .order("scheduled_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      activeTripId = activeTrip?.id ?? undefined;
    } catch {
      // ignore — log without trip_id
    }
    logVehiclePosition({
      source: "bouncie",
      lat: pos.lat,
      lng: pos.lng,
      heading: pos.heading,
      speed_mph: pos.speed_mph,
      fuel_pct: pos.fuel_pct,
      ignition: pos.ignition,
      mileage: pos.mileage,
      trip_id: activeTripId,
    });
  }

  return NextResponse.json(pos);
}
