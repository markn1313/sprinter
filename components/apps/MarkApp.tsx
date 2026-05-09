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
import PushToggle from "@/components/PushToggle";
import DioStatusBar from "@/components/DioStatusBar";
import BouncieConnectCard from "@/components/BouncieConnectCard";
import EtaBadge from "@/components/EtaBadge";
import EtaBottomBar from "@/components/EtaBottomBar";
import SmartStop from "@/components/SmartStop";
import AddressAutocomplete from "@/components/AddressAutocomplete";
import { statusLabel } from "@/lib/format";
import { postJson } from "@/lib/api-client";
import { googleMapsMultiStop, googleMapsTo } from "@/lib/maps-link";
import CabinChat from "@/components/CabinChat";
import CabinQuickStrip from "@/components/CabinQuickStrip";
import DriverChat, { useUnreadDriverChat } from "@/components/DriverChat";
import TripDetailApp from "@/components/apps/TripDetailApp";
import VanIcon from "@/components/VanIcon";
import { rangeMiles } from "@/lib/range";
import {
  Map as MapIcon,
  Route as RouteIcon,
  Settings,
  Navigation,
  X,
  Loader2,
  ArrowUp,
  MessageCircle,
  HelpCircle,
  Fuel,
  Trash2,
} from "lucide-react";

type Tab = "map" | "trip" | "chat" | "help" | "settings";

export default function MarkApp({ token, name }: { token: string; name: string }) {
  const { pos } = usePosition(token, 8000);
  const { trips, refresh } = useTrips(token, 5000);
  // Restore tab + open trip on refresh so reload doesn't dump us back to the map.
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === "undefined") return "map";
    const v = window.localStorage.getItem(`sprinter:tab:${token}`);
    // Migrate old "trips" value to "trip" silently
    if (v === "trips" || v === "trip") return "trip";
    return (v === "chat" || v === "help" || v === "settings") ? v : "map";
  });
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(`sprinter:tab:${token}`, tab);
  }, [tab, token]);

  const [origin, setOrigin] = useState("");
  const [shareGps, setShareGps] = useState(true);
  useMarkGpsReporter(token, shareGps);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const live = activeTrip(trips);
  const unreadDriver = useUnreadDriverChat(token, "mark");

  // Single-trip mode: live trip, else next-scheduled. Shared between Map and Trip tabs.
  const mapTrip = useMemo<Trip | null>(() => {
    if (live) return live;
    const upcoming = trips
      .filter((t) => t.status === "scheduled")
      .sort(
        (a, b) =>
          new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime(),
      );
    return upcoming[0] ?? null;
  }, [live, trips]);

  // All tabs stay mounted so the Mapbox GL instance is never torn down on tab
  // switch. Inactive tabs are hidden via CSS instead of conditionally rendered.
  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-zinc-950">
      <div className={tab === "map" ? "relative flex-1 overflow-hidden" : "hidden"}>
        <MapTab token={token} pos={pos} live={live} mapTrip={mapTrip} refresh={refresh} shareGps={shareGps} setShareGps={setShareGps} name={name} />
      </div>
      <div className={tab === "trip" ? "flex flex-1 flex-col overflow-hidden" : "hidden"}>
        {mapTrip ? (
          <TripDetailApp token={token} tripId={mapTrip.id} hideMap />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-zinc-500">
            No trip yet — drop a pin or tap Pickup.
          </div>
        )}
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
          <TabButton
            active={tab === "trip"}
            onClick={() => setTab("trip")}
            icon={<RouteIcon size={20} />}
            label="Trip"
          />
          <TabButton active={tab === "chat"} onClick={() => setTab("chat")} icon={<MessageCircle size={20} />} label="Chat" badge={unreadDriver} />
          <TabButton active={tab === "help"} onClick={() => setTab("help")} icon={<HelpCircle size={20} />} label="Help" />
          <TabButton active={tab === "settings"} onClick={() => setTab("settings")} icon={<Settings size={20} />} label="Settings" />
        </div>
      </nav>
    </div>
  );
}

