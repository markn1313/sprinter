import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { getVanPosition } from "@/lib/bouncie";
import { route, nextManeuver, STOP_WAIT_SECONDS } from "@/lib/routing";

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
  // Every waypoint in `wp` except the last (final destination) is a place
  // the van stops at long enough to pick up / drop off — boarding takes
  // real time and ETAs that ignore it are wrong by 2-4 min on multi-stop
  // trips. The next-waypoint ETA gets no wait because the van hasn't
  // reached it yet.
  const finalWaitS = Math.max(0, wp.length - 1) * STOP_WAIT_SECONDS;
  const finalSecsWithWait = rFinal ? rFinal.duration_s + finalWaitS : null;
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
          congestion: rNext.congestion ?? null,
          traffic_aware: rNext.source === "mapbox-traffic",
        }
      : null,
    to_final: rFinal && finalSecsWithWait != null
      ? {
          kind: wp[wp.length - 1].kind ?? "dropoff",
          label: wp[wp.length - 1].label ?? "",
          eta_seconds: finalSecsWithWait,
          eta_minutes: Math.round(finalSecsWithWait / 60),
          drive_seconds: rFinal.duration_s,
          wait_seconds: finalWaitS,
          distance_miles: +(rFinal.distance_m / 1609.34).toFixed(1),
          polyline: rFinal.polyline,
          congestion: rFinal.congestion ?? null,
          traffic_aware: rFinal.source === "mapbox-traffic",
        }
      : null,
    eta_minutes: rNext ? Math.round(rNext.duration_s / 60) : null,
    eta_seconds: rNext ? rNext.duration_s : null,
    distance_miles: rNext ? +(rNext.distance_m / 1609.34).toFixed(1) : null,
    polyline: rFinal?.polyline ?? rNext?.polyline ?? null,
    congestion: rFinal?.congestion ?? rNext?.congestion ?? null,
    next_maneuver: rFinal?.steps ? nextManeuver(origin.lng, origin.lat, rFinal.steps) : null,
    traffic_aware: (rNext?.source === "mapbox-traffic") || (rFinal?.source === "mapbox-traffic"),
  });
}

interface TripWaypoints {
  status: string;
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
    .select("status,stops")
    .eq("id", tripId)
    .maybeSingle();
  if (!trip) return NextResponse.json({ error: "trip not found" }, { status: 404 });
  const t = trip as TripWaypoints;
  const origin = await originForCaller(ctx.role);

  const upcoming: Array<{ kind: "pickup" | "stop" | "dropoff"; lat: number; lng: number; label: string }> = [];

  // Destinations-as-chain: trip.stops[] is the single source of truth.
  // Every un-arrived stop is a future waypoint; the LAST stop is the
  // final destination (kind="dropoff"); stops with a passenger name
  // render as a pickup teardrop; everything else is a numbered stop.
  const stopsRaw = (t.stops as (StopRow & { arrived_at?: string | null; passenger?: string | null })[] | null) ?? [];
  const lastIdx = stopsRaw.length - 1;
  stopsRaw.forEach((s, idx) => {
    if (s.lat == null || s.lng == null) return;
    if (s.arrived_at) return;
    const isFinal = idx === lastIdx;
    const isPickup = !isFinal && !!s.passenger;
    const kind: "pickup" | "stop" | "dropoff" = isFinal ? "dropoff" : isPickup ? "pickup" : "stop";
    upcoming.push({ kind, lat: s.lat, lng: s.lng, label: s.address });
  });

  if (upcoming.length === 0) {
    // Include `upcoming: []` so clients can distinguish "no remaining
    // waypoints" (don't show any waypoint pins) from "ETA not loaded
    // yet" (missing key — fall back to trip fields). Previously this
    // omitted the field and clients triggered their stale-trip-fields
    // fallback, redrawing the arrived pickup as a still-active pin.
    return NextResponse.json({
      van: { lat: origin.lat, lng: origin.lng, source: origin.source },
      upcoming: [],
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

  // 2 min per stop (pickup + every intermediate stop) on the way to the
  // final dropoff. The last waypoint IS the final destination so we don't
  // wait there. `to_next` stays driving-only because the van hasn't pulled
  // up to a curb yet.
  const finalWaitS = Math.max(0, upcoming.length - 1) * STOP_WAIT_SECONDS;
  const finalSecsWithWait = rFinal ? rFinal.duration_s + finalWaitS : null;

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
          congestion: rNext.congestion ?? null,
          traffic_aware: rNext.source === "mapbox-traffic",
        }
      : null,
    to_final: rFinal && finalSecsWithWait != null
      ? {
          kind: upcoming[upcoming.length - 1].kind,
          label: upcoming[upcoming.length - 1].label,
          eta_seconds: finalSecsWithWait,
          eta_minutes: Math.round(finalSecsWithWait / 60),
          drive_seconds: rFinal.duration_s,
          wait_seconds: finalWaitS,
          distance_meters: rFinal.distance_m,
          distance_miles: +(rFinal.distance_m / 1609.34).toFixed(1),
          polyline: rFinal.polyline,
          congestion: rFinal.congestion ?? null,
          traffic_aware: rFinal.source === "mapbox-traffic",
        }
      : null,
    // Backwards-compat (existing useEta hook)
    eta_minutes: rNext ? Math.round(rNext.duration_s / 60) : null,
    eta_seconds: rNext ? rNext.duration_s : null,
    distance_miles: rNext ? +(rNext.distance_m / 1609.34).toFixed(1) : null,
    polyline: rFinal?.polyline ?? rNext?.polyline ?? null,
    congestion: rFinal?.congestion ?? rNext?.congestion ?? null,
    next_maneuver: rFinal?.steps ? nextManeuver(origin.lng, origin.lat, rFinal.steps) : null,
    traffic_aware: (rNext?.source === "mapbox-traffic") || (rFinal?.source === "mapbox-traffic"),
  });
}
