// Free routing via OSRM public demo server.
// No traffic-aware ETA yet (next upgrade: Mapbox driving-traffic profile).
// Returns a GeoJSON LineString polyline + total drive seconds + meters.

export interface RouteResult {
  polyline: string; // encoded polyline (precision 5, OSRM default)
  distance_m: number;
  duration_s: number;
  geometry: { type: "LineString"; coordinates: [number, number][] };
}

export interface Waypoint {
  lat: number;
  lng: number;
}

const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";

export async function route(waypoints: Waypoint[]): Promise<RouteResult | null> {
  if (waypoints.length < 2) return null;
  const coords = waypoints.map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `${OSRM_BASE}/${coords}?overview=full&geometries=geojson&steps=false`;
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
      geometry: r.geometry,
    };
  } catch {
    return null;
  }
}

// Walk along a polyline for `seconds` of drive time at avg speed of the route.
// Returns the coordinate where the van will be after `seconds`.
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
      return {
        lat,
        lng,
        remaining_s: Math.max(0, totalDurationS - seconds),
      };
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
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Standard Google polyline algorithm (precision 5)
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