function ScrollableTab({ children }: { children: React.ReactNode }) {
  return <div className="flex-1 overflow-y-auto">{children}</div>;
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
  mapTrip,
  refresh,
  shareGps,
  setShareGps,
  name,
}: {
  token: string;
  pos: ReturnType<typeof usePosition>["pos"];
  live: Trip | null;
  mapTrip: Trip | null;
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
    ((mapTrip as unknown as { stops?: Array<{ id: string; lat: number | null; lng: number | null; address: string }> })?.stops ?? []);

  const pins = useMemo<MapPin[]>(() => {
    const out: MapPin[] = [];
    if (mapTrip?.pickup_lat != null && mapTrip.pickup_lng != null)
      out.push({ kind: "pickup", lat: mapTrip.pickup_lat, lng: mapTrip.pickup_lng, label: mapTrip.pickup_address ?? undefined });
    if (mapTrip?.dropoff_lat != null && mapTrip.dropoff_lng != null)
      out.push({ kind: "dropoff", lat: mapTrip.dropoff_lat, lng: mapTrip.dropoff_lng, label: mapTrip.dropoff_address ?? undefined });
    stopsArr.forEach((s, i) => {
      if (s.lat != null && s.lng != null)
        out.push({ kind: "stop", lat: s.lat, lng: s.lng, label: s.address, index: i + 1 });
    });
    if (myGps) out.push({ kind: "mark", lat: myGps.lat, lng: myGps.lng, label: "You" });
    return out;
  }, [mapTrip, stopsArr, myGps]);

  const polyline = (mapTrip as unknown as { route_polyline?: string })?.route_polyline ?? eta?.polyline ?? null;

  const navUrl = useMemo(() => {
    if (!mapTrip) return null;
    const wp: Array<{ lat: number; lng: number; label?: string }> = [];
    if (mapTrip.pickup_lat != null && mapTrip.pickup_lng != null) wp.push({ lat: mapTrip.pickup_lat, lng: mapTrip.pickup_lng });
    stopsArr.forEach((s) => {
      if (s.lat != null && s.lng != null) wp.push({ lat: s.lat, lng: s.lng });
    });
    if (mapTrip.dropoff_lat != null && mapTrip.dropoff_lng != null)
      wp.push({ lat: mapTrip.dropoff_lat, lng: mapTrip.dropoff_lng, label: mapTrip.dropoff_address ?? undefined });
    if (wp.length === 0) return null;
    if (wp.length === 1) return googleMapsTo(wp[0].lat, wp[0].lng);
    return googleMapsMultiStop(wp);
  }, [mapTrip, stopsArr]);

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

      {/* Map focus controls — left edge. (Drop-pin via long-press; no rail button.) */}
      <div className="absolute left-3 top-[max(env(safe-area-inset-top),12px)] z-30 mt-14 flex flex-col gap-1.5">
        <FocusBtn label={<VanIcon size={26} />} onClick={() => focus("van")} title="Center on van" />
        {(mapTrip?.dropoff_lat != null || mapTrip?.pickup_lat != null) && (
          <FocusBtn label={<span className="text-2xl leading-none">🏁</span>} onClick={() => focus("dest")} title="Center on destination" />
        )}
        {myGps && pos && <FocusBtn label={<span className="flex items-center gap-0.5"><VanIcon size={20} /><span className="text-base">↔</span><span className="text-base">📍</span></span>} onClick={() => focus("van-me")} title="Van + me" />}
        {myGps && (mapTrip?.dropoff_lat != null || mapTrip?.pickup_lat != null) && (
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

      {/* Cabin climate quick-strip — bottom-center, only when a trip is active */}
      {live && (
        <div className="pointer-events-none absolute inset-x-0 bottom-24 z-30 flex justify-center">
          <div className="pointer-events-auto">
            <CabinQuickStrip token={token} tripId={live.id} />
          </div>
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
      {/* Maps fallback — show whenever navUrl exists and the ETA-bottom-bar branch
          isn't rendering (no live trip OR eta hasn't loaded yet). Previously this
          only fired when !live, so a live trip with no ETA briefly hid the button. */}
      {(!live || !eta) && navUrl && (
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
          trip={mapTrip}
          stops={stopsArr}
          pin={droppedPin}
          onClose={() => setSheet("none")}
          onRemovePin={() => {
            setDroppedPin(null);
            setSheet("none");
          }}
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

// Compute total road distance for a candidate waypoint sequence by hitting the
// /api/eta POST endpoint (which uses Mapbox Directions on the server). Returns
// total miles or null on failure.
async function totalDistanceMiles(
  token: string,
  waypoints: Array<{ lat: number; lng: number }>,
): Promise<number | null> {
  if (waypoints.length < 2) return null;
  try {
    const res = await fetch("/api/eta", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ waypoints }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.to_final?.distance_miles ?? null;
  } catch {
    return null;
  }
}

function DroppedPinSheet({
  token,
  trip,
  stops,
  pin,
  onClose,
  onRemovePin,
  onApplied,
}: {
  token: string;
  trip: Trip | null;
  stops: Array<{ id: string; lat: number | null; lng: number | null; address: string }>;
  pin: { lat: number; lng: number; address?: string };
  onClose: () => void;
  onRemovePin: () => void;
  onApplied: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const pinAddress = pin.address ?? `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`;

  // Smart-insert: build [pickup, ...stops, dropoff], try every internal position,
  // pick the one with the shortest total route distance. Falls back to append when
  // there are too many stops or routing fails.
  const smartAddAsStop = async () => {
    if (!trip) return;
    setBusy(true);
    setErr(null);
    try {
      // Build the existing waypoint chain
      const chain: Array<{ lat: number; lng: number }> = [];
      if (trip.pickup_lat != null && trip.pickup_lng != null)
        chain.push({ lat: trip.pickup_lat, lng: trip.pickup_lng });
      stops.forEach((s) => {
        if (s.lat != null && s.lng != null) chain.push({ lat: s.lat, lng: s.lng });
      });
      if (trip.dropoff_lat != null && trip.dropoff_lng != null)
        chain.push({ lat: trip.dropoff_lat, lng: trip.dropoff_lng });

      // stopsCount = how many intermediate stops currently exist
      const stopsCount = stops.filter((s) => s.lat != null && s.lng != null).length;

      // Default: append at end of stops list (server side index = stopsCount)
      let chosenIdx = stopsCount;

      // Smart-insert is only worth doing when N <= 5 (≤ 7 candidate sequences).
      // For larger trips, just append — the user can re-order in trip detail.
      // Insertion happens between pickup and dropoff: candidate positions in the
      // chain are 1..chain.length-1 (so we never displace pickup or dropoff).
      // The matching server-side stops index is candidatePos - 1 (since position 1
      // in the chain == stops[0]).
      if (chain.length >= 2 && stopsCount <= 5) {
        let bestDist = Infinity;
        let bestServerIdx = chosenIdx;
        for (let pos = 1; pos < chain.length; pos++) {
          const candidate = [...chain];
          candidate.splice(pos, 0, { lat: pin.lat, lng: pin.lng });
          // eslint-disable-next-line no-await-in-loop
          const d = await totalDistanceMiles(token, candidate);
          if (d != null && d < bestDist) {
            bestDist = d;
            bestServerIdx = pos - 1; // stops index space
          }
        }
        if (Number.isFinite(bestDist)) chosenIdx = bestServerIdx;
      }

      await postJson(token, `/api/trips/${trip.id}/stops`, {
        kind: "stop",
        address: pinAddress,
        lat: pin.lat,
        lng: pin.lng,
        index: chosenIdx,
      });
      onApplied();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setAsNewPickup = async () => {
    if (!trip) return;
    setBusy(true);
    setErr(null);
    try {
      await fetch(`/api/trips/${trip.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          pickup_address: pinAddress,
          pickup_lat: pin.lat,
          pickup_lng: pin.lng,
        }),
      });
      onApplied();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setAsNewDropoff = async () => {
    if (!trip) return;
    setBusy(true);
    setErr(null);
    try {
      await fetch(`/api/trips/${trip.id}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          dropoff_address: pinAddress,
          dropoff_lat: pin.lat,
          dropoff_lng: pin.lng,
        }),
      });
      onApplied();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // No active/scheduled trip — let Mark create one straight from the pin
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
        {trip ? (
          <>
            <button
              onClick={smartAddAsStop}
              disabled={busy}
              className="flex items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-3 py-3 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : "🚩"} Add as stop (smart-insert)
            </button>
            <button
              onClick={setAsNewPickup}
              disabled={busy}
              className="flex items-center justify-center gap-2 rounded-2xl border border-zinc-700 bg-transparent px-3 py-3 text-sm font-semibold text-zinc-100 hover:bg-zinc-900 disabled:opacity-50"
            >
              📍 Set as new pickup
            </button>
            <button
              onClick={setAsNewDropoff}
              disabled={busy}
              className="flex items-center justify-center gap-2 rounded-2xl border border-zinc-700 bg-transparent px-3 py-3 text-sm font-semibold text-zinc-100 hover:bg-zinc-900 disabled:opacity-50"
            >
              🏁 Set as new dropoff
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
        <button
          onClick={onRemovePin}
          disabled={busy}
          className="flex items-center justify-center gap-2 rounded-2xl bg-transparent px-3 py-3 text-sm font-semibold text-red-400 hover:bg-red-950/40 disabled:opacity-50"
        >
          <Trash2 size={14} /> Remove pin
        </button>
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

function SettingsTab({ token, origin }: { token: string; origin: string }) {
  return (
    <main className="mx-auto max-w-3xl space-y-3 px-3 pb-6 pt-3">
      <PushToggle token={token} />
      <BouncieConnectCard token={token} />
      <LinkGenerator token={token} origin={origin} />
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4">
        <div className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Driver status</div>
        <DioStatusBar token={token} editable={true} />
      </div>
    </main>
  );
}
