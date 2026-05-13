// Trim Nominatim's verbose addresses down to "<street>, <city>, <state> <zip>".
//
// Nominatim returns things like:
//   "2914, West Ocean Front, Newport Village, Balboa Peninsula, Newport Beach, Orange County, California, 92663, United States"
// We want:
//   "2914 West Ocean Front, Newport Beach, CA 92663"

interface NominatimAddress {
  house_number?: string;
  road?: string;
  pedestrian?: string;
  path?: string;
  cycleway?: string;
  footway?: string;
  city?: string;
  town?: string;
  village?: string;
  hamlet?: string;
  suburb?: string;
  neighbourhood?: string;
  county?: string;
  state?: string;
  postcode?: string;
  country?: string;
}

interface NominatimItem {
  display_name?: string;
  name?: string;
  address?: NominatimAddress;
  // Some endpoints (POIs) provide a separate "namedetails" or "type"
  type?: string;
  class?: string;
}

const STATE_ABBR: Record<string, string> = {
  Alabama: "AL",
  Alaska: "AK",
  Arizona: "AZ",
  Arkansas: "AR",
  California: "CA",
  Colorado: "CO",
  Connecticut: "CT",
  Delaware: "DE",
  Florida: "FL",
  Georgia: "GA",
  Hawaii: "HI",
  Idaho: "ID",
  Illinois: "IL",
  Indiana: "IN",
  Iowa: "IA",
  Kansas: "KS",
  Kentucky: "KY",
  Louisiana: "LA",
  Maine: "ME",
  Maryland: "MD",
  Massachusetts: "MA",
  Michigan: "MI",
  Minnesota: "MN",
  Mississippi: "MS",
  Missouri: "MO",
  Montana: "MT",
  Nebraska: "NE",
  Nevada: "NV",
  "New Hampshire": "NH",
  "New Jersey": "NJ",
  "New Mexico": "NM",
  "New York": "NY",
  "North Carolina": "NC",
  "North Dakota": "ND",
  Ohio: "OH",
  Oklahoma: "OK",
  Oregon: "OR",
  Pennsylvania: "PA",
  "Rhode Island": "RI",
  "South Carolina": "SC",
  "South Dakota": "SD",
  Tennessee: "TN",
  Texas: "TX",
  Utah: "UT",
  Vermont: "VT",
  Virginia: "VA",
  Washington: "WA",
  "West Virginia": "WV",
  Wisconsin: "WI",
  Wyoming: "WY",
  "District of Columbia": "DC",
};

function stateAbbr(state?: string): string {
  if (!state) return "";
  return STATE_ABBR[state] ?? state;
}

export function shortenAddress(item: NominatimItem | null | undefined): string {
  if (!item) return "";
  const a = item.address ?? {};
  const houseNum = (a.house_number ?? "").trim();
  const road = (a.road ?? a.pedestrian ?? a.path ?? a.cycleway ?? a.footway ?? "").trim();
  // A bare house number with no road is useless ("2203" tells you nothing
  // about WHERE). Drop the number entirely when Nominatim has no road
  // segment — usually means the point is on a parking lot, private drive,
  // or vacant lot that OSM hasn't labeled. We fall through to neighborhood
  // / display_name below for a more meaningful label.
  const street = road ? [houseNum, road].filter(Boolean).join(" ") : "";
  const neighborhood = (a.neighbourhood ?? a.suburb ?? "").trim();
  const city =
    (a.city ?? a.town ?? a.village ?? a.hamlet ?? "").trim();
  const state = stateAbbr(a.state);
  const postcode = (a.postcode ?? "").trim();

  const parts: string[] = [];

  // POI / landmark with a name (e.g. "Intuit Dome") — prefer the name, then city
  const isPoi = item.class && item.class !== "highway" && item.class !== "place";
  if (item.name && (isPoi || !street)) {
    parts.push(item.name);
  } else if (street) {
    parts.push(street);
  } else if (neighborhood) {
    // No road and no POI name. Show the neighborhood / suburb so Mark at
    // least sees something like "Newport Heights" instead of a bare number
    // or empty string.
    parts.push(neighborhood);
  }

  // Prefer (neighborhood -> city) when we landed on neighborhood already,
  // otherwise just city. Avoid duplicating the same word twice.
  const cityCandidate = city || (parts[0] === neighborhood ? "" : neighborhood);
  if (cityCandidate && parts[0] !== cityCandidate) parts.push(cityCandidate);

  const tail = [state, postcode].filter(Boolean).join(" ");
  if (tail) parts.push(tail);

  if (parts.length === 0) {
    // Fallback: trim verbose display_name to first 3 segments BUT drop
    // a leading bare house-number segment ("2203, Some Hood, Newport
    // Beach" → "Some Hood, Newport Beach").
    const display = item.display_name ?? "";
    const segs = display.split(",").map((s) => s.trim()).filter(Boolean);
    if (segs.length > 0 && /^\d+(?:-\d+)?$/.test(segs[0])) segs.shift();
    return segs.slice(0, 3).join(", ").trim();
  }
  return parts.join(", ");
}

// Best-effort: clean up an already-stored verbose address string when we don't
// have the structured Nominatim object. Drops common noise.
export function cleanupVerboseAddress(s: string): string {
  if (!s) return s;
  const segments = s.split(",").map((p) => p.trim());
  if (segments.length < 4) return s;
  // Drop "United States" and any "X County" segment
  const filtered = segments.filter(
    (seg) => seg !== "United States" && !/County$/.test(seg),
  );
  // Try to detect a state name and abbreviate
  const lastFew = filtered.slice(-3);
  for (const idx in filtered) {
    const i = Number(idx);
    if (STATE_ABBR[filtered[i]]) {
      filtered[i] = STATE_ABBR[filtered[i]];
    }
  }
  // If we still have 5+ segments, drop neighborhood-y segments in the middle
  if (filtered.length > 4) {
    // Keep first (street/house), city (= 2nd-to-last that's not state/zip), state, zip
    const street = filtered[0];
    const tail = filtered.slice(-3); // [city, state, zip] hopefully
    return [street, ...tail].join(", ");
  }
  return filtered.join(", ");
}
