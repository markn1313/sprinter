"use client";

import { useEffect, useMemo, useState } from "react";
import { Trip } from "@/lib/types";
import { usePosition } from "@/components/usePosition";
import { useTrips, activeTrip } from "@/components/useTrips";
import { useEta } from "@/components/useEta";
import { useMarkGpsReporter } from "@/components/useMarkLocation";
import ClientMap from "@/components/ClientMap";
import { MapPin } from "@/components/LiveMap";
import LinkGenerator from "@/components/LinkGenerator";
import TripList from "@/components/TripList";
import DioStatusBar from "@/components/DioStatusBar";
import BouncieConnectCard from "@/components/BouncieConnectCard";
import EtaBadge from "@/components/EtaBadge";
import EtaBottomBar from "@/components/EtaBottomBar";
import SmartStop from "@/components/SmartStop";
import AddressAutocomplete from "@/components/AddressAutocomplete";
import { dollars, statusLabel } from "@/lib/format";
import { postJson } from "@/lib/api-client";
import { googleMapsMultiStop, googleMapsTo } from "@/lib/maps-link";
import CabinChat from "@/components/CabinChat";
import DriverChat, { useUnreadDriverChat } from "@/components/DriverChat";
import VanIcon from "@/components/VanIcon";
import { rangeMiles } from "@/lib/range";
import {
  Map as MapIcon,
  List,
  Settings,
  Navigation,
  Send,
  Hand,
  X,
  Loader2,
  ArrowUp,
  MessageCircle,
  HelpCircle,
  Fuel,
  Gauge,
} from "lucide-react";

type Tab = "map" | "trips" | "chat" | "help" | "settings";

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
  const unreadDriver = useUnreadDriverChat(token, "mark");

  // All tabs stay mounted so the Mapbox GL instance is never torn down on tab
  // switch. Inactive tabs are hidden via CSS instead of conditionally rendered.
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-zinc-950">
      <div className={tab === "map" ? "relative flex-1 overflow-hidden" : "hidden"}>
        <MapTab token={token} pos={pos} live={live} trips={trips} refresh={refresh} shareGps={shareGps} setShareGps={setShareGps} name={name} />
      </div>
      <div className={tab === "trips" ? "flex-1 overflow-y-auto" : "hidden"}>
        <ScrollableTab>
          <TripsTab trips={trips} origin={origin} token={token} refresh={refresh} />
        </ScrollableTab>
      </div>
      <div className={tab === "chat" ? "flex flex-1 flex-col overflow-hidden" : "hidden"}>
        <header className="border-b border-zinc-900 bg-zinc-950/95 px-4 py-3">
          <div className="mx-auto flex max-w-3xl items-center gap-2">
            <span className="text-sm font-medium text-zinc-100">Driver chat</span>
          </div>
        </header>
        <DriverChat token={token} viewerRole="mark" />
      </div>
      <div className={tab === "help" ? "flex flex-1 flex-col overflow-hidden" : "hidden"}>
        <header className="border-b border-zinc-900 bg-zinc-950/95 px-4 py-3">
          <div className="mx-auto flex max-w-3xl items-center gap-2">
            <span className="text-sm font-medium text-zinc-100">Cabin help</span>
          </div>
        </header>
        <CabinChat token={token} />
      </div>
      <div className={tab === "settings" ? "flex-1 overflow-y-auto" : "hidden"}>
        <ScrollableTab>
          <SettingsTab token={token} origin={origin} />
        </ScrollableTab>
      </div>

      <nav className="z-40 border-t border-zinc-900 bg-zinc-950/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex max-w-3xl">
          <TabButton active={tab === "map"} onClick={() => setTab("map")} icon={<MapIcon size={20} />} label="Map" />
          <TabButton active={tab === "trips"} onClick={() => setTab("trips")} icon={<List size={20} />} label="Trips" />
          <TabButton active={tab === "chat"} onClick={() => setTab("chat")} icon={<MessageCircle size={20} />} label="Chat" badge={unreadDriver} />
          <TabButton active={tab === "help"} onClick={() => setTab("help")} icon={<HelpCircle size={20} />} label="Help" />
          <TabButton active={tab === "settings"} onClick={() => setTab("settings")} icon={<Settings size={20} />} label="Settings" />
        </div>
      </nav>
    </div>
  );
}

