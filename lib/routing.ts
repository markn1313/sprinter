// Mapbox Directions API with driving-traffic profile (real-time traffic).
// Falls back to OSRM if MAPBOX_TOKEN is not set.

export interface RouteStep {
  instruction: string; // e.g. "Take exit 39A toward Inglewood Blvd"
  type: string; // 'turn' | 'merge' | 'fork' | 'on ramp' | 'off ramp' | 'roundabout' | 'arrive' | …
  modifier?: string; // 'left' | 'right' | 'sharp left' | 'slight right' | 'straight' | …
  distance_m: number; // meters from this maneuver to the NEXT one
  duration_s: number;
  location: [number, number]; // [lng, lat] of the maneuver point
  street_name?: string; // road being entered after this maneuver
}

// Per-segment congestion. Length = coordinates.length - 1, one entry per
// LineString segment between consecutive points. Mapbox returns
// "low" | "moderate" | "heavy" | "severe" | "unknown". OSRM doesn't
// provide congestion so this is undefined for the fallback path.
export type CongestionLevel = "low" | "moderate" | "heavy" | "severe" | "unknown";

export interface RouteResult {
  polyline: string; // encoded polyline (precision 5)
  distance_m: number;
  duration_s: number;
  duration_in_traffic_s: number | null;
  geometry: { type: "LineString"; coordinates: [number, number][] };
  steps: RouteStep[]; // empty array if not requested or unavailable
  congestion?: CongestionLevel[];
  source: "mapbox-traffic" | "osrm";
}

export interface Waypoint {
  lat: number;
  lng: number;
}

export async function route(waypoints: Waypoint[]): Promise<RouteResult | null> {
  if (waypoints.length < 2) return null;
  const mapboxToken = process.env.MAPBOX_TOKEN;
  if (mapboxToken) {
    const r = await routeMapbox(waypoints, mapboxToken);
    if (r) return r;
    console.warn("[routing] Mapbox unavailable — falling back to OSRM");
  } else {
    console.warn("[routing] MAPBOX_TOKEN not set in env");
  }
  return routeOsrm(waypoints);
}

