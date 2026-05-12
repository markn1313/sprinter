"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Trip } from "@/lib/types";
import { usePosition } from "@/components/usePosition";
import { useTrips, activeTrip } from "@/components/useTrips";
import { useEta } from "@/components/useEta";
import { useMarkGpsReporter } from "@/components/useMarkLocation";
import ClientMap from "@/components/ClientMap";
import { MapPin } from "@/components/LiveMap";
import LinkGenerator from "@/components/LinkGenerator";
import PushToggle from "@/components/PushToggle";
import InsightsCard from "@/components/InsightsCard";
import ShareTripButton from "@/components/ShareTripButton";
import TripRecapCard from "@/components/TripRecapCard";
import LeaveByCard from "@/components/LeaveByCard";
import FuelAlertCard from "@/components/FuelAlertCard";
import EtaCard from "@/components/EtaCard";
import VoiceCabin from "@/components/VoiceCabin";
import DioStatusBar from "@/components/DioStatusBar";
import BouncieConnectCard from "@/components/BouncieConnectCard";
import EtaBadge from "@/components/EtaBadge";
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

function markManeuverArrow(type: string, modifier?: string): string {
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
  const localGeoOk = useRef<boolean>(false);
  useEffect(() => {
    if (!shareGps || typeof navigator === "undefined" || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (p) => {
        localGeoOk.current = true;
        setMyGps({ lat: p.coords.latitude, lng: p.coords.longitude });
      },
      () => {
        // Permission denied / unavailable — fall back to server-side
        // mark_location (Mark's iPhone PWA posts to /api/mark-location).
        localGeoOk.current = false;
      },
      { enableHighAccuracy: true, maximumAge: 10_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [shareGps]);
  // Server-side fallback: poll /api/mark-location every 20s so this tab can
  // see Mark's iPhone-reported position even when local navigator.geolocation
  // is denied or unavailable (dev Chrome sessions, etc.).
  useEffect(() => {
    if (!shareGps) return;
    let cancel = false;
    const tick = async () => {
      if (cancel || localGeoOk.current) return;
      try {
        const r = await fetch("/api/mark-location", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return;
        const j = (await r.json()) as { location?: { lat: number; lng: number; reported_at: string } | null };
        if (cancel || localGeoOk.current) return;
        if (j.location) {
          // 10-minute staleness threshold — iOS PWA gets backgrounded
          // and stops reporting; the last known position is still useful
          // as long as Mark hasn't been on the move recently. A live trip
          // (driver picking him up) is the only case where stale-by-minutes
          // matters, and that path is handled by the live ETA hook anyway.
          const ageS = (Date.now() - new Date(j.location.reported_at).getTime()) / 1000;
          if (ageS < 600) setMyGps({ lat: j.location.lat, lng: j.location.lng });
        }
      } catch {}
    };
    tick();
    const id = setInterval(tick, 20_000);
    return () => {
      cancel = true;
      clearInterval(id);
    };
  }, [shareGps, token]);

  const stopsArr =
    ((mapTrip as unknown as { stops?: Array<{ id: string; lat: number | null; lng: number | null; address: string }> })?.stops ?? []);

  // Mirror TV behavior: pin set comes from the live ETA's `upcoming` array
  // (which knows to drop pickup once onboard, etc.) so Mark's home map
  // shows only what's left of the trip.
  const upcoming = (eta as unknown as { upcoming?: Array<{ kind: "pickup" | "stop" | "dropoff"; lat: number; lng: number; label: string }> })?.upcoming;

  const pins = useMemo<MapPin[]>(() => {
    const out: MapPin[] = [];
    // No active trip → show ONLY the "you" pin so the map fits to van + me
    // and renders the van→me route polyline. Don't surface a scheduled
    // trip's pickup/dropoff here — that pulls the camera way out and is
    // not what Mark wants to look at while idle.
    if (!live) {
      if (myGps) out.push({ kind: "mark", lat: myGps.lat, lng: myGps.lng, label: "You" });
      return out;
    }
    // Resolve stop UUIDs by matching label against the server-side stops
    // array — `upcoming` (from eta) doesn't include the id directly.
    const stopByLabel = new Map<string, string>();
    stopsArr.forEach((s) => {
      if (s.id) stopByLabel.set(s.address, s.id);
    });
    if (upcoming && upcoming.length > 0) {
      let stopIdx = 0;
      upcoming.forEach((w) => {
        const idx = w.kind === "stop" ? ++stopIdx : undefined;
        const id =
          w.kind === "pickup"
            ? "pickup"
            : w.kind === "dropoff"
              ? "dropoff"
              : stopByLabel.get(w.label) ?? undefined;
        out.push({ kind: w.kind, lat: w.lat, lng: w.lng, label: w.label, ...(idx != null ? { index: idx } : {}), ...(id ? { id } : {}) });
      });
    } else {
      // Fallback while ETA hasn't loaded yet
      if (mapTrip?.pickup_lat != null && mapTrip.pickup_lng != null)
        out.push({ kind: "pickup", id: "pickup", lat: mapTrip.pickup_lat, lng: mapTrip.pickup_lng, label: mapTrip.pickup_address ?? undefined });
      if (mapTrip?.dropoff_lat != null && mapTrip.dropoff_lng != null)
        out.push({ kind: "dropoff", id: "dropoff", lat: mapTrip.dropoff_lat, lng: mapTrip.dropoff_lng, label: mapTrip.dropoff_address ?? undefined });
      stopsArr.forEach((s, i) => {
        if (s.lat != null && s.lng != null)
          out.push({ kind: "stop", id: s.id, lat: s.lat, lng: s.lng, label: s.address, index: i + 1 });
      });
    }
    if (myGps) out.push({ kind: "mark", lat: myGps.lat, lng: myGps.lng, label: "You" });
    return out;
  }, [live, upcoming, mapTrip, stopsArr, myGps]);

  // Reverse-geocode Mark's GPS so the bottom card shows his actual
  // street/neighborhood ("Newport Heights, CA") instead of the literal
  // word "You". Refreshes when he moves > ~50m (3 decimals on lat/lng).
  const [meAddress, setMeAddress] = useState<string | null>(null);
  useEffect(() => {
    if (!myGps) {
      setMeAddress(null);
      return;
    }
    let cancel = false;
    (async () => {
      try {
        const r = await fetch(`/api/places/reverse-geocode?lat=${myGps.lat}&lng=${myGps.lng}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return;
        const j = (await r.json()) as { display?: string };
        if (!cancel && j.display) setMeAddress(j.display);
      } catch {
        // keep prior address
      }
    })();
    return () => {
      cancel = true;
    };
  }, [token, myGps?.lat?.toFixed(3), myGps?.lng?.toFixed(3)]);

  // When NO trip is active, fetch a "van → me" route so Mark sees how the
  // van would get to where he's standing right now. Refreshes whenever the
  // van or his GPS moves meaningfully. The same /api/eta POST endpoint the
  // trip detail editor uses — passes a single waypoint (Mark's position)
  // and reads back the polyline + congestion + eta_minutes against the
  // van's current location.
  const [vanToMe, setVanToMe] = useState<{ polyline: string | null; congestion: ("low"|"moderate"|"heavy"|"severe"|"unknown")[] | null; eta_minutes: number | null; distance_miles: number | null }>(
    { polyline: null, congestion: null, eta_minutes: null, distance_miles: null },
  );
  useEffect(() => {
    if (live) {
      setVanToMe({ polyline: null, congestion: null, eta_minutes: null, distance_miles: null });
      return;
    }
    if (!myGps || !pos) return;
    let cancel = false;
    (async () => {
      try {
        const r = await fetch("/api/eta", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ waypoints: [{ lat: myGps.lat, lng: myGps.lng, kind: "stop", label: "You" }] }),
        });
        if (!r.ok) return;
        const j = (await r.json()) as { polyline?: string | null; congestion?: ("low"|"moderate"|"heavy"|"severe"|"unknown")[] | null; eta_minutes?: number | null; distance_miles?: number | null };
        if (!cancel) {
          setVanToMe({
            polyline: j.polyline ?? null,
            congestion: j.congestion ?? null,
            eta_minutes: j.eta_minutes ?? null,
            distance_miles: j.distance_miles ?? null,
          });
        }
      } catch {
        // ignore — keep the previous polyline
      }
    })();
    return () => {
      cancel = true;
    };
    // Re-run roughly every time the van moves > ~50m or myGps changes.
  }, [live, token, pos?.lat?.toFixed(3), pos?.lng?.toFixed(3), myGps?.lat?.toFixed(3), myGps?.lng?.toFixed(3)]);

  // Live ETA polyline first (reflects van's current position through what's
  // remaining); when no live trip, prefer the van→me route so Mark sees how
  // the van would reach him. Final fallback: saved trip route_polyline.
  const polyline = eta?.polyline ?? vanToMe.polyline ?? (mapTrip as unknown as { route_polyline?: string })?.route_polyline ?? null;
  const congestion = eta?.congestion ?? vanToMe.congestion ?? null;

  // "Van is X min / Y mi from me" — prefer the Mapbox-computed route ETA
  // (vanToMe) when we have it; fall back to a straight-line haversine +
  // naive 25-mph estimate while the route is loading.
  const vanFromMe = useMemo(() => {
    if (!pos || !myGps) return null;
    if (vanToMe.eta_minutes != null && vanToMe.distance_miles != null) {
      return {
        miles: vanToMe.distance_miles,
        minutes: vanToMe.eta_minutes,
      };
    }
    const R = 3959; // miles
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(myGps.lat - pos.lat);
    const dLng = toRad(myGps.lng - pos.lng);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(pos.lat)) * Math.cos(toRad(myGps.lat)) * Math.sin(dLng / 2) ** 2;
    const miles = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    const speed = (pos.speed_mph ?? 0) > 5 ? (pos.speed_mph as number) : 25;
    const minutes = Math.max(1, Math.round((miles / speed) * 60));
    return { miles: +miles.toFixed(miles < 10 ? 1 : 0), minutes };
  }, [pos, myGps, vanToMe]);

  // Drag a pin to update its location. Reverse-geocode the new coords for
  // a friendly address, then PATCH the trip (pickup/dropoff) or replace
  // the stops array (intermediate stop). Trips refresh via realtime on
  // success so the map snaps to the persisted coordinates.
  const handlePinDrag = async (pin: MapPin, newLat: number, newLng: number) => {
    if (!mapTrip) return;
    let address: string | undefined;
    try {
      const r = await fetch(`/api/places/reverse-geocode?lat=${newLat}&lng=${newLng}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const j = (await r.json()) as { display?: string };
      address = j.display;
    } catch {
      address = `${newLat.toFixed(5)}, ${newLng.toFixed(5)}`;
    }
    try {
      if (pin.kind === "pickup") {
        await fetch(`/api/trips/${mapTrip.id}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ pickup_lat: newLat, pickup_lng: newLng, pickup_address: address }),
        });
      } else if (pin.kind === "dropoff") {
        await fetch(`/api/trips/${mapTrip.id}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ dropoff_lat: newLat, dropoff_lng: newLng, dropoff_address: address }),
        });
      } else if (pin.kind === "stop") {
        // Build the next stops array — match by id (preferred) or fall back
        // to lat/lng + label proximity if no id was wired.
        const next = stopsArr.map((s) => {
          const matches =
            (pin.id && s.id === pin.id) ||
            (!pin.id && Math.abs((s.lat ?? 0) - pin.lat) < 1e-6 && Math.abs((s.lng ?? 0) - pin.lng) < 1e-6);
          return matches ? { ...s, lat: newLat, lng: newLng, address: address ?? s.address } : s;
        });
        await fetch(`/api/trips/${mapTrip.id}/stops`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ stops: next }),
        });
      }
      refresh();
    } catch (err) {
      console.warn("[MarkApp] pin drag PATCH failed", err);
    }
  };

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
        congestion={congestion}
        className="h-full w-full"
        focusMode={focusMode}
        focusKey={focusKey}
        droppedPin={droppedPin}
        onMapClick={onMapClick}
        onDroppedPinClick={() => setSheet("droppedPin")}
        onPinDragEnd={mapTrip ? handlePinDrag : undefined}
        routeLineWidth={6}
        routeGlowWidth={14}
        vanIconSize={56}
        pinScale={1.4}
        fitMaxZoom={17}
      />

      {/* "Van is N min / X mi from me" — always visible when both GPS sources
          are reporting. Useful when waiting for pickup or knowing how close
          the van is on a walk-back. */}
      {/* The "Van X min from you" chip used to live at top-center; it's
          now rendered as a bottom-strip card (see !live branch below) so
          the bottom of the screen is the single place that shows
          time-to-target — whether the target is the van (when waiting),
          the next destination (when picked up), or the final destination
          (always when onboard). */}

      {/* Turn-by-turn maneuver chip — only when onboard. Mirrors TV banner
          but in phone-friendly compact form. */}
      {live?.status === "onboard" && eta?.next_maneuver && (
        <div className="absolute left-1/2 top-3 z-30 -translate-x-1/2 flex items-center gap-2 rounded-2xl border border-emerald-700/50 bg-zinc-950 px-3 py-2 shadow-xl">
          <span className="text-2xl leading-none text-emerald-300">{markManeuverArrow(eta.next_maneuver.step.type, eta.next_maneuver.step.modifier)}</span>
          <div className="min-w-0">
            <div className="font-mono text-sm font-bold tabular-nums text-zinc-100">
              {eta.next_maneuver.meters_to < 300
                ? `${Math.max(50, Math.round(eta.next_maneuver.meters_to * 3.281 / 50) * 50)} ft`
                : `${(eta.next_maneuver.meters_to * 0.000621371).toFixed(1)} mi`}
            </div>
            <div className="truncate text-[11px] text-zinc-400 max-w-[260px]">{eta.next_maneuver.step.instruction}</div>
          </div>
        </div>
      )}

      {/* Top header — empty now. Both top buttons (Pickup, GPS share)
          live in the right-side column below to keep map controls on
          one rail. */}

      {/* Map focus controls — left edge. (Drop-pin via long-press; no rail button.) */}
      <div className="absolute left-3 top-[max(env(safe-area-inset-top),12px)] z-30 mt-14 flex flex-col gap-1.5">
        <FocusBtn label={<VanIcon size={26} />} onClick={() => focus("van")} title="Center on van" />
        {(mapTrip?.dropoff_lat != null || mapTrip?.pickup_lat != null) && (
          <FocusBtn label={<span className="text-2xl leading-none">🏁</span>} onClick={() => focus("dest")} title="Center on destination" />
        )}
        {myGps && pos && (
          <FocusBtn
            label={
              <span className="flex flex-col items-center leading-none">
                <VanIcon size={22} />
                <span className="mt-0.5 text-xs">↕</span>
              </span>
            }
            onClick={() => focus("van-me")}
            title="Fit van + me"
          />
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

      {/* Vitals strip — top-right column. Pickup button sits at the top
          of the column (above fuel%) so it's always reachable without
          competing with the map controls on the left. */}
      <div className="absolute right-3 top-3 z-30 flex w-fit flex-col items-stretch gap-1.5">
        <button
          onClick={() => setSheet("pickup")}
          className="rounded-2xl bg-gradient-to-br from-violet-600 to-fuchsia-700 px-3 py-2 text-xs font-semibold text-white shadow hover:from-violet-500 hover:to-fuchsia-600"
        >
          Pickup
        </button>
        <button
          onClick={() => setShareGps((v) => !v)}
          className={`rounded-2xl border border-zinc-800 px-2.5 py-2 text-[11px] backdrop-blur ${shareGps ? "bg-violet-900/50 text-violet-200" : "bg-zinc-950/85 text-zinc-400"}`}
          title="Share live GPS"
        >
          📍 {shareGps ? "on" : "off"}
        </button>
        {pos && (
          <>
            <VitalChip>
              <Fuel size={11} className="text-emerald-400" />
              <span>{pos.fuel_pct != null ? `${(pos.fuel_pct * 100).toFixed(0)}%` : "—"}</span>
            </VitalChip>
            <VitalChip>
              <span className="text-emerald-400">↗</span>
              <span>{rangeMiles(pos.fuel_pct ?? null) ?? "—"} mi</span>
            </VitalChip>
            <SpeedChip mph={pos.speed_mph ?? null} />
          </>
        )}
      </div>

      {/* Cabin climate quick-strip — bottom-center, only when a trip is active */}
      {live && (
        <div className="pointer-events-none absolute inset-x-0 bottom-24 z-30 flex justify-center">
          <div className="pointer-events-auto">
            <CabinQuickStrip token={token} tripId={live.id} />
          </div>
        </div>
      )}

      {/* TV-style bottom strip — mirrors the layout on the in-van TV.
          When there's a meaningful Next Stop in addition to Final
          Destination, both cards stack. Tap either to open the trip
          editor. Maps + Share buttons sit to the right. */}
      {live && eta && (() => {
        const sameTarget =
          !!eta.to_next &&
          !!eta.to_final &&
          (
            eta.to_next.label === eta.to_final.label ||
            /current\s+location|my\s+location/i.test(eta.to_next.label) ||
            eta.to_next.distance_miles < 0.3
          );
        const showNext = !sameTarget && !!eta.to_next;
        return (
          <div className="absolute inset-x-3 bottom-3 z-30 space-y-2">
            {showNext && eta.to_next && (
              <button onClick={() => setSheet("trip")} className="block w-full text-left">
                <EtaCard
                  compact
                  kind="stop"
                  label={eta.to_next.label}
                  minutes={eta.to_next.eta_minutes}
                  miles={eta.to_next.distance_miles}
                  primary
                  titleOverride="Next destination"
                />
              </button>
            )}
            {eta.to_final && (
              <div className="flex items-stretch gap-2">
                <button onClick={() => setSheet("trip")} className="flex-1 text-left">
                  <EtaCard
                    compact
                    kind="dropoff"
                    label={eta.to_final.label}
                    minutes={eta.to_final.eta_minutes}
                    miles={eta.to_final.distance_miles}
                    primary={!showNext}
                    titleOverride="Final destination"
                  />
                </button>
                <ShareTripButton token={token} tripId={live.id} label="Share" />
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
          </div>
        );
      })()}

      {/* No active trip — operational cards stacked with the "Van to you"
          tile pinned to the bottom (same visual slot the Final-destination
          card occupies when a trip is live). Mark always glances at the
          bottom of the screen for time-to-target: when waiting that's
          time-to-van; when picked up it becomes time-to-destination. The
          Van card is hidden when Mark is essentially in the van already
          (< 0.1 mi). */}
      {!live && (
        <div className="absolute inset-x-3 bottom-3 z-30 space-y-2">
          <TripRecapCard token={token} />
          <FuelAlertCard
            fuelPct={pos?.fuel_pct ?? null}
            vanLat={pos?.lat ?? null}
            vanLng={pos?.lng ?? null}
          />
          <LeaveByCard token={token} vanLat={pos?.lat ?? null} vanLng={pos?.lng ?? null} />
          {vanFromMe && vanFromMe.miles >= 0.1 && (
            <EtaCard
              compact
              kind="stop"
              label={meAddress ?? "Your location"}
              minutes={vanFromMe.minutes}
              miles={vanFromMe.miles}
              primary
              titleOverride="Van to you"
            />
          )}
        </div>
      )}

      {/* Floating voice cabin button — hold to speak. Live trip only. */}
      {live && (
        <div className="absolute right-3 bottom-24 z-30">
          <VoiceCabin token={token} tripId={live.id} />
        </div>
      )}
      {/* Maps fallback — only shows when there's a live trip without an
          ETA yet. When there's no live trip we don't need a standalone
          Maps button — the Van-to-you bottom card is the focus. */}
      {live && !eta && navUrl && (
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
      <InsightsCard token={token} />
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
