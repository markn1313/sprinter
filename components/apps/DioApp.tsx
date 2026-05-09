"use client";

import { useMemo, useState } from "react";
import { Trip } from "@/lib/types";
import { usePosition } from "@/components/usePosition";
import { useTrips, activeTrip } from "@/components/useTrips";
import { useEta } from "@/components/useEta";
import { useMarkLocation } from "@/components/useMarkLocation";
import { postJson } from "@/lib/api-client";
import { googleMapsTo } from "@/lib/maps-link";
import { shortTime } from "@/lib/format";
import { rangeMiles } from "@/lib/range";
import ClientMap from "@/components/ClientMap";
import { MapPin as MapPinPin } from "@/components/LiveMap";
import EtaBottomBar from "@/components/EtaBottomBar";
import CabinRequestInbox from "@/components/CabinRequestInbox";
import DriverChat, { useUnreadDriverChat } from "@/components/DriverChat";
import VanIcon from "@/components/VanIcon";
import {
  Map as MapIcon,
  List,
  MessageCircle,
  Navigation,
  User,
  MapPin,
  Check,
  Fuel,
  Gauge,
} from "lucide-react";

type Tab = "map" | "schedule" | "chat";

export default function DioApp({ token, name }: { token: string; name: string }) {
  const { trips, refresh } = useTrips(token, 4000);
  const { pos } = usePosition(token, 6000);
  const live = activeTrip(trips);
  const upcoming = trips
    .filter((t) => t.status === "scheduled")
    .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
  const focus: Trip | null = live ?? upcoming[0] ?? null;
  const { eta } = useEta(token, focus?.id ?? null, 25_000);
  const markLoc = useMarkLocation(token, 12_000);
  const unreadFromMark = useUnreadDriverChat(token, "dio");
  const [tab, setTab] = useState<Tab>("map");

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-zinc-950">
      <div className={tab === "map" ? "relative flex-1 overflow-hidden" : "hidden"}>
        <MapTab token={token} trips={trips} live={live} focus={focus} eta={eta} pos={pos} markLoc={markLoc} refresh={refresh} />
      </div>
      <div className={tab === "schedule" ? "flex-1 overflow-y-auto" : "hidden"}>
        <ScheduleTab name={name} upcoming={upcoming} />
      </div>
      <div className={tab === "chat" ? "flex flex-1 flex-col overflow-hidden" : "hidden"}>
        <header className="border-b border-zinc-900 bg-zinc-950/95 px-4 py-3">
          <div className="text-sm font-medium text-zinc-100">Chat with Mark</div>
        </header>
        <DriverChat token={token} viewerRole="dio" />
      </div>

      <nav className="z-40 border-t border-zinc-900 bg-zinc-950/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex max-w-3xl">
          <TabButton active={tab === "map"} onClick={() => setTab("map")} icon={<MapIcon size={20} />} label="Drive" />
          <TabButton active={tab === "schedule"} onClick={() => setTab("schedule")} icon={<List size={20} />} label="Schedule" />
          <TabButton active={tab === "chat"} onClick={() => setTab("chat")} icon={<MessageCircle size={20} />} label="Chat" badge={unreadFromMark} />
        </div>
      </nav>
    </div>
  );
}

function TabButton({ active, onClick, icon, label, badge }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: number }) {
  return (
    <button
      onClick={onClick}
      className={`relative flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium transition ${active ? "text-emerald-400" : "text-zinc-500 hover:text-zinc-300"}`}
    >
      <div className="relative">
        {icon}
        {badge != null && badge > 0 && (
          <span className="absolute -right-2 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-600 px-1 text-[9px] font-bold text-white">
            {badge > 9 ? "9+" : badge}
          </span>
        )}
      </div>
      <span>{label}</span>
    </button>
  );
}

