import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";
import { getVanPosition } from "@/lib/bouncie";
import { supabaseAdmin } from "@/lib/supabase";
import { logVehiclePosition, logTripEvent } from "@/lib/log";
import { deriveHeading } from "@/lib/bearing";

export const dynamic = "force-dynamic";

// 100m geofence — when the van enters this radius around a pickup or dropoff
// point AND the trip is in the right state, we advance status automatically.
// Saves Dio (and Mark) from tapping when his app is frozen or he's busy.
const GEOFENCE_M = 100;

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const pos = await getVanPosition();

  // Bouncie reports heading=0 on our tier. Compute a real bearing from the
  // last ~50m of vehicle_positions so the on-screen van icon points the
  // direction the van is actually going.
  if (pos.source === "bouncie" || pos.source === "bouncie_cached") {
    const derived = await deriveHeading(pos.lat, pos.lng);
    if (derived != null) pos.heading = derived;
  }

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
  // Bouncie sample. Also auto-advance trip status if the van crossed a
  // geofence (100m around pickup or dropoff).
  if (pos.source === "bouncie") {
    let activeTrip: {
      id: string;
      status: string;
      pickup_lat: number | null;
      pickup_lng: number | null;
      dropoff_lat: number | null;
      dropoff_lng: number | null;
    } | null = null;
    try {
      const { data } = await supabaseAdmin()
        .from("trips")
        .select("id,status,pickup_lat,pickup_lng,dropoff_lat,dropoff_lng")
        .in("status", ["dispatched", "at_pickup", "onboard", "at_dropoff"])
        .order("scheduled_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      activeTrip = data ?? null;
    } catch {
      // ignore
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
      trip_id: activeTrip?.id,
    });

    // Auto-advance based on geofence (best-effort, don't block response)
    if (activeTrip) {
      void (async () => {
        try {
          const sb = supabaseAdmin();
          const t = activeTrip!;
          // dispatched → at_pickup when within 100m of pickup
          if (
            t.status === "dispatched" &&
            t.pickup_lat != null &&
            t.pickup_lng != null &&
            haversineM(pos.lat, pos.lng, t.pickup_lat, t.pickup_lng) < GEOFENCE_M
          ) {
            await sb
              .from("trips")
              .update({ status: "at_pickup", arrived_at_pickup_at: new Date().toISOString() })
              .eq("id", t.id)
              .eq("status", "dispatched");
            logTripEvent({ trip_id: t.id, kind: "auto_at_pickup", payload: { reason: "geofence" } });
          }
          // onboard → at_dropoff when within 100m of dropoff
          if (
            t.status === "onboard" &&
            t.dropoff_lat != null &&
            t.dropoff_lng != null &&
            haversineM(pos.lat, pos.lng, t.dropoff_lat, t.dropoff_lng) < GEOFENCE_M
          ) {
            await sb
              .from("trips")
              .update({ status: "at_dropoff", arrived_at_dropoff_at: new Date().toISOString() })
              .eq("id", t.id)
              .eq("status", "onboard");
            logTripEvent({ trip_id: t.id, kind: "auto_at_dropoff", payload: { reason: "geofence" } });
          }
        } catch {
          // non-fatal
        }
      })();
    }
  }

  return NextResponse.json(pos);
}