async function routeMapbox(waypoints: Waypoint[], token: string): Promise<RouteResult | null> {
  // Mapbox cap: 25 coordinates per request, fine for our use
  const coords = waypoints.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(";");
  // Request steps so we can render turn-by-turn maneuvers on the TV / Mark
  // home cards. `language=en` keeps instructions in English.
  // `annotations=congestion` adds a per-segment congestion level so the route
  // polyline can be rendered green/amber/red instead of one solid color.
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/${coords}?access_token=${token}&geometries=geojson&overview=full&steps=true&annotations=congestion&language=en`;
  try {
    // The pk.* Mapbox token is URL-allowlist-gated by Referer. Browser
    // calls pass automatically; server-side fetches send no Referer and
    // get 403 Forbidden — quietly falling back to OSRM with no traffic
    // congestion data. Set the Referer to our production origin so the
    // allowlist check passes for server-to-server calls too.
    const referer = process.env.MAPBOX_REFERER ?? "https://sprinter-tau.vercel.app/";
    const res = await fetch(url, {
      cache: "no-store",
      headers: { Referer: referer },
    });
    if (!res.ok) {
      console.warn("[routing] Mapbox failed", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    interface MapboxStep {
      maneuver: {
        instruction: string;
        type?: string;
        modifier?: string;
        location: [number, number];
      };
      distance: number;
      duration: number;
      name?: string;
    }
    interface MapboxLeg {
      steps: MapboxStep[];
      annotation?: { congestion?: string[] };
    }
    const data = (await res.json()) as {
      code: string;
      routes: Array<{
        distance: number;
        duration: number;
        duration_typical?: number;
        geometry: { type: "LineString"; coordinates: [number, number][] };
        legs?: MapboxLeg[];
      }>;
    };
    if (data.code !== "Ok" || !data.routes[0]) return null;
    const r = data.routes[0];
    const steps: RouteStep[] = [];
    // Concatenate per-leg congestion arrays. Mapbox returns one entry per
    // segment (between consecutive geometry points), so the total length
    // equals coordinates.length - 1 across all legs.
    const congestion: CongestionLevel[] = [];
    const ALLOWED: CongestionLevel[] = ["low", "moderate", "heavy", "severe", "unknown"];
    for (const leg of r.legs ?? []) {
      for (const s of leg.steps ?? []) {
        steps.push({
          instruction: s.maneuver.instruction,
          type: s.maneuver.type ?? "",
          modifier: s.maneuver.modifier,
          distance_m: Math.round(s.distance),
          duration_s: Math.round(s.duration),
          location: s.maneuver.location,
          street_name: s.name,
        });
      }
      if (leg.annotation?.congestion) {
        for (const c of leg.annotation.congestion) {
          congestion.push(
            (ALLOWED.includes(c as CongestionLevel) ? c : "unknown") as CongestionLevel,
          );
        }
      }
    }
    return {
      polyline: encodePolyline(r.geometry.coordinates),
      distance_m: Math.round(r.distance),
      duration_s: Math.round(r.duration),
      duration_in_traffic_s: Math.round(r.duration),
      geometry: r.geometry,
      steps,
      congestion: congestion.length > 0 ? congestion : undefined,
      source: "mapbox-traffic",
    };
  } catch (err) {
    console.warn("[routing] Mapbox threw:", (err as Error).message);
    return null;
  }
}

// Solve the optimal visit order between a fixed start (pickup) and fixed
// end (dropoff) given N intermediate waypoints, using Mapbox's Optimized
// Trips API. Returns the input waypoints[] reordered so the total drive
// time is minimized. Useful when Mark drops several stops on the map and
// trusts the system to sequence them sanely without making him think
// about it.
//
// Inputs:
//   start    — pickup / starting point of the trip
//   end      — dropoff / final destination
//   waypoints — array of intermediate stops (no need for any particular order)
//
// Returns `null` if the API call fails or no permutation could be found,
// in which case the caller should fall back to the user-provided order.
export async function optimizeStops(
  start: Waypoint,
  end: Waypoint,
  waypoints: Waypoint[],
): Promise<Waypoint[] | null> {
  // Mapbox Optimized Trips accepts 2-12 coordinates total. With 0 or 1
  // intermediate stop there's nothing to optimize.
  if (waypoints.length === 0) return [];
  if (waypoints.length === 1) return [...waypoints];
  const token = process.env.MAPBOX_TOKEN;
  if (!token) return null;
  const coords = [start, ...waypoints, end]
    .map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`)
    .join(";");
  // source=first + destination=last locks the pickup and dropoff in place
  // so only the intermediate stops get permuted. roundtrip=false because
  // the trip isn't a loop.
  const url = `https://api.mapbox.com/optimized-trips/v1/mapbox/driving-traffic/${coords}?access_token=${token}&source=first&destination=last&roundtrip=false&geometries=geojson`;
  try {
    const referer = process.env.MAPBOX_REFERER ?? "https://sprinter-tau.vercel.app/";
    const res = await fetch(url, { headers: { Referer: referer }, cache: "no-store" });
    if (!res.ok) {
      console.warn("[routing] Optimized-Trips failed", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const data = (await res.json()) as {
      code: string;
      waypoints?: Array<{ waypoint_index: number; trips_index: number; location: [number, number] }>;
    };
    if (data.code !== "Ok" || !Array.isArray(data.waypoints)) return null;
    // data.waypoints is indexed by the INPUT order (0 = start, 1..N = our
    // intermediate stops, N+1 = end). Each entry has a `waypoint_index`
    // telling us where Mapbox decided to visit it on the optimized trip.
    // We re-sort the intermediates by waypoint_index to get the new order.
    const intermediates = data.waypoints.slice(1, -1);
    const ordered = intermediates
      .map((wp, originalIdx) => ({ waypoint_index: wp.waypoint_index, original: waypoints[originalIdx] }))
      .sort((a, b) => a.waypoint_index - b.waypoint_index)
      .map((x) => x.original);
    return ordered;
  } catch (err) {
    console.warn("[routing] Optimized-Trips threw:", (err as Error).message);
    return null;
  }
}

async function routeOsrm(waypoints: Waypoint[]): Promise<RouteResult | null> {
  const coords = waypoints.map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      code: string;
      routes: Array<{
        distance: number;
        duration: number;
        geometry: { type: "LineString"; coordinates: [number, number][] };
      }>;
    };
    if (data.code !== "Ok" || !data.routes[0]) return null;
    const r = data.routes[0];
    return {
      polyline: encodePolyline(r.geometry.coordinates),
      distance_m: Math.round(r.distance),
      duration_s: Math.round(r.duration),
      duration_in_traffic_s: null,
      geometry: r.geometry,
      steps: [],
      source: "osrm",
    };
  } catch {
    return null;
  }
}