function MapTab({
  token,
  trips,
  live,
  focus,
  eta,
  pos,
  markLoc,
  refresh,
}: {
  token: string;
  trips: Trip[];
  live: Trip | null;
  focus: Trip | null;
  eta: ReturnType<typeof useEta>["eta"];
  pos: ReturnType<typeof usePosition>["pos"];
  markLoc: ReturnType<typeof useMarkLocation>;
  refresh: () => void;
}) {
  const stopsArr = ((focus as unknown as { stops?: Array<{ id: string; lat: number | null; lng: number | null; address: string }> })?.stops ?? []);

  const pins = useMemo<MapPinPin[]>(() => {
    const out: MapPinPin[] = [];
    if (focus?.pickup_lat != null && focus.pickup_lng != null)
      out.push({ kind: "pickup", lat: focus.pickup_lat, lng: focus.pickup_lng, label: focus.pickup_address ?? undefined });
    if (focus?.dropoff_lat != null && focus.dropoff_lng != null)
      out.push({ kind: "dropoff", lat: focus.dropoff_lat, lng: focus.dropoff_lng, label: focus.dropoff_address ?? undefined });
    stopsArr.forEach((s, i) => {
      if (s.lat != null && s.lng != null) out.push({ kind: "stop", lat: s.lat, lng: s.lng, label: s.address, index: i + 1 });
    });
    if (markLoc) out.push({ kind: "mark", lat: markLoc.lat, lng: markLoc.lng, label: "Mark" });
    return out;
  }, [focus, stopsArr, markLoc]);

  const polyline = (focus as unknown as { route_polyline?: string })?.route_polyline ?? eta?.polyline ?? null;

  return (
    <>
      <ClientMap position={pos} pins={pins} polyline={polyline} className="h-full w-full" />

      {/* Cabin request inbox + driver hero — overlay top */}
      <div className="absolute inset-x-3 top-3 z-30 space-y-2">
        <CabinRequestInbox token={token} />
        {focus ? (
          <DriverHero trip={focus} live={!!live} etaMin={eta?.eta_minutes ?? null} token={token} onAdvance={refresh} />
        ) : (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/85 p-4 text-center backdrop-blur">
            <div className="text-sm font-semibold text-zinc-200">All clear — no trips scheduled</div>
          </div>
        )}
      </div>

      {/* Vitals — top-right */}
      {pos && (
        <div className="absolute right-3 top-3 z-30 hidden flex-col gap-1.5 sm:flex">
          <Chip><Fuel size={11} className="text-emerald-400" /><span>{pos.fuel_pct != null ? `${(pos.fuel_pct * 100).toFixed(0)}%` : "—"}</span></Chip>
          <Chip><span className="text-emerald-400">↗</span><span>{rangeMiles(pos.fuel_pct ?? null) ?? "—"} mi</span></Chip>
          <Chip><Gauge size={11} className="text-emerald-400" /><span>{pos.speed_mph != null ? `${pos.speed_mph.toFixed(0)} mph` : "—"}</span></Chip>
        </div>
      )}

      {/* ETA bottom bar */}
      {focus && eta && (
        <div className="absolute inset-x-3 bottom-3 z-30">
          <EtaBottomBar eta={eta} />
        </div>
      )}
    </>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-950/85 px-2 py-1 text-[11px] text-zinc-200 backdrop-blur">
      {children}
    </div>
  );
}

