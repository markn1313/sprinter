import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { getVanPosition } from "@/lib/bouncie";
import { route, nextManeuver } from "@/lib/routing";

export const dynamic = "force-dynamic";

// Pick the routing origin based on caller's role. Driver routes from his own
// phone GPS so ETA includes his commute to the van. Mark / passengers route
// from the van. Falls back to van GPS if driver location is missing/stale.
async function originForCaller(role: string): Promise<{
  lat: number;
  lng: number;
  source: "driver" | "bouncie" | "bouncie_cached" | "mock";
  heading?: number;
  speed_mph?: number;
}> {
  if (role === "dio") {
    const { data } = await supabaseAdmin()
      .from("driver_location")
      .select("lat,lng,reported_at")
      .eq("id", 1)
      .maybeSingle();
    const fresh =
      data?.lat != null &&
      data?.lng != null &&
      data?.reported_at &&
      Date.now() - new Date(data.reported_at).getTime() < 10 * 60_000;
    if (fresh) {
      return { lat: data!.lat as number, lng: data!.lng as number, source: "driver" };
    }
  }
  const van = await getVanPosition();
  return {
    lat: van.lat,
    lng: van.lng,
    heading: van.heading,
    speed_mph: van.speed_mph,
    source: van.source,
  };
}

interface StopRow {
  id: string;
  lat: number | null;
  lng: number | null;
  address: string;
}

// POST: preview ETA against an explicit list of upcoming waypoints. Used by the
// trip-detail editor so live ETA reflects locally-staged stop changes BEFORE
// they're pushed to the driver.
export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { waypoints?: Array<{ lat: number; lng: number; label?: string; kind?: string }> }
    | null;
  const wp = (body?.waypoints ?? []).filter(
    (p) => typeof p?.lat === "number" && typeof p?.lng === "number",
  );
  const origin = await originForCaller(ctx.role);
  if (wp.length === 0) {
    return NextResponse.json({
      van: { lat: origin.lat, lng: origin.lng, source: origin.source },
      to_next: null,
      to_final: null,
    });
  }
  const next = wp[0];
  const [rNext, rFinal] = await Promise.all([
    route([{ lat: origin.lat, lng: origin.lng }, { lat: next.lat, lng: next.lng }]),
    route([{ lat: origin.lat, lng: origin.lng }, ...wp.map((p) => ({ lat: p.lat, lng: p.lng }))]),
  ]);
  return NextResponse.json({
    van: { lat: origin.lat, lng: origin.lng, heading: origin.heading, speed_mph: origin.speed_mph, source: origin.source },
    to_next: rNext
      ? {
          kind: next.kind ?? "stop",
          label: next.label ?? "",
          eta_seconds: rNext.duration_s,
          eta_minutes: Math.round(rNext.duration_s / 60),
          distance_miles: +(rNext.distance_m / 1609.34).toFixed(1),
          polyline: rNext.polyline,
          traffic_aware: rNext.source === "mapbox-traffic",
        }
      : null,
    to_final: rFinal
      ? {
          kind: wp[wp.length - 1].kind ?? "dropoff",
          label: wp[wp.length - 1].label ?? "",
          eta_seconds: rFinal.duration_s,
          eta_minutes: Math.round(rFinal.duration_s / 60),
          distance_miles: +(rFinal.distance_m / 1609.34).toFixed(1),
          polyline: rFinal.polyline,
          traffic_aware: rFinal.source === "mapbox-traffic",
        }
      : null,
    eta_minutes: rNext ? Math.round(rNext.duration_s / 60) : null,
    eta_seconds: rNext ? rNext.duration_s : null,
    distance_miles: rNext ? +(rNext.distance_m / 1609.34).toFixed(1) : null,
    polyline: rFinal?.polyline ?? rNext?.polyline ?? null,
    next_maneuver: rFinal?.steps ? nextManeuver(origin.lng, origin.lat, rFinal.steps) : null,
    traffic_aware: (rNext?.source === "mapbox-traffic") || (rFinal?.source === "mapbox-traffic"),
  });
}

interface TripWaypoints {
  status: string;
  pickup_lat: number | null;
  pickup_lng: number | null;
  pickup_address: string | null;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  dropoff_address: string | null;
  stops: StopRow[] | null;
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const tripId = url.searchParams.get("trip");
  const targetLat = url.searchParams.get("lat");
  const targetLng = url.searchParams.get("lng");

  // Direct lat/lng path — single ETA only
  if (targetLat && targetLng) {
    const lat = parseFloat(targetLat);
    const lng = parseFloat(targetLng);
    const origin = await originForCaller(ctx.role);
    const r = await route([
      { lat: origin.lat, lng: origin.lng },
      { lat, lng },
    ]);
    if (!r) {
      return NextResponse.json({
        eta_minutes: null,
        van: { lat: origin.lat, lng: origin.lng, source: origin.source },
      });
    }
    return NextResponse.json({
      eta_seconds: r.duration_s,
      eta_minutes: Math.round(r.duration_s / 60),
      distance_meters: r.distance_m,
      distance_miles: +(r.distance_m / 1609.34).toFixed(1),
      polyline: r.polyline,
      van: { lat: origin.lat, lng: origin.lng, heading: origin.heading, speed_mph: origin.speed_mph, source: origin.source },
      target: { lat, lng },
      traffic_aware: r.source === "mapbox-traffic",
    });
  }

