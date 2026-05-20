// Service-area bounding box. Any lat/lng outside this box is rejected
// at the /api/destinations layer with a clear "pick a point on land /
// in our service area" message. Hard guard against:
//   - Geocoder returning a wrong-continent match for a typo
//   - Pin dropped in the Pacific Ocean
//   - Pin dropped on a different state by accident
//
// Default bbox covers Mark's actual operating area (Newport / Huntington
// Beach / OC / LA County / north to Santa Barbara). Tuned wide enough
// that legitimate corner-case rides aren't rejected, tight enough that
// a Sydney address doesn't slip through.

export const SERVICE_AREA = {
  // Roughly: San Diego county up through Santa Barbara, Catalina to
  // edge of Mojave. Adjust here if Mark expands the route area.
  minLat: 32.5,
  maxLat: 35.5,
  minLng: -120.0,
  maxLng: -116.0,
} as const;

export function isInServiceArea(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return (
    lat >= SERVICE_AREA.minLat &&
    lat <= SERVICE_AREA.maxLat &&
    lng >= SERVICE_AREA.minLng &&
    lng <= SERVICE_AREA.maxLng
  );
}

// Distance (meters) between two lat/lng points. Used for the bootstrap
// proximity check ("is the requester's phone within X meters of the
// van's last GPS?") and the universal-30m arrival heuristic on the
// state-machine side. Plain haversine, no deps.
const EARTH_M = 6_371_000;

export function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return EARTH_M * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}
