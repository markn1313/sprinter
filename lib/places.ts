// Free POI search via OpenStreetMap Overpass API.
// No key required. Use sparingly; Overpass is community-funded.

import { haversine } from "./routing";

export type PlaceCategory =
  | "coffee"
  | "food"
  | "fast_food"
  | "restroom"
  | "gas"
  | "grocery"
  | "pharmacy"
  | "atm"
  | "ev_charging"
  | "rest_stop";

export interface Place {
  id: string;
  name: string;
  category: PlaceCategory;
  lat: number;
  lng: number;
  distance_m_from_anchor: number;
  tags: Record<string, string>;
}

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

const QUERIES: Record<PlaceCategory, string> = {
  coffee: '["amenity"="cafe"]',
  food: '["amenity"="restaurant"]',
  fast_food: '["amenity"="fast_food"]',
  restroom: '["amenity"="toilets"]',
  gas: '["amenity"="fuel"]',
  grocery: '["shop"="supermarket"]',
  pharmacy: '["amenity"="pharmacy"]',
  atm: '["amenity"="atm"]',
  ev_charging: '["amenity"="charging_station"]',
  rest_stop: '["highway"="services"]',
};

const KEYWORDS_TO_CATEGORY: Array<[RegExp, PlaceCategory]> = [
  [/\b(coffee|starbucks|latte|espresso|cafe|café)\b/i, "coffee"],
  [/\b(restroom|bathroom|toilet|pee|loo)\b/i, "restroom"],
  [/\b(gas|fuel|fill ?up|gasoline)\b/i, "gas"],
  [/\b(charging|charger|ev charge|tesla)\b/i, "ev_charging"],
  [/\b(food|eat|lunch|dinner|breakfast|burger|sandwich|taco|pizza|sushi|restaurant)\b/i, "food"],
  [/\b(fast food|drive thru|drive-thru|in-?n-?out|chick-?fil-?a|mcdonald)\b/i, "fast_food"],
  [/\b(grocery|grocer|whole foods|trader joe|store)\b/i, "grocery"],
  [/\b(pharmacy|drug ?store|cvs|walgreens|rite aid)\b/i, "pharmacy"],
  [/\b(atm|cash)\b/i, "atm"],
];

export function categoryFromText(text: string): PlaceCategory | null {
  for (const [re, cat] of KEYWORDS_TO_CATEGORY) {
    if (re.test(text)) return cat;
  }
  return null;
}

export async function searchPlaces(
  category: PlaceCategory,
  anchor: { lat: number; lng: number },
  radiusMeters = 3000,
  limit = 10,
): Promise<Place[]> {
  const filter = QUERIES[category];
  const q = `
[out:json][timeout:15];
(
  node${filter}(around:${radiusMeters},${anchor.lat},${anchor.lng});
  way${filter}(around:${radiusMeters},${anchor.lat},${anchor.lng});
);
out center ${limit * 2};
  `.trim();
  try {
    const res = await fetch(OVERPASS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(q),
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      elements: Array<{
        id: number;
        type: string;
        lat?: number;
        lon?: number;
        center?: { lat: number; lon: number };
        tags?: Record<string, string>;
      }>;
    };
    const out: Place[] = data.elements
      .map((el) => {
        const lat = el.lat ?? el.center?.lat;
        const lng = el.lon ?? el.center?.lon;
        if (lat == null || lng == null) return null;
        const tags = el.tags ?? {};
        return {
          id: `${el.type}/${el.id}`,
          name: tags.name ?? tags.brand ?? "(unnamed)",
          category,
          lat,
          lng,
          distance_m_from_anchor: haversine(anchor.lat, anchor.lng, lat, lng),
          tags,
        };
      })
      .filter((p): p is Place => p !== null && !!p.tags.name)
      .sort((a, b) => a.distance_m_from_anchor - b.distance_m_from_anchor)
      .slice(0, limit);
    return out;
  } catch {
    return [];
  }
}
