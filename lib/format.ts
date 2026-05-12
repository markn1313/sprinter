import { TripStatus } from "./types";

export function dollars(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

export function statusLabel(s: TripStatus): string {
  switch (s) {
    case "scheduled":
      return "Scheduled";
    case "dispatched":
      return "Dispatched";
    case "at_pickup":
      return "At pickup";
    case "onboard":
      return "Onboard";
    case "at_dropoff":
      return "At dropoff";
    case "complete":
      return "Complete";
    case "cancelled":
      return "Cancelled";
  }
}

export function statusColor(s: TripStatus): string {
  switch (s) {
    case "scheduled":
      return "bg-zinc-700";
    case "dispatched":
      return "bg-blue-600";
    case "at_pickup":
      return "bg-amber-600";
    case "onboard":
      return "bg-emerald-600";
    case "at_dropoff":
      return "bg-amber-600";
    case "complete":
      return "bg-zinc-600";
    case "cancelled":
      return "bg-red-700";
  }
}

export function shortTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  });
}

export function shortDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/Los_Angeles",
  });
}

// Short one-line form of an address — typically "<street>" only,
// dropping city/state/zip. Nominatim occasionally returns building-number
// ranges as "230,232 Newport Boulevard" (comma-joined) which broke naive
// split(",")[0]; this version re-attaches a pure-digit leading segment to
// the next part so "230,232 Newport Boulevard, Newport Beach, CA 92663"
// shortens cleanly to "230,232 Newport Boulevard" instead of "230".
export function shortAddr(addr: string | null | undefined): string {
  if (!addr) return "";
  const parts = addr.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  // If the first segment is purely numeric (a leading building number),
  // glue it onto the next segment so we keep the number AND the street.
  if (parts.length >= 2 && /^\d+(?:-\d+)?$/.test(parts[0])) {
    return `${parts[0]},${parts[1]}`;
  }
  return parts[0];
}

// Strip a trailing US ZIP (5-digit or ZIP+4) from a display address. Leaves
// the underlying record untouched — only meant for rendering. Examples:
//   "2914 West Ocean Front, Newport Beach, CA 92663" → "...CA"
//   "1 Apple Park Way, Cupertino, CA 95014-2086"     → "...CA"
//   "Some place"                                     → "Some place"
// Also trims any stray trailing comma+space left after the ZIP is removed.
export function stripZip(addr: string | null | undefined): string {
  if (!addr) return "";
  return addr
    .replace(/[\s,]*\d{5}(?:-\d{4})?\s*$/, "")
    .replace(/[\s,]+$/, "")
    .trim();
}

export function durationMinutes(startIso: string | null, endIso: string | null = null): number | null {
  if (!startIso) return null;
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (end < start) return 0;
  return Math.floor((end - start) / 60000);
}
