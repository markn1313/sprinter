"use client";

import { useEffect, useMemo, useState } from "react";
import { Trip } from "@/lib/types";
import { usePosition } from "@/components/usePosition";
import { useTrips, activeTrip } from "@/components/useTrips";
import { useEta } from "@/components/useEta";
import { useMarkGpsReporter } from "@/components/useMarkLocation";
import ClientMap from "@/components/ClientMap";
import { MapPin } from "@/components/LiveMap";
import DispatchBar from "@/components/DispatchBar";
import LinkGenerator from "@/components/LinkGenerator";
import TripList from "@/components/TripList";
import DioStatusBar from "@/components/DioStatusBar";
import BouncieConnectCard from "@/components/BouncieConnectCard";
import EtaBadge from "@/components/EtaBadge";
import PickMeUpButton from "@/components/PickMeUpButton";
import SmartStop from "@/components/SmartStop";
import AddressAutocomplete from "@/components/AddressAutocomplete";
import { dollars, statusLabel } from "@/lib/format";
import { postJson } from "@/lib/api-client";
import { googleMapsMultiStop, googleMapsTo } from "@/lib/maps-link";
import { Map as MapIcon, List, Settings, Navigation } from "lucide-react";

type Tab = "map" | "trips" | "settings";

export default function MarkApp({ token, name }: { token: string; name: string }) {
  const { pos } = usePosition(token, 8000);
  const { trips, refresh } = useTrips(token, 5000);
  const [tab, setTab] = useState<Tab>("map");
  const [origin, setOrigin] = useState("");
  const [shareGps, setShareGps] = useState(true);
  useMarkGpsReporter(token, shareGps);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const live = activeTrip(trips);
  const { eta } = useEta(token, live?.id ?? null, 25_000);

  return (
    <div className="min-h-screen bg-zinc-950 pb-24">
      <header className="sticky top-0 z-20 border-b border-zinc-900 bg-zinc-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-xl">🚐</span>
            <span className="text-sm font-medium text-zinc-100">Sprinter</span>
            <span className="ml-1 rounded-full bg-blue-700/30 px-2 py-0.5 text-[10px] uppercase tracking-wider text-blue-300">{name}</span>
          </div>
          <button
            onClick={() => setShareGps((v) => !v)}
            className={`rounded-full px-2 py-0.5 text-[11px] ${shareGps ? "bg-violet-900/40 text-violet-300" : "bg-zinc-800 text-zinc-400"}`}
          >
            {shareGps ? "📍 sharing" : "📍 off"}
          </button>
        </div>
      </header>

      {tab === "map" && <MapTab token={token} pos={pos} live={live} eta={eta} trips={trips} refresh={refresh} />}
      {tab === "trips" && <TripsTab trips={trips} origin={origin} />}
      {tab === "settings" && <SettingsTab token={token} origin={origin} />}

      {/* Bottom tab bar */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 border-t border-zinc-900 bg-zinc-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl">
          <TabButton active={tab === "map"} onClick={() => setTab("map")} icon={<MapIcon size={20} />} label="Map" />
          <TabButton active={tab === "trips"} onClick={() => setTab("trips")} icon={<List size={20} />} label="Trips" />
          <TabButton active={tab === "settings"} onClick={() => setTab("settings")} icon={<Settings size={20} />} label="Settings" />
        </div>
      </nav>
    </div>
  );
}

function TabButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium transition ${active ? "text-emerald-400" : "text-zinc-500 hover:text-zinc-300"}`}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function MapTab({ token, pos, live, eta, trips, refresh }: { token: string; pos: ReturnType<typeof usePosition>["pos"]; live: Trip | null; eta: ReturnType<typeof useEta>["eta"]; trips: Trip[]; refresh: () => void }) {
  const stopsArr = ((live as unknown as { stops?: Array<{ id: string; lat: number | null; lng: number | null; address: string }> })?.stops ?? []);
  const pins = useMemo<MapPin[]>(() => {
    const out: MapPin[] = [];
    if (live?.pickup_lat != null && live.pickup_lng != null) out.push({ kind: "pickup", lat: live.pickup_lat, lng: live.pickup_lng, label: live.pickup_address ?? undefined });
    if (live?.dropoff_lat != null && live.dropoff_lng != null) out.push({ kind: "dropoff", lat: live.dropoff_lat, lng: live.dropoff_lng, label: live.dropoff_address ?? undefined });
    stopsArr.forEach((s, i) => {
      if (s.lat != null && s.lng != null) out.push({ kind: "stop", lat: s.lat, lng: s.lng, label: s.address, index: i + 1 });
    });
    return out;
  }, [live, stopsArr]);

  const polyline = (live as unknown as { route_polyline?: string })?.route_polyline ?? eta?.polyline ?? null;

  const addStopAddress = async (r: { lat: number; lng: number; display: string }) => {
    if (!live) return;
    await postJson(token, `/api/trips/${live.id}/stops`, { kind: "stop", address: r.display, lat: r.lat, lng: r.lng });
    refresh();
  };

  const navUrl = useMemo(() => {
    if (!live) return null;
    const wp: Array<{ lat: number; lng: number; label?: string }> = [];
    if (live.pickup_lat != null && live.pickup_lng != null) wp.push({ lat: live.pickup_lat, lng: live.pickup_lng });
    stopsArr.forEach((s) => { if (s.lat != null && s.lng != null) wp.push({ lat: s.lat, lng: s.lng }); });
    if (live.dropoff_lat != null && live.dropoff_lng != null) wp.push({ lat: live.dropoff_lat, lng: live.dropoff_lng, label: live.dropoff_address ?? undefined });
    if (wp.length === 0) return null;
    if (wp.length === 1) return googleMapsTo(wp[0].lat, wp[0].lng);
    return googleMapsMultiStop(wp);
  }, [live, stopsArr]);

  return (
    <main className="mx-auto max-w-3xl space-y-3 px-3 pt-3">
      <div className="relative h-[58vh] min-h-[360px] overflow-hidden rounded-2xl border border-zinc-800">
        <ClientMap position={pos} pins={pins} polyline={polyline} />
        {live && eta && (
          <div className="absolute left-3 top-3"><EtaBadge eta={eta} variant="hero" label={live.status === "onboard" ? "to dropoff" : "to pickup"} /></div>
        )}
        {navUrl && (
          <a href={navUrl} target="_blank" rel="noreferrer" className="absolute right-3 bottom-3 inline-flex items-center gap-2 rounded-2xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg hover:bg-emerald-500">
            <Navigation size={16} /> Open in Google Maps
          </a>
        )}
      </div>

      {/* Compose row — dispatch + pick-me-up */}
      <div className="grid gap-2 sm:grid-cols-[1fr,auto]">
        <DispatchBar token={token} onDispatched={refresh} />
        <PickMeUpButton token={token} onDispatched={refresh} />
      </div>

      {/* If a live trip exists: Smart-stop & address add. Otherwise hidden. */}
      {live && (
        <>
          <SmartStop token={token} tripId={live.id} onAdded={refresh} />
          <AddressAutocomplete token={token} onSelect={addStopAddress} />
          <ActiveTripSummary trip={live} stops={stopsArr} />
        </>
      )}
    </main>
  );
}

function ActiveTripSummary({ trip, stops }: { trip: Trip; stops: Array<{ id: string; address: string }> }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-3 text-sm">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500">Current trip · {statusLabel(trip.status)}</div>
      <div className="mt-1 text-base font-semibold text-zinc-100">{trip.passenger_name}</div>
      <div className="mt-1 space-y-0.5 text-zinc-400">
        {trip.pickup_address && <div>📍 {trip.pickup_address}</div>}
        {stops.map((s, i) => <div key={s.id}>{i + 1}. {s.address}</div>)}
        {trip.dropoff_address && <div>🏁 {trip.dropoff_address}</div>}
      </div>
    </div>
  );
}

function TripsTab({ trips, origin }: { trips: Trip[]; origin: string }) {
  const todayPay = trips.filter((t) => t.completed_at && Date.now() - new Date(t.completed_at).getTime() < 86400_000).reduce((acc, t) => acc + (t.driver_pay_cents ?? 0), 0);
  const weekPay = trips.filter((t) => t.completed_at && Date.now() - new Date(t.completed_at).getTime() < 7 * 86400_000).reduce((acc, t) => acc + (t.driver_pay_cents ?? 0), 0);
  return (
    <main className="mx-auto max-w-3xl space-y-3 px-3 pt-3">
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Today's Dio pay" value={dollars(todayPay)} />
        <Stat label="Week Dio pay" value={dollars(weekPay)} />
      </div>
      <TripList trips={trips} role="mark" origin={origin} />
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-1 font-mono text-2xl tabular-nums text-emerald-300">{value}</div>
    </div>
  );
}

function SettingsTab({ token, origin }: { token: string; origin: string }) {
  return (
    <main className="mx-auto max-w-3xl space-y-3 px-3 pt-3">
      <BouncieConnectCard token={token} />
      <LinkGenerator token={token} origin={origin} />
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4">
        <div className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Driver status (read/edit)</div>
        <DioStatusBar token={token} editable={true} />
      </div>
    </main>
  );
}
