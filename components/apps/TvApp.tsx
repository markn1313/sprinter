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
import { Gauge, Flag, MapPin as PinIcon, Navigation } from "lucide-react";

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

  // The TV map should always reflect the REMAINING route: van → next stop →
  // ... → final destination. Once Mark is onboard, the pickup leg is in the
  // past and shouldn't be drawn or padded into the auto-fit bounds.
  // /api/eta already computes the remaining waypoints based on trip status
  // (it strips pickup once dispatched onboard, etc), so we mirror that.
  const upcoming = (eta as unknown as { upcoming?: Array<{ kind: "pickup" | "stop" | "dropoff"; lat: number; lng: number; label: string }> })?.upcoming;

  const pins = useMemo<MapPin[]>(() => {
    if (upcoming && upcoming.length > 0) {
      let stopIdx = 0;
      return upcoming.map((w) => {
        const idx = w.kind === "stop" ? ++stopIdx : undefined;
        return { kind: w.kind, lat: w.lat, lng: w.lng, label: w.label, ...(idx != null ? { index: idx } : {}) };
      });
    }
    // Fallback while ETA hasn't loaded yet — show whatever the trip declares.
    const out: MapPin[] = [];
    if (focus?.pickup_lat != null && focus.pickup_lng != null)
      out.push({ kind: "pickup", lat: focus.pickup_lat, lng: focus.pickup_lng, label: focus.pickup_address ?? undefined });
    if (focus?.dropoff_lat != null && focus.dropoff_lng != null)
      out.push({ kind: "dropoff", lat: focus.dropoff_lat, lng: focus.dropoff_lng, label: focus.dropoff_address ?? undefined });
    stopsArr.forEach((s, i) => {
      if (s.lat != null && s.lng != null) out.push({ kind: "stop", lat: s.lat, lng: s.lng, label: s.address, index: i + 1 });
    });
    return out;
  }, [upcoming, focus, stopsArr]);

  // Live ETA polyline traces the REMAINING route from the van's current
  // position through what's left. Only fall back to the saved
  // route_polyline (computed at dispatch) before ETA arrives.
  const polyline = eta?.polyline ?? (focus as unknown as { route_polyline?: string })?.route_polyline ?? null;

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
            top: 110,
            bottom: eta && (eta.to_next || eta.to_final) ? 130 : 60,
            left: 50,
            right: 50,
          }}
          fitMaxZoom={18}
          routeLineWidth={12}
          routeGlowWidth={28}
          vanIconSize={144}
          pinScale={2.8}
          followCam={focus?.status === "onboard"}
          followCamPitch={55}
          followCamZoom={16}
        />
      </div>

      {/* Branding strip — top-left */}
      <div className="absolute left-8 top-8 z-30 flex items-center gap-3 rounded-2xl border border-zinc-800 bg-zinc-950 px-5 py-3 shadow-2xl">
        <VanIcon size={36} />
        <div>
          <div className="text-xs uppercase tracking-widest text-zinc-500">Sprinter</div>
          <div className="font-mono text-2xl font-bold tabular-nums text-zinc-100">{clock}</div>
          <div className="text-xs text-zinc-500">{dateStr}</div>
        </div>
      </div>

      {/* Next maneuver — top-center, ONLY when onboard. Big GPS-style banner. */}
      {focus?.status === "onboard" && eta?.next_maneuver && (
        <ManeuverBanner maneuver={eta.next_maneuver} />
      )}

      {/* Trip progress bar — appears below header when there's a live ETA.
          Visualizes how much of the original distance has been driven. */}
      {focus && eta?.to_final && (
        <TripProgressBar
          dispatchedAt={focus.dispatched_at ?? null}
          arrivalMinutes={eta.to_final.eta_minutes}
          etaMinutes={eta.eta_minutes ?? eta.to_final.eta_minutes}
        />
      )}

      {/* Vitals — top-right. Range stacked over Speed (no separate fuel %
          chip — Mark only cares about how far it can go and how fast). */}
      {pos && (
        <div className="absolute right-8 top-8 z-30 flex flex-col gap-3">
          <BigStat
            icon={<span className="text-emerald-400 text-2xl">↗</span>}
            value={rangeMiles(pos.fuel_pct ?? null)?.toString() ?? "—"}
            unit="MI"
            label="Range"
          />
          <BigStat
            icon={<Gauge size={24} className="text-emerald-400" />}
            value={pos.speed_mph != null ? Math.round(pos.speed_mph).toString() : "—"}
            unit="MPH"
            label="Speed"
          />
        </div>
      )}

      {/* ETA cards — bottom. Left = next stop, right = final destination.
          When the next stop IS the final destination (single-leg trip), the
          next-stop card collapses and the final-destination card spans the
          full width. */}
      {(() => {
        if (!eta || (!eta.to_next && !eta.to_final)) return null;
        const sameTarget =
          !!eta.to_next &&
          !!eta.to_final &&
          eta.to_next.label === eta.to_final.label;
        return (
          <div
            className={`absolute bottom-8 left-8 right-8 z-30 grid gap-4 ${
              sameTarget || !eta.to_next ? "grid-cols-1" : "grid-cols-2"
            }`}
          >
            {!sameTarget && eta.to_next && (
              <EtaCard
                kind="stop"
                label={eta.to_next.label}
                minutes={eta.to_next.eta_minutes}
                miles={eta.to_next.distance_miles}
                primary
                titleOverride="Next stop"
              />
            )}
            {eta.to_final && (
              <EtaCard
                kind="dropoff"
                label={eta.to_final.label}
                minutes={eta.to_final.eta_minutes}
                miles={eta.to_final.distance_miles}
                titleOverride="Final destination"
                primary={sameTarget}
              />
            )}
          </div>
        );
      })()}

      {!focus && (
        <div className="absolute bottom-12 left-8 right-8 z-30 rounded-3xl border border-zinc-800 bg-zinc-950/80 px-12 py-10 text-center backdrop-blur shadow-2xl">
          <div className="text-3xl font-semibold text-zinc-200">No active trip</div>
        </div>
      )}
    </div>
  );
}

