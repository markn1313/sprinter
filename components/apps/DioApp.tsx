"use client";

import { useEffect, useState } from "react";
import { Trip } from "@/lib/types";
import { usePosition } from "@/components/usePosition";
import { useTrips, activeTrip } from "@/components/useTrips";
import ClientMap from "@/components/ClientMap";
import ActiveTripCard from "@/components/ActiveTripCard";
import DioStatusBar from "@/components/DioStatusBar";
import IssueLogger from "@/components/IssueLogger";
import { shortTime } from "@/lib/format";
import { Battery, Fuel, Gauge, Navigation, MapPin, User } from "lucide-react";

export default function DioApp({ token, name }: { token: string; name: string }) {
  const { pos } = usePosition(token, 6000);
  const { trips, refresh } = useTrips(token, 5000);
  const live = activeTrip(trips);
  const upcoming = trips
    .filter((t) => t.status === "scheduled")
    .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
  const nextUp: Trip | null = upcoming[0] ?? null;

  return (
    <div className="min-h-screen bg-zinc-950 pb-12">
      <header className="sticky top-0 z-20 border-b border-zinc-900 bg-zinc-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-xl">🚐</span>
            <span className="text-sm font-medium text-zinc-100">Sprinter</span>
            <span className="ml-2 rounded-full bg-emerald-700/30 px-2 py-0.5 text-[10px] uppercase tracking-wider text-emerald-300">
              Driver · {name}
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            {pos?.fuel_pct != null && (
              <span className="flex items-center gap-1">
                <Fuel size={11} /> {(pos.fuel_pct * 100).toFixed(0)}%
              </span>
            )}
            {pos?.speed_mph != null && (
              <span className="flex items-center gap-1">
                <Gauge size={11} /> {pos.speed_mph.toFixed(0)}
              </span>
            )}
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-3xl space-y-3 px-4 pt-4">
        {live ? (
          <ActiveTripCard token={token} role="dio" trip={live} onAdvance={refresh} />
        ) : nextUp ? (
          <NextUpCard trip={nextUp} />
        ) : (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-6 text-center text-sm text-zinc-500">
            No upcoming pickups. Mark will dispatch when needed.
          </div>
        )}

        <div className="h-[36vh] min-h-[240px] overflow-hidden rounded-2xl border border-zinc-800">
          <ClientMap
            position={pos}
            pickup={
              live?.pickup_lat != null && live?.pickup_lng != null
                ? { lat: live.pickup_lat, lng: live.pickup_lng, label: live.pickup_address ?? undefined }
                : nextUp?.pickup_lat != null && nextUp?.pickup_lng != null
                  ? { lat: nextUp.pickup_lat, lng: nextUp.pickup_lng, label: nextUp.pickup_address ?? undefined }
                  : null
            }
            dropoff={
              live?.dropoff_lat != null && live?.dropoff_lng != null
                ? { lat: live.dropoff_lat, lng: live.dropoff_lng, label: live.dropoff_address ?? undefined }
                : null
            }
          />
        </div>

        <div>
          <div className="mb-2 text-xs uppercase tracking-wider text-zinc-500">My status</div>
          <DioStatusBar token={token} editable={true} />
        </div>

        <IssueLogger token={token} />

        {!live && upcoming.length > 1 && (
          <div>
            <div className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Upcoming</div>
            <ul className="space-y-2">
              {upcoming.slice(1, 6).map((t) => (
                <li
                  key={t.id}
                  className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-sm"
                >
                  <div>
                    <div className="font-medium text-zinc-100">{t.passenger_name}</div>
                    {t.pickup_address && (
                      <div className="text-xs text-zinc-400">From {t.pickup_address}</div>
                    )}
                  </div>
                  <div className="text-xs text-zinc-500">{shortTime(t.scheduled_at)}</div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

function NextUpCard({ trip }: { trip: Trip }) {
  const navUrl = trip.pickup_address
    ? `https://maps.apple.com/?daddr=${encodeURIComponent(trip.pickup_address)}`
    : null;
  return (
    <div className="rounded-2xl border border-emerald-900 bg-emerald-950/40 p-4">
      <div className="text-xs uppercase tracking-wider text-emerald-400">Next pickup</div>
      <div className="mt-2 flex items-center gap-2 text-zinc-100">
        <User size={16} className="text-zinc-400" />
        <span className="text-base font-semibold">{trip.passenger_name}</span>
      </div>
      {trip.pickup_address && (
        <div className="mt-1 flex items-start gap-2 text-zinc-300">
          <MapPin size={14} className="mt-0.5 text-amber-400" />
          <span className="text-sm">{trip.pickup_address}</span>
        </div>
      )}
      <div className="mt-2 text-sm text-zinc-400">
        Pickup at {shortTime(trip.scheduled_at)}
      </div>
      {navUrl && (
        <a
          href={navUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-500"
        >
          <Navigation size={14} /> Navigate
        </a>
      )}
    </div>
  );
}
