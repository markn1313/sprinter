import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { getVanPosition } from "@/lib/bouncie";
import { route } from "@/lib/routing";

export const dynamic = "force-dynamic";

// Live ETA computation. Given a trip ID OR raw lat/lng target, returns the
// current drive time from van → target. Frontend can poll this every 20-30s.
//
// Note: OSRM doesn't include real-time traffic. This is duration-in-traffic-free
// conditions. Upgrade to Mapbox Directions w/ driving-traffic profile when ready.
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const tripId = url.searchParams.get("trip");
  const targetLat = url.searchParams.get("lat");
  const targetLng = url.searchParams.get("lng");
  const target = url.searchParams.get("target") ?? "pickup"; // pickup | dropoff

  let lat: number | null = null;
  let lng: number | null = null;

  if (targetLat && targetLng) {
    lat = parseFloat(targetLat);
    lng = parseFloat(targetLng);
  } else if (tripId) {
    const { data } = await supabaseAdmin()
      .from("trips")
      .select("pickup_lat,pickup_lng,dropoff_lat,dropoff_lng,status")
      .eq("id", tripId)
      .maybeSingle();
    if (data) {
      // If trip is past pickup, ETA is to dropoff. Otherwise to pickup.
      const usePickup =
        target === "pickup" &&
        data.status !== "onboard" &&
        data.status !== "at_dropoff" &&
        data.status !== "complete";
      lat = usePickup ? data.pickup_lat : data.dropoff_lat;
      lng = usePickup ? data.pickup_lng : data.dropoff_lng;
    }
  }

  if (lat == null || lng == null) {
    return NextResponse.json({ error: "no target" }, { status: 400 });
  }

  const van = await getVanPosition();
  const r = await route([
    { lat: van.lat, lng: van.lng },
    { lat, lng },
  ]);
  if (!r) {
    return NextResponse.json({
      error: "routing_unavailable",
      eta_minutes: null,
      van: { lat: van.lat, lng: van.lng, source: van.source },
    });
  }
  return NextResponse.json({
    eta_seconds: r.duration_s,
    eta_minutes: Math.round(r.duration_s / 60),
    distance_meters: r.distance_m,
    distance_miles: +(r.distance_m / 1609.34).toFixed(1),
    polyline: r.polyline,
    van: {
      lat: van.lat,
      lng: van.lng,
      heading: van.heading,
      speed_mph: van.speed_mph,
      source: van.source,
    },
    target: { lat, lng },
    traffic_aware: false, // upgrade to Mapbox driving-traffic later
  });
}
