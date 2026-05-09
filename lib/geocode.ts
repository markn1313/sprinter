// Free geocoding via OpenStreetMap Nominatim. No key required.
// Throttle: ~1 request/second per Nominatim's usage policy.

import { shortenAddress } from "./address-format";

export interface GeoPoint {
  lat: number;
  lng: number;
  display: string;
}

const HOME_FALLBACK: GeoPoint = {
  lat: 33.6189,
  lng: -117.9298,
  display: "Newport Beach, CA",
};

const SHORTHAND: Record<string, GeoPoint> = {
  home: HOME_FALLBACK,
  house: HOME_FALLBACK,
  "my house": HOME_FALLBACK,
  "newport": HOME_FALLBACK,
  "newport beach": HOME_FALLBACK,
};

export async function geocode(address: string | null | undefined): Promise<GeoPoint | null> {
  if (!address || !address.trim()) return null;
  const lower = address.trim().toLowerCase();
  if (SHORTHAND[lower]) return SHORTHAND[lower];

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&namedetails=1&limit=1&q=${encodeURIComponent(address)}&countrycodes=us`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "SprinterOps/1.0 (mark@mnafinancial.com)",
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{
      lat: string;
      lon: string;
      display_name: string;
      name?: string;
      address?: Record<string, string>;
      class?: string;
    }>;
    const hit = data[0];
    if (!hit) return null;
    return {
      lat: parseFloat(hit.lat),
      lng: parseFloat(hit.lon),
      display: shortenAddress(hit) || hit.display_name,
    };
  } catch {
    return null;
  }
}
