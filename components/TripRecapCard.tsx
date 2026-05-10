"use client";

import { useEffect, useState } from "react";
import { Trip } from "@/lib/types";
import { api } from "@/lib/api-client";
import { CheckCircle2, MapPin, Flag } from "lucide-react";

interface RecapStats {
  miles: number;
  duration_min: number;
  max_speed_mph: number;
  fuel_cost_dollars: number;
}

type TripWithExtras = Trip & {
  arrived_at_dropoff_at?: string | null;
  completed_at?: string | null;
};

// Shows on Mark home when there's no active trip but a recent completion
// (within 90 min). Pulls per-trip metrics from vehicle_positions for that
// trip_id. Disappears after that.
export default function TripRecapCard({ token }: { token: string }) {
  const [trip, setTrip] = useState<TripWithExtras | null>(null);
  const [stats, setStats] = useState<RecapStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<{ trips: TripWithExtras[] }>(token, "/api/trips");
        if (cancelled) return;
        const cutoff = Date.now() - 90 * 60_000;
        const recent = data.trips
          .filter((t) => t.status === "complete" && t.completed_at && new Date(t.completed_at).getTime() > cutoff)
          .sort((a, b) => new Date(b.completed_at!).getTime() - new Date(a.completed_at!).getTime())[0];
        if (!recent) return;
        setTrip(recent);
        // Fetch stats for that trip
        try {
          const s = await api<RecapStats>(token, `/api/trip-stats?trip=${recent.id}`);
          if (!cancelled) setStats(s);
        } catch {
          // stats endpoint missing or errored — render trip-only
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!trip) return null;

  const dur = stats?.duration_min ?? computeDurationMin(trip);
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/95 p-4 backdrop-blur shadow-xl">
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-emerald-300">
        <CheckCircle2 size={12} /> Trip complete
      </div>
      <div className="mt-2 space-y-1 text-xs text-zinc-300">
        {trip.pickup_address && (
          <div className="flex items-center gap-1.5 truncate">
            <MapPin size={10} className="shrink-0 text-amber-400" />
            <span className="truncate">{shortAddr(trip.pickup_address)}</span>
          </div>
        )}
        {trip.dropoff_address && (
          <div className="flex items-center gap-1.5 truncate">
            <Flag size={10} className="shrink-0 text-blue-400" />
            <span className="truncate">{shortAddr(trip.dropoff_address)}</span>
          </div>
        )}
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <Stat value={stats ? stats.miles.toString() : "—"} unit="mi" label="Distance" />
        <Stat value={dur != null ? dur.toString() : "—"} unit="min" label="Duration" />
        <Stat value={stats ? `$${stats.fuel_cost_dollars}` : "—"} label="Fuel" />
      </div>
    </div>
  );
}

function Stat({ value, unit, label }: { value: string; unit?: string; label: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-center gap-1">
        <span className="font-mono text-base font-bold tabular-nums text-zinc-100">{value}</span>
        {unit && <span className="text-[10px] text-zinc-500">{unit}</span>}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
    </div>
  );
}

function shortAddr(a: string): string {
  return a.split(",")[0].trim();
}

function computeDurationMin(t: TripWithExtras): number | null {
  if (!t.completed_at || !t.dispatched_at) return null;
  const ms = new Date(t.completed_at).getTime() - new Date(t.dispatched_at).getTime();
  return Math.max(0, Math.round(ms / 60_000));
}
