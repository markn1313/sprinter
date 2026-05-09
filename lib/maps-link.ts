// Build Google Maps deep links (universal for iOS / Android / web)
export function googleMapsTo(lat: number, lng: number, label?: string): string {
  // Universal directions URL works in browser and opens Maps app on mobile
  const dest = label ? `${encodeURIComponent(label)}` : `${lat},${lng}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving`;
}

export function googleMapsMultiStop(
  waypoints: Array<{ lat: number; lng: number; label?: string }>,
  finalLabel?: string,
): string {
  if (waypoints.length === 0) return "";
  const last = waypoints[waypoints.length - 1];
  const dest = finalLabel ?? `${last.lat},${last.lng}`;
  const intermediate = waypoints.slice(0, -1);
  const wpStr = intermediate.length
    ? `&waypoints=${intermediate.map((w) => `${w.lat},${w.lng}`).join("|")}`
    : "";
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}${wpStr}&travelmode=driving`;
}

export function appleMapsTo(lat: number, lng: number, label?: string): string {
  const ll = `${lat},${lng}`;
  const q = label ? `?daddr=${encodeURIComponent(label)}` : `?daddr=${ll}`;
  return `https://maps.apple.com/${q}`;
}