function TripProgressBar({ dispatchedAt, etaMinutes, arrivalMinutes }: { dispatchedAt: string | null; etaMinutes: number | null; arrivalMinutes: number }) {
  // % progress = elapsed / (elapsed + remaining). Clamps to 0–100. If we
  // don't have a dispatched_at we show 100 - eta% as best-effort.
  const remaining = etaMinutes ?? arrivalMinutes;
  let pct = 0;
  if (dispatchedAt) {
    const elapsed = Math.max(0, (Date.now() - new Date(dispatchedAt).getTime()) / 60000);
    const total = elapsed + Math.max(0, remaining);
    pct = total > 0 ? Math.min(100, Math.max(0, (elapsed / total) * 100)) : 0;
  }
  const close = remaining <= 1; // arrived / arriving
  return (
    <div className="absolute inset-x-0 bottom-[136px] z-30 px-8 pointer-events-none">
      <div className="relative h-2 rounded-full bg-zinc-800/90 overflow-hidden">
        <div
          className={`absolute inset-y-0 left-0 transition-all duration-1000 ${close ? "bg-emerald-300 shadow-[0_0_24px_rgba(16,185,129,.7)]" : "bg-emerald-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function ManeuverBanner({ maneuver }: { maneuver: { step: { instruction: string; type: string; modifier?: string; street_name?: string }; meters_to: number } }) {
  const m = maneuver.step;
  const arrow = maneuverArrow(m.type, m.modifier);
  // Format distance like a real GPS: "0.3 mi" / "850 ft" / "2.4 mi"
  const meters = maneuver.meters_to;
  const dist = meters < 300
    ? `${Math.max(50, Math.round(meters * 3.281 / 50) * 50)} ft`
    : meters < 1609
    ? `${(meters * 0.000621371).toFixed(1)} mi`
    : `${(meters * 0.000621371).toFixed(1)} mi`;
  const isClose = meters < 200;
  return (
    <div
      className={`absolute left-1/2 top-8 z-30 -translate-x-1/2 flex items-center gap-5 rounded-2xl border bg-zinc-950 px-6 py-3 shadow-2xl transition-all ${
        isClose ? "border-emerald-400 ring-4 ring-emerald-500/30 scale-105" : "border-zinc-800"
      }`}
    >
      <div className={`text-6xl leading-none ${isClose ? "text-emerald-300" : "text-emerald-400"}`}>{arrow}</div>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-4xl font-bold tabular-nums text-zinc-100">{dist}</span>
          {m.street_name && (
            <span className="truncate text-2xl text-zinc-300 max-w-[600px]">on {m.street_name}</span>
          )}
        </div>
        <div className="mt-0.5 truncate text-xl text-zinc-300 max-w-[800px]">{m.instruction}</div>
      </div>
    </div>
  );
}

// Map Mapbox maneuver type+modifier to a simple Unicode arrow. Could swap
// for SVG icons later, but Unicode is bold and instantly readable on a TV.
function maneuverArrow(type: string, modifier?: string): string {
  if (type === "arrive") return "🏁";
  if (type === "roundabout" || type === "rotary") return "⟲";
  if (type === "uturn" || modifier === "uturn") return "↶";
  switch (modifier) {
    case "left":        return "←";
    case "right":       return "→";
    case "sharp left":  return "↰";
    case "sharp right": return "↱";
    case "slight left": return "↖";
    case "slight right":return "↗";
    case "straight":    return "↑";
  }
  if (type === "merge") return "⤵";
  if (type === "on ramp") return "↗";
  if (type === "off ramp") return "↘";
  return "↑";
}

function BigStat({ icon, value, unit, label }: { icon: React.ReactNode; value: string; unit: string; label: string }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 px-5 py-3 shadow-xl">
      <div className="flex items-center gap-2 text-xs uppercase tracking-widest text-zinc-400">
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

function EtaCard({ kind, label, minutes, miles, primary, titleOverride }: { kind: string; label: string; minutes: number; miles: number; primary?: boolean; titleOverride?: string }) {
  const Icon = kind === "dropoff" ? Flag : kind === "pickup" ? PinIcon : PinIcon;
  const arrival = new Date(Date.now() + minutes * 60_000).toLocaleTimeString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
  });
  // Compact two-row layout: title strip on top (label left, header right),
  // big numbers row underneath. Roughly 40% shorter than the prior card.
  return (
    <div
      className={`rounded-2xl border px-5 py-2.5 shadow-2xl ${
        primary
          ? "border-emerald-700/60 bg-zinc-950"
          : "border-blue-700/60 bg-zinc-950"
      }`}
    >
      {/* Compact 4-column row: label/destination + 3 stat cells.
          Single row so the card is half its previous height. */}
      <div className="grid grid-cols-[1.4fr_1fr_1fr_1fr] gap-4 items-center">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Icon size={16} className={primary ? "text-emerald-400" : "text-blue-400"} />
            <span className={`text-xs uppercase tracking-widest ${primary ? "text-emerald-300" : "text-blue-300"}`}>
              {titleOverride ?? (kind === "pickup" ? "Pickup" : kind === "stop" ? "Next stop" : "Final destination")}
            </span>
          </div>
          <div className="mt-0.5 truncate text-2xl font-semibold text-zinc-100 leading-tight">{label}</div>
        </div>
        <div>
          <div className="text-sm uppercase tracking-widest text-zinc-400 leading-none">Time</div>
          <div className="mt-0.5 flex items-baseline gap-1">
            <span className={`font-mono text-4xl font-bold tabular-nums leading-none ${primary ? "text-emerald-300" : "text-blue-300"}`}>{minutes}</span>
            <span className="text-base text-zinc-400">min</span>
          </div>
        </div>
        <div>
          <div className="text-sm uppercase tracking-widest text-zinc-400 leading-none">Distance</div>
          <div className="mt-0.5 flex items-baseline gap-1">
            <span className="font-mono text-4xl font-bold tabular-nums leading-none text-zinc-100">{miles}</span>
            <span className="text-base text-zinc-400">mi</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm uppercase tracking-widest text-zinc-400 leading-none">Arrival</div>
          <div className="mt-0.5 font-mono text-4xl font-bold tabular-nums leading-none text-zinc-100">{arrival}</div>
        </div>
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