  if (!tripId) return NextResponse.json({ error: "no target" }, { status: 400 });

  const { data: trip } = await supabaseAdmin()
    .from("trips")
    .select("status,pickup_lat,pickup_lng,pickup_address,dropoff_lat,dropoff_lng,dropoff_address,stops")
    .eq("id", tripId)
    .maybeSingle();
  if (!trip) return NextResponse.json({ error: "trip not found" }, { status: 404 });
  const t = trip as TripWaypoints;
  const origin = await originForCaller(ctx.role);

  const upcoming: Array<{ kind: "pickup" | "stop" | "dropoff"; lat: number; lng: number; label: string }> = [];

  // Build the upcoming-waypoint sequence based on trip status
  // - scheduled / dispatched / at_pickup → start with pickup (if not yet there), then stops, then dropoff
  // - onboard → skip pickup; stops + dropoff
  // - at_dropoff / complete → just dropoff
  let includePickup = t.status === "scheduled" || t.status === "dispatched";

  // "Take me home" / Quick-Dispatch / pick-me-up flows write pickup_address as
  // the sentinel "My current location" with the van's lat/lng at dispatch.
  // Mark is already in the van — there is no pickup leg to drive. The trip
  // never auto-advances out of `scheduled`, so without this guard the route
  // doubles back: van NOW → pickup (where van WAS at dispatch) → dropoff.
  // Once the van has moved >400 m away from the recorded pickup point, drop
  // pickup so the route, ETA, and map-fit reflect "current location → dropoff."
  if (includePickup && t.pickup_lat != null && t.pickup_lng != null && t.pickup_address) {
    const sentinel = /current\s+location|my\s+location|mark.?s\s+location/i.test(t.pickup_address);
    if (sentinel) {
      const R = 6_371_000;
      const toRad = (d: number) => (d * Math.PI) / 180;
      const dLat = toRad(t.pickup_lat - origin.lat);
      const dLng = toRad(t.pickup_lng - origin.lng);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(origin.lat)) * Math.cos(toRad(t.pickup_lat)) * Math.sin(dLng / 2) ** 2;
      const distM = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      if (distM > 400) includePickup = false;
    }
  }
  if (includePickup && t.pickup_lat != null && t.pickup_lng != null) {
    upcoming.push({ kind: "pickup", lat: t.pickup_lat, lng: t.pickup_lng, label: t.pickup_address ?? "Pickup" });
  }
  const stops = (t.stops as StopRow[] | null) ?? [];
  stops.forEach((s) => {
    if (s.lat != null && s.lng != null) upcoming.push({ kind: "stop", lat: s.lat, lng: s.lng, label: s.address });
  });
  if (t.dropoff_lat != null && t.dropoff_lng != null) {
    upcoming.push({ kind: "dropoff", lat: t.dropoff_lat, lng: t.dropoff_lng, label: t.dropoff_address ?? "Dropoff" });
  }

  if (upcoming.length === 0) {
    return NextResponse.json({
      van: { lat: origin.lat, lng: origin.lng, source: origin.source },
      to_next: null,
      to_final: null,
    });
  }

  // Compute origin → next AND origin → through-all-waypoints
  const next = upcoming[0];
  const [rNext, rFinal] = await Promise.all([
    route([{ lat: origin.lat, lng: origin.lng }, { lat: next.lat, lng: next.lng }]),
    route([{ lat: origin.lat, lng: origin.lng }, ...upcoming.map((u) => ({ lat: u.lat, lng: u.lng }))]),
  ]);

  return NextResponse.json({
    van: { lat: origin.lat, lng: origin.lng, heading: origin.heading, speed_mph: origin.speed_mph, source: origin.source },
    upcoming,
    to_next: rNext
      ? {
          kind: next.kind,
          label: next.label,
          eta_seconds: rNext.duration_s,
          eta_minutes: Math.round(rNext.duration_s / 60),
          distance_meters: rNext.distance_m,
          distance_miles: +(rNext.distance_m / 1609.34).toFixed(1),
          polyline: rNext.polyline,
          traffic_aware: rNext.source === "mapbox-traffic",
        }
      : null,
    to_final: rFinal
      ? {
          kind: upcoming[upcoming.length - 1].kind,
          label: upcoming[upcoming.length - 1].label,
          eta_seconds: rFinal.duration_s,
          eta_minutes: Math.round(rFinal.duration_s / 60),
          distance_meters: rFinal.distance_m,
          distance_miles: +(rFinal.distance_m / 1609.34).toFixed(1),
          polyline: rFinal.polyline,
          traffic_aware: rFinal.source === "mapbox-traffic",
        }
      : null,
    // Backwards-compat (existing useEta hook)
    eta_minutes: rNext ? Math.round(rNext.duration_s / 60) : null,
    eta_seconds: rNext ? rNext.duration_s : null,
    distance_miles: rNext ? +(rNext.distance_m / 1609.34).toFixed(1) : null,
    polyline: rFinal?.polyline ?? rNext?.polyline ?? null,
    next_maneuver: rFinal?.steps ? nextManeuver(origin.lng, origin.lat, rFinal.steps) : null,
    traffic_aware: (rNext?.source === "mapbox-traffic") || (rFinal?.source === "mapbox-traffic"),
  });
}
