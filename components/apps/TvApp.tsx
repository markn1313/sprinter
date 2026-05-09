"use client";

import { useEffect, useMemo, useState } from "react";
import { Trip } from "@/lib/types";
import { usePosition } from "@/components/usePosition";
import { useTrips, activeTrip } from "@/components/useTrips";
import { useEta } from "@/components/useEta";
import ClientMap from "@/components/ClientMap";
import { MapPin } from "@/components/LiveMap";
import { rangeMiles } from "@/lib/range";
import VanIcon from "@/components/VanIcon";
import { Fuel, Gauge, Flag, MapPin as PinIcon, Navigation } from "lucide-react";

// 4K-friendly TV display. Optimized for big screens — large type, no interactive
// controls. Same data sources as the rider/owner apps so it stays in sync.
export default function TvApp({ token }: { token: string }) {
  const { pos } = usePosition(token, 6000);
  const { trips } = useTrips(token, 6000);
  const live = activeTrip(trips);
  const upcomingNonLive = trips
    .filter((t) => t.status === "scheduled")
    .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime())[0];
  const focus = live ?? upcomingNonLive;
  const { eta } = useEta(token, focus?.id ?? null, 20_000);

  const stopsArr = ((focus as unknown as { stops?: Array<{ lat: number | null; lng: number | null; address: string }> })?.stops ?? []);

  const pins = useMemo<MapPin[]>(() => {
    const out: MapPin[] = [];
    if (focus?.pickup_lat != null && focus.pickup_lng != null)
      out.push({ kind: "pickup", lat: focus.pickup_lat, lng: focus.pickup_lng, label: focus.pickup_address ?? undefined });
    if (focus?.dropoff_lat != null && focus.dropoff_lng != null)
      out.push({ kind: "dropoff", lat: focus.dropoff_lat, lng: focus.dropoff_lng, label: focus.dropoff_address ?? undefined });
    stopsArr.forEach((s, i) => {
      if (s.lat != null && s.lng != null) out.push({ kind: "stop", lat: s.lat, lng: s.lng, label: s.address, index: i + 1 });
    });
    return out;
  }, [focus, stopsArr]);

  const polyline = (focus as unknown as { route_polyline?: string })?.route_polyline ?? eta?.polyline ?? null;

  // Live wall clock (PT) — small touch
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const clock = now.toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "2-digit" });
  const dateStr = now.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles", weekday: "long", month: "long", day: "numeric" });

  return (
    <div className="fixed inset-0 flex bg-zinc-950 text-zinc-100 overflow-hidden">
      {/* Map fills the whole screen */}
      <div className="absolute inset-0">
        <ClientMap
          position={pos}
          pins={pins}
          polyline={polyline}
          className="h-full w-full"
          fitBounds={true}
          fitPadding={{
            // Reserve space under the floating overlays so pins don't slide
            // under the branding strip, vitals, or ETA cards.
            top: 160,
            bottom: eta && (eta.to_next || eta.to_final) ? 260 : 80,
            left: 80,
            right: 80,
          }}
          fitMaxZoom={17}
        />
      </div>

      {/* Branding strip — top-left */}
      <div className="absolute left-8 top-8 z-30 flex items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-950/80 px-5 py-3 backdrop-blur shadow-2xl">
        <VanIcon size={36} />
        <div>
          <div className="text-xs uppercase tracking-widest text-zinc-500">Sprinter</div>
          <div className="font-mono text-2xl font-bold tabular-nums text-zinc-100">{clock}</div>
          <div className="text-xs text-zinc-500">{dateStr}</div>
        </div>
      </div>

      {/* Vitals — top-right, BIG */}
      {pos && (
        <div className="absolute right-8 top-8 z-30 grid grid-cols-3 gap-3">
          <BigStat
            icon={<Gauge size={24} className="text-emerald-400" />}
            value={pos.speed_mph != null ? Math.round(pos.speed_mph).toString() : "—"}
            unit="MPH"
            label="Speed"
          />
          <BigStat
            icon={<Fuel size={24} className="text-emerald-400" />}
            value={pos.fuel_pct != null ? `${(pos.fuel_pct * 100).toFixed(0)}%` : "—"}
            unit=""
            label="Fuel"
          />
          <BigStat
            icon={<span className="text-emerald-400 text-2xl">↗</span>}
            value={rangeMiles(pos.fuel_pct ?? null)?.toString() ?? "—"}
            unit="MI"
            label="Range"
          />
        </div>
      )}

      {/* ETA cards — bottom — VERY BIG */}
      {eta && (eta.to_next || eta.to_final) && (
        <div className="absolute bottom-8 left-8 right-8 z-30 grid grid-cols-2 gap-4">
          {eta.to_next && (
            <EtaCard
              kind={eta.to_next.kind}
              label={eta.to_next.label}
              minutes={eta.to_next.eta_minutes}
              miles={eta.to_next.distance_miles}
              primary
            />
          )}
          {eta.to_final && eta.to_next && eta.to_next.label !== eta.to_final.label ? (
            <EtaCard
              kind="dropoff"
              label={eta.to_final.label}
              minutes={eta.to_final.eta_minutes}
              miles={eta.to_final.distance_miles}
            />
          ) : (
            <RouteSummary trip={focus} stops={stopsArr} />
          )}
        </div>
      )}

      {!focus && (
        <div className="absolute bottom-12 left-8 right-8 z-30 rounded-3xl border border-zinc-800 bg-zinc-950/80 px-12 py-10 text-center backdrop-blur shadow-2xl">
          <div className="text-3xl font-semibold text-zinc-200">No active trip</div>
        </div>
      )}
    </div>
  );
}