// Find the step we're currently in: the one whose maneuver point is closest
// AHEAD of the van. We approximate by finding the nearest geometry vertex to
// the van, then mapping it to the step that contains it.
export function nextManeuver(
  vanLng: number,
  vanLat: number,
  steps: RouteStep[],
): { step: RouteStep; meters_to: number } | null {
  if (steps.length === 0) return null;
  // Find closest step location
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < steps.length; i++) {
    const [sLng, sLat] = steps[i].location;
    const d = haversine(vanLat, vanLng, sLat, sLng);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  if (best < 0) return null;
  // The "next" maneuver is the one we haven't reached yet. If we're past the
  // closest one (within 30m), step forward.
  const nextIdx = bestDist < 30 && best + 1 < steps.length ? best + 1 : best;
  const target = steps[nextIdx];
  const distance = haversine(vanLat, vanLng, target.location[1], target.location[0]);
  return { step: target, meters_to: distance };
}

export function projectAlongRoute(
  geometry: { coordinates: [number, number][] },
  totalDurationS: number,
  totalDistanceM: number,
  seconds: number,
): { lat: number; lng: number; remaining_s: number } | null {
  if (geometry.coordinates.length < 2 || totalDurationS <= 0 || totalDistanceM <= 0) return null;
  const targetMeters = (seconds / totalDurationS) * totalDistanceM;
  let acc = 0;
  for (let i = 1; i < geometry.coordinates.length; i++) {
    const a = geometry.coordinates[i - 1];
    const b = geometry.coordinates[i];
    const seg = haversine(a[1], a[0], b[1], b[0]);
    if (acc + seg >= targetMeters) {
      const remain = targetMeters - acc;
      const t = seg === 0 ? 0 : remain / seg;
      const lng = a[0] + (b[0] - a[0]) * t;
      const lat = a[1] + (b[1] - a[1]) * t;
      return { lat, lng, remaining_s: Math.max(0, totalDurationS - seconds) };
    }
    acc += seg;
  }
  const last = geometry.coordinates[geometry.coordinates.length - 1];
  return { lat: last[1], lng: last[0], remaining_s: 0 };
}

export function haversine(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function encodePolyline(coords: [number, number][]): string {
  let output = "";
  let prevLat = 0;
  let prevLng = 0;
  for (const [lng, lat] of coords) {
    const latE5 = Math.round(lat * 1e5);
    const lngE5 = Math.round(lng * 1e5);
    output += encodeNumber(latE5 - prevLat);
    output += encodeNumber(lngE5 - prevLng);
    prevLat = latE5;
    prevLng = lngE5;
  }
  return output;
}

function encodeNumber(num: number): string {
  let v = num < 0 ? ~(num << 1) : num << 1;
  let out = "";
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>>= 5;
  }
  out += String.fromCharCode(v + 63);
  return out;
}

export function decodePolyline(str: string): [number, number][] {
  const out: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < str.length) {
    let b: number;
    let shift = 0;
    let result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;
    shift = 0;
    result = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;
    out.push([lng / 1e5, lat / 1e5]);
  }
  return out;
}
