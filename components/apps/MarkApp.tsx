"use client";

import { useEffect, useState } from "react";
import { Trip } from "@/lib/types";
import { usePosition } from "@/components/usePosition";
import { useTrips, activeTrip } from "@/components/useTrips";
import ClientMap from "@/components/ClientMap";
import DispatchBar from "@/components/DispatchBar";
import ActiveTripCard from "@/components/ActiveTripCard";
import LinkGenerator from "@/components/LinkGenerator";
import TripList from "@/components/TripList";
import DioStatusBar from "@/components/DioStatusBar";
import BouncieConnectCard from "@/components/BouncieConnectCard";
import { dollars, durationMinutes } from "@/lib/format";
import { Battery, Fuel, Gauge, Signal } from "lucide-react";

export default function MarkApp({ token, name }: { token: string; name: string }) {
  const { pos } = usePosition(token, 8000);
  const { trips, refresh } = useTrips(token, 5000);
  const [origin, setOrigin] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const live = activeTrip(trips);

  // Today's earnings = sum of completed trip pay since midnight PT
  const startOfDayPT = (() => {
    const d = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });
    const parts = formatter.formatToParts(d);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const day = parts.find((p) => p.type === "day")?.value;
    return new Date(`${y}-${m?.padStart(2, "0")}-${day?.padStart(2, "0")}T00:00:00-08:00`);
  })();
  const todayPay = trips
    .filter((t) => t.completed_at && new Date(t.completed_at) >= startOfDayPT)
    .reduce((acc, t) => acc + (t.driver_pay_cents ?? 0), 0);
  const weekPay = trips
    .filter((t) => t.completed_at && Date.now() - new Date(t.completed_at).getTime() < 7 * 86400_000)
    .reduce((acc, t) => acc + (t.driver_pay_cents ?? 0), 0);

  return (
    <div className="min-h-screen bg-zinc-950 pb-12">
      {/* Top bar */}
      <header className="sticky top-0 z-20 border-b border-zinc-900 bg-zinc-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-xl">🚐</span>
            <span className="text-sm font-medium text-zinc-100">Sprinter Ops</span>
            <span className="ml-2 rounded-full bg-blue-700/30 px-2 py-0.5 text-[10px] uppercase tracking-wider text-blue-300">
              Owner · {name}
            </span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-zinc-400">
            {pos?.source === "mock" && (
              <span className="rounded-full bg-amber-900/40 px-2 py-0.5 text-amber-300">
                Bouncie not configured · mock
              </span>
            )}
            <span className="hidden sm:inline">
              Today {dollars(todayPay)} · Week {dollars(weekPay)}
            </span>
          </div>
        </div>
      </header>

      {/* Map */}
      <section className="relative mx-auto max-w-6xl px-4 pt-4">
        <div className="h-[44vh] min-h-[280px] overflow-hidden rounded-2xl border border-zinc-800">
          <ClientMap
            position={pos}
            pickup={
              live?.pickup_lat != null && live?.pickup_lng != null
                ? { lat: live.pickup_lat, lng: live.pickup_lng, label: live.pickup_address ?? undefined }
                : null
            }
            dropoff={
              live?.dropoff_lat != null && live?.dropoff_lng != null
                ? { lat: live.dropoff_lat, lng: live.dropoff_lng, label: live.dropoff_address ?? undefined }
                : null
            }
          />
        </div>
        {/* Vitals strip overlaid */}
        <div className="absolute right-6 top-6 hidden gap-2 sm:flex">
          {pos?.fuel_pct != null && (
            <div className="flex items-center gap-1 rounded-lg bg-zinc-950/80 px-2 py-1 text-xs backdrop-blur">
              <Fuel size={12} className="text-emerald-400" />
              <span>{(pos.fuel_pct * 100).toFixed(0)}%</span>
            </div>
          )}
          {pos?.battery_v != null && (
            <div className="flex items-center gap-1 rounded-lg bg-zinc-950/80 px-2 py-1 text-xs backdrop-blur">
              <Battery size={12} className="text-emerald-400" />
              <span>{pos.battery_v.toFixed(1)}v</span>
            </div>
          )}
          {pos?.speed_mph != null && (
            <div className="flex items-center gap-1 rounded-lg bg-zinc-950/80 px-2 py-1 text-xs backdrop-blur">
              <Gauge size={12} className="text-emerald-400" />
              <span>{pos.speed_mph.toFixed(0)} mph</span>
            </div>
          )}
        </div>
      </section>

      {/* Bouncie status (connect link if not connected) */}
      <section className="mx-auto mt-3 max-w-6xl px-4">
        <BouncieConnectCard token={token} />
      </section>

      {/* Dispatch + active */}
      <section className="mx-auto mt-4 grid max-w-6xl gap-3 px-4 md:grid-cols-2">
        <DispatchBar token={token} onDispatched={() => refresh()} />
        {live ? (
          <ActiveTripCard token={token} role="mark" trip={live} onAdvance={refresh} />
        ) : (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 text-sm text-zinc-500">
            No active trip. Use the dispatch bar to send the van.
          </div>
        )}
      </section>

      {/* Dio status (read-only for Mark) */}
      <section className="mx-auto mt-3 max-w-6xl px-4">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-zinc-500">
          <Signal size={12} /> Driver status
        </div>
        <div className="mt-2">
          <DioStatusBar token={token} editable={true} />
        </div>
      </section>

      {/* Links + trips */}
      <section className="mx-auto mt-4 grid max-w-6xl gap-3 px-4 md:grid-cols-3">
        <div className="md:col-span-1">
          <LinkGenerator token={token} origin={origin} />
        </div>
        <div className="md:col-span-2">
          <div className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Recent trips</div>
          <TripList trips={trips} role="mark" origin={origin} />
        </div>
      </section>
    </div>
  );
}