function ScrollableTab({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <header className="sticky top-0 z-20 border-b border-zinc-900 bg-zinc-950/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <span className="text-sm font-medium text-zinc-100">Sprinter</span>
        </div>
      </header>
      {children}
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
  pos,
  live,
  trips,
  refresh,
  shareGps,
  setShareGps,
  name,
}: {
  token: string;
  pos: ReturnType<typeof usePosition>["pos"];
  live: Trip | null;
  trips: Trip[];
  refresh: () => void;
  shareGps: boolean;
  setShareGps: (v: boolean | ((p: boolean) => boolean)) => void;
  name: string;
}) {
  const { eta } = useEta(token, live?.id ?? null, 25_000);
  const [sheet, setSheet] = useState<"none" | "dispatch" | "pickup" | "trip" | "droppedPin">("none");
  const [droppedPin, setDroppedPin] = useState<{ lat: number; lng: number; address?: string } | null>(null);
  const onMapClick = async (lat: number, lng: number) => {
    setDroppedPin({ lat, lng });
    setSheet("droppedPin");
    try {
      const res = await fetch(`/api/places/reverse-geocode?lat=${lat}&lng=${lng}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setDroppedPin({ lat, lng, address: data.display });
      }
    } catch {
      // ignore
    }
  };
  const [focusMode, setFocusMode] = useState<"auto" | "van" | "me" | "dest" | "van-me" | "me-dest">("auto");
  const [focusKey, setFocusKey] = useState(0);
  const focus = (mode: typeof focusMode) => {
    setFocusMode(mode);
    setFocusKey((k) => k + 1);
  };
  const [myGps, setMyGps] = useState<{ lat: number; lng: number } | null>(null);
  useEffect(() => {
    if (!shareGps || typeof navigator === "undefined" || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (p) => setMyGps({ lat: p.coords.latitude, lng: p.coords.longitude }),
      undefined,
      { enableHighAccuracy: true, maximumAge: 10_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [shareGps]);

  const stopsArr =
    ((live as unknown as { stops?: Array<{ id: string; lat: number | null; lng: number | null; address: string }> })?.stops ?? []);

  const pins = useMemo<MapPin[]>(() => {
    const out: MapPin[] = [];
    if (live?.pickup_lat != null && live.pickup_lng != null)
      out.push({ kind: "pickup", lat: live.pickup_lat, lng: live.pickup_lng, label: live.pickup_address ?? undefined });
    if (live?.dropoff_lat != null && live.dropoff_lng != null)
      out.push({ kind: "dropoff", lat: live.dropoff_lat, lng: live.dropoff_lng, label: live.dropoff_address ?? undefined });
    stopsArr.forEach((s, i) => {
      if (s.lat != null && s.lng != null)
        out.push({ kind: "stop", lat: s.lat, lng: s.lng, label: s.address, index: i + 1 });
    });
    if (myGps) out.push({ kind: "mark", lat: myGps.lat, lng: myGps.lng, label: "You" });
    return out;
  }, [live, stopsArr, myGps]);

  const polyline = (live as unknown as { route_polyline?: string })?.route_polyline ?? eta?.polyline ?? null;

  const navUrl = useMemo(() => {
    if (!live) return null;
    const wp: Array<{ lat: number; lng: number; label?: string }> = [];
    if (live.pickup_lat != null && live.pickup_lng != null) wp.push({ lat: live.pickup_lat, lng: live.pickup_lng });
    stopsArr.forEach((s) => {
      if (s.lat != null && s.lng != null) wp.push({ lat: s.lat, lng: s.lng });
    });
    if (live.dropoff_lat != null && live.dropoff_lng != null)
      wp.push({ lat: live.dropoff_lat, lng: live.dropoff_lng, label: live.dropoff_address ?? undefined });
    if (wp.length === 0) return null;
    if (wp.length === 1) return googleMapsTo(wp[0].lat, wp[0].lng);
    return googleMapsMultiStop(wp);
  }, [live, stopsArr]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <ClientMap
        position={pos}
        pins={pins}
        polyline={polyline}
        className="h-full w-full"
        focusMode={focusMode}
        focusKey={focusKey}
        droppedPin={droppedPin}
        onMapClick={onMapClick}
        onDroppedPinClick={() => setSheet("droppedPin")}
      />

      {/* Top header — overlaid on map */}
      <header className="absolute inset-x-0 top-0 z-30 px-3 pt-[max(env(safe-area-inset-top),12px)]">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <button
            onClick={() => setShareGps((v) => !v)}
            className={`rounded-2xl border border-zinc-800 px-2.5 py-2 text-[11px] backdrop-blur ${shareGps ? "bg-violet-900/50 text-violet-200" : "bg-zinc-950/85 text-zinc-400"}`}
            title="Share live GPS"
          >
            📍 {shareGps ? "" : "off"}
          </button>
          <button
            onClick={() => setSheet("pickup")}
            className="rounded-2xl bg-gradient-to-br from-violet-600 to-fuchsia-700 px-3 py-1.5 text-xs font-semibold text-white shadow hover:from-violet-500 hover:to-fuchsia-600"
          >
            Pickup
          </button>
        </div>
      </header>

      {/* Map focus + drop-pin controls — left edge */}
      <div className="absolute left-3 top-[max(env(safe-area-inset-top),12px)] z-30 mt-14 flex flex-col gap-1.5">
        <FocusBtn label={<VanIcon size={26} />} onClick={() => focus("van")} title="Center on van" />
        {myGps && <FocusBtn label={<span className="text-2xl leading-none">📍</span>} onClick={() => focus("me")} title="Center on me" />}
        {(live?.dropoff_lat != null || live?.pickup_lat != null) && (
          <FocusBtn label={<span className="text-2xl leading-none">🏁</span>} onClick={() => focus("dest")} title="Center on destination" />
        )}
        {myGps && pos && <FocusBtn label={<span className="flex items-center gap-0.5"><VanIcon size={20} /><span className="text-base">↔</span><span className="text-base">📍</span></span>} onClick={() => focus("van-me")} title="Van + me" />}
        {myGps && (live?.dropoff_lat != null || live?.pickup_lat != null) && (
          <FocusBtn label={<span className="text-base">📍↔🏁</span>} onClick={() => focus("me-dest")} title="Me + destination" />
        )}
        <FocusBtn label={<span className="text-2xl leading-none">⤢</span>} onClick={() => focus("auto")} title="Auto-fit" />
        {droppedPin && (
          <FocusBtn
            label={<span className="text-2xl leading-none">✕</span>}
            onClick={() => setDroppedPin(null)}
            title="Clear dropped pin"
          />
        )}
      </div>

      {/* Vitals strip — top-right, no zoom controls in the way */}
      {pos && (
        <div className="absolute right-3 top-3 z-30 flex w-fit flex-col gap-1.5">
          <VitalChip>
            <Fuel size={11} className="text-emerald-400" />
            <span>{pos.fuel_pct != null ? `${(pos.fuel_pct * 100).toFixed(0)}%` : "—"}</span>
          </VitalChip>
          <VitalChip>
            <span className="text-emerald-400">↗</span>
            <span>{rangeMiles(pos.fuel_pct ?? null) ?? "—"} mi</span>
          </VitalChip>
          <SpeedChip mph={pos.speed_mph ?? null} />
        </div>
      )}

      {/* ETA bottom bar — full-width, two rows (next stop + final destination) */}
      {live && eta && (
        <div className="absolute inset-x-3 bottom-3 z-30 flex flex-col gap-2 sm:flex-row sm:items-stretch">
          <button onClick={() => setSheet("trip")} className="flex-1 text-left">
            <EtaBottomBar eta={eta} />
          </button>
          {navUrl && (
            <a
              href={navUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-center gap-2 rounded-2xl bg-zinc-950/90 px-4 py-3 text-sm font-semibold text-emerald-300 ring-1 ring-emerald-700/60 backdrop-blur shadow-2xl hover:bg-zinc-900"
            >
              <Navigation size={14} /> Maps
            </a>
          )}
        </div>
      )}
      {!live && navUrl && (
        <a
          href={navUrl}
          target="_blank"
          rel="noreferrer"
          className="absolute right-3 bottom-3 z-30 inline-flex items-center gap-2 rounded-2xl bg-zinc-950/85 px-3 py-2.5 text-sm font-semibold text-emerald-300 backdrop-blur ring-1 ring-emerald-700/60"
        >
          <Navigation size={14} /> Maps
        </a>
      )}

      {/* Bottom sheets */}
      {sheet === "dispatch" && <DispatchSheet token={token} onClose={() => setSheet("none")} onDispatched={() => { setSheet("none"); refresh(); }} />}
      {sheet === "pickup" && <PickMeUpSheet token={token} onClose={() => setSheet("none")} onDispatched={() => { setSheet("none"); refresh(); }} />}
      {sheet === "trip" && live && (
        <TripSheet
          token={token}
          trip={live}
          stops={stopsArr}
          onClose={() => setSheet("none")}
          refresh={refresh}
        />
      )}
      {sheet === "droppedPin" && droppedPin && (
        <DroppedPinSheet
          token={token}
          live={live}
          pin={droppedPin}
          onClose={() => setSheet("none")}
          onApplied={() => {
            setDroppedPin(null);
            setSheet("none");
            refresh();
          }}
        />
      )}
    </div>
  );
}

function Sheet({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) {
  return (
    <div className="absolute inset-0 z-40 flex items-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-h-[80vh] overflow-y-auto rounded-t-3xl border-t border-zinc-800 bg-zinc-950/95 p-4 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="text-xs uppercase tracking-wider text-zinc-500">{title}</div>
          <button onClick={onClose} className="rounded-full p-1 text-zinc-400 hover:bg-zinc-800">
            <X size={16} />
          </button>
        </div>
        {children}
        <div className="h-[env(safe-area-inset-bottom)]" />
      </div>
    </div>
  );
}

function DispatchSheet({ token, onClose, onDispatched }: { token: string; onClose: () => void; onDispatched: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await postJson(token, "/api/dispatch", { input: text, mintGuestLink: true });
      setText("");
      onDispatched();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="Dispatch a trip" onClose={onClose}>
      <div className="relative">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          autoFocus
          placeholder="Pick up Greg at 2pm, drop off at LAX"
          rows={3}
          className="w-full resize-none rounded-2xl border border-zinc-800 bg-zinc-900 px-3 py-2 pr-12 text-base text-zinc-100 placeholder-zinc-500 outline-none focus:border-emerald-700"
        />
        <button
          onClick={submit}
          disabled={busy || !text.trim()}
          className="absolute bottom-2 right-2 flex h-9 w-9 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg disabled:bg-zinc-700 disabled:opacity-50 enabled:hover:bg-emerald-500"
          aria-label="Dispatch"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={16} strokeWidth={3} />}
        </button>
      </div>
      <div className="mt-2 text-[11px] text-zinc-500">
        Try: <em>Pick up Sarah from Wynn at 7, drop off at Cosmo</em> · <em>Pick up Greg in 15 min, drop off at LAX</em>
      </div>
      {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
    </Sheet>
  );
}

function PickMeUpSheet({ token, onClose, onDispatched }: { token: string; onClose: () => void; onDispatched: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const trigger = async (offsetMin: number) => {
    setBusy(true);
    setErr(null);
    try {
      const coords = await getGps();
      const when = offsetMin > 0 ? new Date(Date.now() + offsetMin * 60_000).toISOString() : new Date().toISOString();
      await postJson(token, "/api/quick-pickup", {
        lat: coords.lat,
        lng: coords.lng,
        address: "My current location",
        scheduled_at: when,
        notes: offsetMin === 0 ? "Pick me up now" : `Pick me up in ${offsetMin} min`,
      });
      onDispatched();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="Pick me up — uses your live GPS" onClose={onClose}>
      <div className="grid grid-cols-4 gap-2">
        {[0, 5, 15, 30].map((m) => (
          <button
            key={m}
            onClick={() => trigger(m)}
            disabled={busy}
            className="rounded-2xl bg-violet-700 py-4 text-base font-semibold text-white hover:bg-violet-600 disabled:opacity-50"
          >
            {m === 0 ? "Now" : `${m} min`}
          </button>
        ))}
      </div>
      {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
      <div className="mt-3 text-[11px] text-zinc-500">
        Tap to dispatch the driver to your current location at the chosen time.
      </div>
    </Sheet>
  );
}

function TripSheet({
  token,
  trip,
  stops,
  onClose,
  refresh,
}: {
  token: string;
  trip: Trip;
  stops: Array<{ id: string; address: string }>;
  onClose: () => void;
  refresh: () => void;
}) {
  const addStopAddress = async (r: { lat: number; lng: number; display: string }) => {
    await postJson(token, `/api/trips/${trip.id}/stops`, {
      kind: "stop",
      address: r.display,
      lat: r.lat,
      lng: r.lng,
    });
    refresh();
  };

  return (
    <Sheet title={`Trip · ${statusLabel(trip.status)}`} onClose={onClose}>
      <div className="text-base font-semibold text-zinc-100">{trip.passenger_name}</div>
      <div className="mt-1 space-y-0.5 text-sm text-zinc-400">
        {trip.pickup_address && <div>📍 {trip.pickup_address}</div>}
        {stops.map((s, i) => (
          <div key={s.id}>
            {i + 1}. {s.address}
          </div>
        ))}
        {trip.dropoff_address && <div>🏁 {trip.dropoff_address}</div>}
      </div>
      <div className="mt-4 space-y-2">
        <SmartStop token={token} tripId={trip.id} onAdded={refresh} />
        <AddressAutocomplete token={token} onSelect={addStopAddress} placeholder="Add a stop or destination — autocompletes" />
      </div>
    </Sheet>
  );
}

function DroppedPinSheet({
  token,
  live,
  pin,
  onClose,
  onApplied,
}: {
  token: string;
  live: Trip | null;
  pin: { lat: number; lng: number; address?: string };
  onClose: () => void;
  onApplied: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pinAddress = pin.address ?? `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`;

  const setAsDestination = async () => {
    if (!live) return;
    setBusy(true);
    setErr(null);
    try {
      await fetch(`/api/trips/${live.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ dropoff_address: pinAddress }),
      });
      onApplied();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addAsStop = async () => {
    if (!live) return;
    setBusy(true);
    setErr(null);
    try {
      await postJson(token, `/api/trips/${live.id}/stops`, {
        kind: "stop",
        address: pinAddress,
        lat: pin.lat,
        lng: pin.lng,
      });
      onApplied();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // No active trip — let Mark create one straight from the pin
  const pickupHere = async () => {
    setBusy(true);
    setErr(null);
    try {
      await postJson(token, "/api/quick-pickup", {
        lat: pin.lat,
        lng: pin.lng,
        address: pinAddress,
        scheduled_at: new Date().toISOString(),
        notes: `Pick me up at ${pinAddress}`,
      });
      onApplied();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const takeMeHere = async () => {
    setBusy(true);
    setErr(null);
    try {
      const myGps = await new Promise<{ lat: number; lng: number } | null>((resolve) => {
        if (typeof navigator === "undefined" || !navigator.geolocation) {
          resolve(null);
          return;
        }
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
          () => resolve(null),
          { enableHighAccuracy: true, maximumAge: 10_000, timeout: 12_000 },
        );
      });
      await postJson(token, "/api/quick-pickup", {
        lat: myGps?.lat,
        lng: myGps?.lng,
        address: myGps ? "My current location" : "My location (unknown)",
        dropoff_address: pinAddress,
        dropoff_lat: pin.lat,
        dropoff_lng: pin.lng,
        scheduled_at: new Date().toISOString(),
        notes: `Take me to ${pinAddress}`,
      });
      onApplied();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="Pin dropped" onClose={onClose}>
      <div className="text-sm text-zinc-300">{pinAddress}</div>
      <div className="mt-3 grid grid-cols-1 gap-2">
        {live ? (
          <>
            <button
              onClick={setAsDestination}
              disabled={busy}
              className="flex items-center justify-center gap-2 rounded-2xl bg-blue-600 px-3 py-3 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
            >
              🏁 Set as destination
            </button>
            <button
              onClick={addAsStop}
              disabled={busy}
              className="flex items-center justify-center gap-2 rounded-2xl bg-cyan-600 px-3 py-3 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-50"
            >
              🚩 Add as stop on the way
            </button>
          </>
        ) : (
          <>
            <button
              onClick={takeMeHere}
              disabled={busy}
              className="flex items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-3 py-3 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              🏁 Take me here (pickup at my location)
            </button>
            <button
              onClick={pickupHere}
              disabled={busy}
              className="flex items-center justify-center gap-2 rounded-2xl bg-violet-600 px-3 py-3 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
            >
              🚩 Pick me up here
            </button>
          </>
        )}
      </div>
      {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
    </Sheet>
  );
}

function getGps(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("Geolocation not available"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error(err.message)),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 },
    );
  });
}

function TripsTab({ trips, origin, token, refresh }: { trips: Trip[]; origin: string; token: string; refresh: () => void }) {
  const [open, setOpen] = useState(false);
  const todayPay = trips
    .filter((t) => t.completed_at && Date.now() - new Date(t.completed_at).getTime() < 86400_000)
    .reduce((acc, t) => acc + (t.driver_pay_cents ?? 0), 0);
  const weekPay = trips
    .filter((t) => t.completed_at && Date.now() - new Date(t.completed_at).getTime() < 7 * 86400_000)
    .reduce((acc, t) => acc + (t.driver_pay_cents ?? 0), 0);
  return (
    <main className="mx-auto max-w-3xl space-y-3 px-3 pb-6 pt-3">
      <button
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-4 py-3 text-base font-semibold text-white shadow-lg shadow-emerald-900/40 hover:bg-emerald-500"
      >
        <Send size={16} /> New trip — Dispatch
      </button>
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Today's driver pay" value={dollars(todayPay)} />
        <Stat label="Week driver pay" value={dollars(weekPay)} />
      </div>
      <TripList trips={trips} role="mark" origin={origin} token={token} onChanged={() => window.location.reload()} />
      {open && <DispatchSheet token={token} onClose={() => setOpen(false)} onDispatched={() => { setOpen(false); refresh(); }} />}
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
    <main className="mx-auto max-w-3xl space-y-3 px-3 pb-6 pt-3">
      <BouncieConnectCard token={token} />
      <LinkGenerator token={token} origin={origin} />
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4">
        <div className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Driver status</div>
        <DioStatusBar token={token} editable={true} />
      </div>
    </main>
  );
}
