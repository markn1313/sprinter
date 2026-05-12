"use client";

import { useEffect, useMemo, useState } from "react";
import { Trip } from "@/lib/types";
import { usePosition } from "@/components/usePosition";
import { useTrips } from "@/components/useTrips";
import { useEta } from "@/components/useEta";
import ClientMap from "@/components/ClientMap";
import { MapPin } from "@/components/LiveMap";
import EtaBadge from "@/components/EtaBadge";
import EtaBottomBar from "@/components/EtaBottomBar";
import CabinControls from "@/components/CabinControls";
import PushToggle from "@/components/PushToggle";
import CabinQuickStrip from "@/components/CabinQuickStrip";
import CabinChat from "@/components/CabinChat";
import { statusLabel, shortTime, shortAddr } from "@/lib/format";
import { useRange } from "@/components/useRange";
import VanIcon from "@/components/VanIcon";
import { Map as MapIcon, MessageCircle, Sliders, Navigation, Fuel, Gauge } from "lucide-react";

type Tab = "map" | "comfort" | "chat";

export default function PassengerApp({ token }: { token: string; name: string }) {
  const { pos } = usePosition(token, 8000);
  const { trips } = useTrips(token, 5000);
  const trip = trips[0] ?? null;
  const { eta } = useEta(token, trip?.id ?? null, 20_000);
  const range = useRange(token);
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === "undefined") return "map";
    const v = window.localStorage.getItem(`sprinter:tab:${token}`);
    return (v === "comfort" || v === "chat") ? v : "map";
  });
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(`sprinter:tab:${token}`, tab);
  }, [tab, token]);
  const [focusMode, setFocusMode] = useState<"auto" | "van" | "me" | "dest">("auto");
  const [focusKey, setFocusKey] = useState(0);
  const focus = (m: typeof focusMode) => {
    setFocusMode(m);
    setFocusKey((k) => k + 1);
  };
  const [myGps, setMyGps] = useState<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (p) => setMyGps({ lat: p.coords.latitude, lng: p.coords.longitude }),
      undefined,
      { enableHighAccuracy: true, maximumAge: 10_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  const pins = useMemo<MapPin[]>(() => {
    const out: MapPin[] = [];
    if (trip?.pickup_lat != null && trip.pickup_lng != null)
      out.push({ kind: "pickup", lat: trip.pickup_lat, lng: trip.pickup_lng, label: trip.pickup_address ?? undefined });
    if (trip?.dropoff_lat != null && trip.dropoff_lng != null)
      out.push({ kind: "dropoff", lat: trip.dropoff_lat, lng: trip.dropoff_lng, label: trip.dropoff_address ?? undefined });
    const stops = (trip as unknown as { stops?: Array<{ lat: number | null; lng: number | null; address: string }> })?.stops ?? [];
    stops.forEach((s, i) => {
      if (s.lat != null && s.lng != null) out.push({ kind: "stop", lat: s.lat, lng: s.lng, label: s.address, index: i + 1 });
    });
    if (myGps) out.push({ kind: "mark", lat: myGps.lat, lng: myGps.lng, label: "You" });
    return out;
  }, [trip, myGps]);

  const polyline = (trip as unknown as { route_polyline?: string })?.route_polyline ?? eta?.polyline ?? null;
  const isLive = trip && trip.status !== "scheduled" && trip.status !== "complete" && trip.status !== "cancelled";

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-zinc-950">
      {tab === "map" && (
        <div className="relative flex-1 overflow-hidden">
          <ClientMap
            position={pos}
            pins={pins}
            polyline={polyline}
            className="h-full w-full"
            focusMode={focusMode}
            focusKey={focusKey}
          />

          {/* Status banner */}
          {trip && (
            <div className="absolute inset-x-3 top-[max(env(safe-area-inset-top),12px)] z-30">
              <StatusBanner trip={trip} etaMinutes={eta?.eta_minutes ?? null} />
            </div>
          )}

          {/* Map focus controls */}
          <div className="absolute left-3 top-[max(env(safe-area-inset-top),12px)] z-30 mt-20 flex flex-col gap-1.5">
            <FocusBtn label={<VanIcon size={26} />} onClick={() => focus("van")} title="Show van" />
            {myGps && <FocusBtn label={<span className="text-2xl leading-none">📍</span>} onClick={() => focus("me")} title="Show me" />}
            {(trip?.dropoff_lat != null || trip?.pickup_lat != null) && (
              <FocusBtn label={<span className="text-2xl leading-none">🏁</span>} onClick={() => focus("dest")} title="Show destination" />
            )}
            <FocusBtn label={<span className="text-2xl leading-none">⤢</span>} onClick={() => focus("auto")} title="Auto-fit" />
          </div>

          {/* Vitals — top-right */}
          {pos && (
            <div className="absolute right-3 top-3 z-30 flex w-fit flex-col gap-1.5">
              <VitalChip>
                <Fuel size={11} className="text-emerald-400" />
                <span>{pos.fuel_pct != null ? `${(pos.fuel_pct * 100).toFixed(0)}%` : "—"}</span>
              </VitalChip>
              <VitalChip>
                <span className="text-emerald-400">↗</span>
                <span>{range?.range_miles ?? "—"} mi</span>
              </VitalChip>
              <SpeedChip mph={pos.speed_mph ?? null} />
            </div>
          )}

          {/* Cabin climate quick-strip — bottom-center, only when ride is live */}
          {isLive && trip && (
            <div className="pointer-events-none absolute inset-x-0 bottom-24 z-30 flex justify-center">
              <div className="pointer-events-auto">
                <CabinQuickStrip token={token} tripId={trip.id} />
              </div>
            </div>
          )}

          {/* ETA bottom bar — full-width, two rows */}
          {isLive && eta && (
            <div className="absolute inset-x-3 bottom-3 z-30">
              <EtaBottomBar eta={eta} />
            </div>
          )}
        </div>
      )}

      {tab === "comfort" && (
        <div className="flex-1 overflow-y-auto">
          <header className="border-b border-zinc-900 bg-zinc-950/95 px-4 py-3">
            <div className="mx-auto max-w-2xl text-sm font-medium text-zinc-100">Cabin comfort</div>
          </header>
          <main className="mx-auto max-w-2xl space-y-3 px-3 py-3">
            <CabinControls token={token} tripId={trip?.id ?? null} />
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4 text-sm text-zinc-400">
              Tap any chip — your driver sees the request as a banner at the top of his app and adjusts the climate.
            </div>
            <PushToggle token={token} />
          </main>
        </div>
      )}

      {tab === "chat" && (
        <div className="flex flex-1 flex-col overflow-hidden">
          <header className="border-b border-zinc-900 bg-zinc-950/95 px-4 py-3">
            <div className="mx-auto max-w-2xl text-sm font-medium text-zinc-100">Ask about the van</div>
          </header>
          <CabinChat token={token} />
        </div>
      )}

      <nav className="z-40 border-t border-zinc-900 bg-zinc-950/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex max-w-2xl">
          <TabButton active={tab === "map"} onClick={() => setTab("map")} icon={<MapIcon size={20} />} label="Map" />
          <TabButton active={tab === "comfort"} onClick={() => setTab("comfort")} icon={<Sliders size={20} />} label="Comfort" />
          <TabButton active={tab === "chat"} onClick={() => setTab("chat")} icon={<MessageCircle size={20} />} label="Help" />
        </div>
      </nav>
    </div>
  );
}

