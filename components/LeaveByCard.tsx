"use client";

import { useEffect, useState } from "react";
import { Trip } from "@/lib/types";
import { api } from "@/lib/api-client";
import { Clock, AlertTriangle, Calendar } from "lucide-react";

interface Props {
  token: string;
  vanLat: number | null;
  vanLng: number | null;
}

interface EtaResp {
  eta_minutes?: number | null;
  distance_miles?: number | null;
}

// Next-scheduled-trip leave-by predictor. Pulls the soonest non-completed,
// non-cancelled trip with a future scheduled_at, computes a live ETA from the
// van's current position to that pickup, and tells Mark when he needs to leave
// to be on time. Color-coded: green if plenty of time, amber if leaving soon,
// red if already late. Hides itself if no upcoming trip in the next 6 hours.
export default function LeaveByCard({ token, vanLat, vanLng }: Props) {
  const [trip, setTrip] = useState<Trip | null>(null);
  const [etaMin, setEtaMin] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  // Refresh "now" every 30s so the countdown stays current
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Fetch next trip on mount + every 60s
  useEffect(() => {
    let cancel = false;
    const fetchNext = async () => {
      try {
        const data = await api<{ trips: Trip[] }>(token, "/api/trips");
        if (cancel) return;
        const horizon = Date.now() + 6 * 60 * 60_000;
        const next = data.trips
          .filter(
            (t) =>
              t.status !== "complete" &&
              t.status !== "cancelled" &&
              t.scheduled_at &&
              new Date(t.scheduled_at).getTime() > Date.now() &&
              new Date(t.scheduled_at).getTime() < horizon,
          )
          .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime())[0];
        setTrip(next ?? null);
      } catch {
        // ignore
      }
    };
    fetchNext();
    const t = setInterval(fetchNext, 60_000);
    return () => {
      cancel = true;
      clearInterval(t);
    };
  }, [token]);

  // Compute ETA whenever van or trip changes
  useEffect(() => {
    if (!trip || trip.pickup_lat == null || trip.pickup_lng == null || vanLat == null || vanLng == null) {
      setEtaMin(null);
      return;
    }
    let cancel = false;
    (async () => {
      try {
        const res = await fetch(`/api/eta`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            origin: { lat: vanLat, lng: vanLng },
            waypoints: [
              { lat: trip.pickup_lat, lng: trip.pickup_lng, kind: "pickup" },
            ],
          }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as EtaResp;
        if (cancel) return;
        setEtaMin(data.eta_minutes ?? null);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancel = true;
    };
  }, [trip, vanLat, vanLng, token]);

  if (!trip) return null;
  const tripTime = new Date(trip.scheduled_at).getTime();
  const minsUntilTrip = Math.round((tripTime - now) / 60_000);
  const drive = etaMin ?? estimateDriveMin(vanLat, vanLng, trip.pickup_lat, trip.pickup_lng);
  const slackMin = drive != null ? minsUntilTrip - drive : null;

  // Tone:
  //  > 30m slack: green chill
  //  10-30m: amber heads-up
  //  < 10m: red urgent
  let tone: "green" | "amber" | "red" = "green";
  if (slackMin != null) {
    if (slackMin < 10) tone = "red";
    else if (slackMin < 30) tone = "amber";
  }

  const palette = {
    green: { ring: "border-emerald-700/40", text: "text-emerald-300", icon: "text-emerald-400" },
    amber: { ring: "border-amber-700/60", text: "text-amber-300", icon: "text-amber-400" },
    red: { ring: "border-red-700/70", text: "text-red-300", icon: "text-red-400" },
  }[tone];

  return (
    <div className={`rounded-2xl border ${palette.ring} bg-zinc-950/95 p-4 backdrop-blur shadow-xl`}>
      <div className={`flex items-center gap-1.5 text-xs uppercase tracking-wider ${palette.text}`}>
        {tone === "red" ? <AlertTriangle size={12} className={palette.icon} /> : <Calendar size={12} className={palette.icon} />}
        Next trip
      </div>
      <div className="mt-2 flex items-baseline justify-between">
        <div className="font-mono text-lg font-bold tabular-nums text-zinc-100">
          {fmtTime(trip.scheduled_at)}
        </div>
        <div className="text-xs text-zinc-400">
          {trip.passenger_name || "Trip"}
        </div>
      </div>
      {trip.pickup_address && (
        <div className="mt-1 truncate text-[11px] text-zinc-500">
          {trip.pickup_address.split(",")[0]}
        </div>
      )}
      <div className={`mt-2 flex items-center gap-1.5 text-sm font-semibold ${palette.text}`}>
        <Clock size={14} className={palette.icon} />
        {leaveByText(slackMin, drive)}
      </div>
    </div>
  );
}

function leaveByText(slackMin: number | null, driveMin: number | null): string {
  if (slackMin == null || driveMin == null) return "Calculating…";
  if (slackMin < 0) return `Already ${Math.abs(slackMin)} min late · ${driveMin} min drive`;
  if (slackMin < 5) return `Leave NOW · ${driveMin} min drive`;
  if (slackMin < 60) return `Leave in ${slackMin} min · ${driveMin} min drive`;
  const h = Math.floor(slackMin / 60);
  const m = slackMin % 60;
  return `Leave in ${h}h ${m}m · ${driveMin} min drive`;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/Los_Angeles",
  });
}

// Fallback drive estimate when /api/eta isn't ready: 35 mph straight-line
// gives a rough number so we never show "Calculating…" forever.
function estimateDriveMin(
  vanLat: number | null,
  vanLng: number | null,
  pLat: number | null,
  pLng: number | null,
): number | null {
  if (vanLat == null || vanLng == null || pLat == null || pLng == null) return null;
  const R = 3959;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(pLat - vanLat);
  const dLng = toRad(pLng - vanLng);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(vanLat)) * Math.cos(toRad(pLat)) * Math.sin(dLng / 2) ** 2;
  const miles = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.max(2, Math.round((miles / 35) * 60));
}