function DriverHero({
  trip,
  live,
  etaMin,
  token,
  onAdvance,
}: {
  trip: Trip;
  live: boolean;
  etaMin: number | null;
  token: string;
  onAdvance: () => void;
}) {
  const target: "pickup" | "dropoff" =
    trip.status === "onboard" || trip.status === "at_dropoff" ? "dropoff" : "pickup";
  const targetLat = target === "pickup" ? trip.pickup_lat : trip.dropoff_lat;
  const targetLng = target === "pickup" ? trip.pickup_lng : trip.dropoff_lng;
  const targetAddr = target === "pickup" ? trip.pickup_address : trip.dropoff_address;

  const navUrl =
    targetLat != null && targetLng != null
      ? googleMapsTo(targetLat, targetLng, targetAddr ?? undefined)
      : targetAddr
        ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(targetAddr)}&travelmode=driving`
        : null;

  const [busy, setBusy] = useState(false);
  const action = useMemo(() => nextAction(trip.status), [trip.status]);

  const advance = async () => {
    if (!action) return;
    setBusy(true);
    try {
      await postJson(token, `/api/trips/${trip.id}/action`, { action: action.action });
      onAdvance();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950/90 p-4 backdrop-blur shadow-2xl">
        <div className="text-[10px] uppercase tracking-widest text-zinc-500">{live ? "Active trip" : "Next pickup"}</div>
        <div className="mt-1 flex items-center gap-2">
          <User size={20} className="text-zinc-400" />
          <span className="text-xl font-bold text-zinc-100">{trip.passenger_name}</span>
        </div>
        <div className="mt-1 flex items-start gap-2 text-zinc-300">
          <MapPin size={14} className="mt-1 text-amber-400" />
          <span className="text-sm">{targetAddr ?? "(no address)"}</span>
        </div>
        <div className="mt-2 flex items-center justify-between text-sm">
          <span className="font-mono tabular-nums text-emerald-300">{etaMin != null ? `${etaMin} min` : "—"}</span>
          <span className="text-zinc-500">{live ? "" : `Pickup at ${shortTime(trip.scheduled_at)}`}</span>
        </div>
      </div>

      {navUrl && (
        <a
          href={navUrl}
          target="_blank"
          rel="noreferrer"
          className="flex h-16 w-full items-center justify-center gap-3 rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-700 text-xl font-bold text-white shadow-2xl shadow-emerald-900/40 active:scale-[0.99]"
        >
          <Navigation size={24} /> Navigate in Google Maps
        </a>
      )}

      {action && (
        <button
          onClick={advance}
          disabled={busy}
          className={`flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-lg font-bold text-white shadow-2xl active:scale-[0.99] disabled:opacity-50 ${action.color}`}
        >
          <Check size={20} /> {action.label}
        </button>
      )}
    </div>
  );
}

function nextAction(status: Trip["status"]): { label: string; action: string; color: string } | null {
  switch (status) {
    case "scheduled":
      return { label: "I'm on the way", action: "dispatch", color: "bg-blue-600 hover:bg-blue-500" };
    case "dispatched":
      return { label: "I'm at pickup", action: "at_pickup", color: "bg-amber-600 hover:bg-amber-500" };
    case "at_pickup":
      return { label: "Passenger onboard", action: "onboard", color: "bg-emerald-600 hover:bg-emerald-500" };
    case "onboard":
      return { label: "Arrived at dropoff", action: "at_dropoff", color: "bg-amber-600 hover:bg-amber-500" };
    case "at_dropoff":
      return { label: "Trip complete", action: "complete", color: "bg-emerald-700 hover:bg-emerald-600" };
    default:
      return null;
  }
}

function ScheduleTab({ name, upcoming }: { name: string; upcoming: Trip[] }) {
  return (
    <div className="mx-auto max-w-2xl px-3 pt-3 pb-6">
      <header className="border-b border-zinc-900 pb-3">
        <div className="flex items-center gap-2">
          <VanIcon size={20} />
          <span className="text-sm font-medium text-zinc-100">Schedule · {name}</span>
        </div>
      </header>
      <div className="mt-3 text-xs uppercase tracking-wider text-zinc-500">Upcoming</div>
      {upcoming.length === 0 ? (
        <div className="mt-3 rounded-2xl border border-zinc-800 bg-zinc-950/60 p-6 text-center text-sm text-zinc-500">
          No trips scheduled.
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {upcoming.map((t) => (
            <li key={t.id} className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-3">
              <div className="flex items-center justify-between">
                <div className="font-medium text-zinc-100">{t.passenger_name}</div>
                <div className="font-mono text-sm tabular-nums text-emerald-300">{shortTime(t.scheduled_at)}</div>
              </div>
              {t.pickup_address && (
                <div className="mt-1 flex items-start gap-1.5 text-xs text-zinc-400">
                  <MapPin size={11} className="mt-0.5 text-amber-400" />
                  <span className="truncate">{t.pickup_address}</span>
                </div>
              )}
              {t.dropoff_address && (
                <div className="mt-0.5 flex items-start gap-1.5 text-xs text-zinc-400">
                  <MapPin size={11} className="mt-0.5 text-blue-400" />
                  <span className="truncate">{t.dropoff_address}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
