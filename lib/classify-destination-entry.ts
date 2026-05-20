// Classify a free-text entry from the passenger's single destination
// input box. The user's spec: default to address, but also accept
// natural language ("grab coffee on the way", "actually take me to
// LAX"). The one entry covers both.
//
// Strategy — cheap path first:
//   1. If the input "looks like" an address (digits + street suffix,
//      ZIP, comma+state, or a known venue with capitalized words), or
//      it came from a pin drop (lat/lng provided directly), skip the
//      LLM entirely — geocode it.
//   2. Otherwise hand it to the existing dispatch parser
//      (lib/parse-dispatch.ts, Claude Haiku 4.5) and translate its
//      output into one of three shapes the destinations endpoint
//      understands.
//
// Returning {kind: "unclear"} forces the endpoint to 400 with a
// "couldn't understand — try a street address?" message. The whole
// point of defaulting to address is that the LLM path is only reached
// for genuinely ambiguous input, where bailing out is the right move.

import { parseDispatch } from "./parse-dispatch";

export type ClassifiedEntry =
  | { kind: "address"; address: string }
  | { kind: "stop_request"; category: string | null; address: string | null }
  | { kind: "unclear"; raw: string };

// Street/road suffixes that strongly signal a street address. Match
// case-insensitive at the END of a word boundary so "Newportstreet"
// doesn't false-match.
const STREET_SUFFIX =
  /\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|ct|court|way|pl|place|hwy|highway|pkwy|parkway|cir|circle|ter|terrace|sq|square|trl|trail)\.?\b/i;

const ZIP = /\b\d{5}(-\d{4})?\b/;
const STATE_COMMA = /,\s*[A-Z]{2}(\s+\d{5})?\b/;
const NUMBERED_ADDRESS = /^\s*\d+\s+\S+/; // starts with a house number + at least one more token

// Venue-y capitalized phrases ("LAX", "Tom Bradley International
// Terminal", "JW Marriott"). Two or more consecutive Capitalized Words
// OR an all-caps acronym of 3+ letters. Deliberately permissive — false
// positives just bypass the LLM and hit the geocoder, which is fine.
const VENUE_LIKE = /\b([A-Z]{3,}|[A-Z][a-z]+(\s+[A-Z][a-z]+)+)\b/;

export function looksLikeAddress(input: string): boolean {
  const s = input.trim();
  if (!s) return false;
  if (NUMBERED_ADDRESS.test(s)) return true;
  if (ZIP.test(s)) return true;
  if (STATE_COMMA.test(s)) return true;
  if (STREET_SUFFIX.test(s)) return true;
  if (VENUE_LIKE.test(s)) return true;
  return false;
}

export async function classifyEntry(input: string): Promise<ClassifiedEntry> {
  const raw = input.trim();
  if (!raw) return { kind: "unclear", raw };

  // Cheap path: address-like → geocode directly.
  if (looksLikeAddress(raw)) {
    return { kind: "address", address: raw };
  }

  // Fall back to the LLM parser. The parser is robust to garbage and
  // will return kind="unclear" rather than guessing.
  try {
    const parsed = await parseDispatch(raw);
    switch (parsed.kind) {
      case "stop_request":
        return {
          kind: "stop_request",
          category: parsed.stopCategory,
          address: parsed.dropoffHint || parsed.pickupHint || null,
        };
      case "trip":
      case "pickup_now":
        // Either explicit address provided in NL ("take me to LAX") or a
        // generic "pick me up" that has no actionable destination. Use
        // the dropoffHint if we got one; otherwise unclear.
        if (parsed.dropoffHint) {
          return { kind: "address", address: parsed.dropoffHint };
        }
        return { kind: "unclear", raw };
      case "unclear":
      default:
        return { kind: "unclear", raw };
    }
  } catch {
    // Parser blew up (no API key, network, etc) — degrade gracefully:
    // assume it's an address and let the geocoder decide.
    return { kind: "address", address: raw };
  }
}
