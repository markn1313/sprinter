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

export function durationMinutes(startIso: string | null, endIso: string | null = null): number | null {
  if (!startIso) return null;
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  if (end < start) return 0;
  return Math.floor((end - start) / 60000);
}