function StatusBanner({ trip, etaMinutes }: { trip: Trip; etaMinutes: number | null }) {
  const headline = (() => {
    switch (trip.status) {
      case "scheduled":
        return `Pickup ${shortTime(trip.scheduled_at)}`;
      case "dispatched":
        return etaMinutes != null ? `Van is ${etaMinutes} min away` : "Van is on the way";
      case "at_pickup":
        return "Van has arrived";
      case "onboard":
        return etaMinutes != null && trip.dropoff_address ? `${etaMinutes} min to ${shortAddr(trip.dropoff_address)}` : "Onboard";
      case "at_dropoff":
        return "Arrived";
      case "complete":
        return "Trip complete";
      case "cancelled":
        return "Trip cancelled";
    }
  })();
  return (
    <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-950/85 px-4 py-2.5 backdrop-blur shadow-xl">
      <Navigation size={16} className="text-emerald-400" />
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-emerald-400">{statusLabel(trip.status)}</div>
        <div className="truncate text-base font-semibold text-zinc-100">{headline}</div>
      </div>
    </div>
  );
}

function FocusBtn({ label, onClick, title }: { label: React.ReactNode; onClick: () => void; title?: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-950/85 text-sm backdrop-blur hover:bg-zinc-900 active:scale-95"
    >
      {label}
    </button>
  );
}

function VitalChip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-950/85 px-2 py-1 text-[11px] text-zinc-200 backdrop-blur">
      {children}
    </div>
  );
}

function SpeedChip({ mph }: { mph: number | null }) {
  return (
    <div className="flex items-center justify-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-950/85 px-2.5 py-1.5 backdrop-blur">
      <span className="font-mono text-base font-bold tabular-nums text-zinc-100">
        {mph != null ? Math.round(mph) : "—"}
      </span>
      <span className="text-[10px] font-semibold text-zinc-500">MPH</span>
    </div>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium transition ${
        active ? "text-emerald-400" : "text-zinc-500 hover:text-zinc-300"
      }`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
