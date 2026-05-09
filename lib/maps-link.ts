// Build Google Maps deep links (universal for iOS / Android / web).
// Always prefers exact lat/lng coordinates over a text label — Google's fuzzy
// matching on addresses like "Newport Village" can resolve to a NEARBY but
// wrong place (e.g. "Lido Marina Village"). Coords are unambiguous.

export function googleMapsTo(lat: number, lng: number, _label?: string): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;
}

export function googleMapsMultiStop(
  waypoints: Array<{ lat: number; lng: number; label?: string }>,
  _finalLabel?: string,
): string {
  if (waypoints.length === 0) return "";
  const last = waypoints[waypoints.length - 1];
  const dest = `${last.lat},${last.lng}`;
  const intermediate = waypoints.slice(0, -1);
  const wpStr = intermediate.length
    ? `&waypoints=${intermediate.map((w) => `${w.lat},${w.lng}`).join("|")}`
    : "";
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}${wpStr}&travelmode=driving`;
}

export function appleMapsTo(lat: number, lng: number): string {
  return `https://maps.apple.com/?daddr=${lat},${lng}`;
}