function BigStat({ icon, value, unit, label }: { icon: React.ReactNode; value: string; unit: string; label: string }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/85 px-5 py-3 backdrop-blur shadow-xl">
      <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-zinc-500">
        {icon}
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="font-mono text-5xl font-bold tabular-nums text-zinc-100">{value}</span>
        {unit && <span className="text-base font-semibold text-zinc-500">{unit}</span>}
      </div>
    </div>
  );
}

function EtaCard({ kind, label, minutes, miles, primary }: { kind: string; label: string; minutes: number; miles: number; primary?: boolean }) {
  const Icon = kind === "dropoff" ? Flag : kind === "pickup" ? PinIcon : PinIcon;
  return (
    <div
      className={`rounded-3xl border px-8 py-6 backdrop-blur shadow-2xl ${
        primary
          ? "border-emerald-700/60 bg-gradient-to-br from-emerald-900/60 to-zinc-950/95"
          : "border-blue-700/60 bg-gradient-to-br from-blue-900/40 to-zinc-950/95"
      }`}
    >
      <div className="flex items-center gap-2 text-sm uppercase tracking-widest">
        <Icon size={18} className={primary ? "text-emerald-400" : "text-blue-400"} />
        <span className={primary ? "text-emerald-300" : "text-blue-300"}>
          {kind === "pickup" ? "Pickup" : kind === "stop" ? "Next stop" : "Final destination"}
        </span>
      </div>
      <div className="mt-2 truncate text-xl text-zinc-300">{label}</div>
      <div className="mt-3 flex items-baseline gap-3">
        <span className={`font-mono text-7xl font-bold tabular-nums ${primary ? "text-emerald-300" : "text-blue-300"}`}>{minutes}</span>
        <span className="text-2xl font-semibold text-zinc-500">min</span>
        <span className="ml-auto text-2xl font-mono tabular-nums text-zinc-400">{miles} mi</span>
      </div>
    </div>
  );
}

function RouteSummary({ trip, stops }: { trip: Trip | null; stops: Array<{ id?: string; address: string; lat: number | null; lng: number | null }> }) {
  if (!trip) return null;
  return (
    <div className="rounded-3xl border border-zinc-800 bg-zinc-950/85 px-8 py-6 backdrop-blur shadow-2xl">
      <div className="flex items-center gap-2 text-sm uppercase tracking-widest text-zinc-500">
        <Navigation size={18} className="text-zinc-400" /> Route
      </div>
      <ul className="mt-3 space-y-1.5 text-base">
        {trip.pickup_address && <li className="truncate">🚩 {trip.pickup_address}</li>}
        {stops.map((s, i) => (
          <li key={s.id ?? `${i}-${s.address}`} className="truncate">
            {i + 1}. {s.address}
          </li>
        ))}
        {trip.dropoff_address && <li className="truncate">🏁 {trip.dropoff_address}</li>}
      </ul>
    </div>
  );
}
