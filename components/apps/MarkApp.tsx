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
import BouncieConnectCard from "@/components/BouncieConnectCard";
import EtaBadge from "@/components/EtaBadge";
import AddressAutocomplete from "@/components/AddressAutocomplete";
import DestinationInput from "@/components/DestinationInput";
import { statusLabel, shortTime } from "@/lib/format";
import { postJson } from "@/lib/api-client";
import { encodePolyline } from "@/lib/routing";
import CabinChat from "@/components/CabinChat";
import CabinQuickStrip from "@/components/CabinQuickStrip";
import DriverChat, { useUnreadDriverChat } from "@/components/DriverChat";
import VanIcon from "@/components/VanIcon";
import { useRange } from "@/components/useRange";
import {
  Map as MapIcon,
  Settings,
  Navigation,
  X,
  Loader2,
  ArrowUp,
  MessageCircle,
  HelpCircle,
  Fuel,
  GripVertical,
  Flag,
  Trash2,
  UserPlus,
  Share2,
} from "lucide-react";

type Tab = "map" | "trip" | "chat" | "help" | "settings";

// Same app shell serves Mark and passengers. Role-aware bits:
//   - Settings tab on Mark = full controls (link minting, Bouncie status,
//     driver management). On passenger = just the push-notifications
//     toggle (everything else is owner-only).
//   - Trip-write actions (pickup edit, stop add/remove, invite-guest) are
//     gated server-side via requireTripActor — both roles can edit the
//     single in-flight trip, neither can affect anything else.
// Single-trip-mode means there is no other-trip / your-trip distinction:
// at any moment there is one trip and both Mark + that trip's passenger
// are co-controllers of it.
export default function MarkApp({
  token,
  name,
  role = "mark",
}: {
  token: string;
  name: string;
  role?: "mark" | "passenger";
}) {
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
  const unreadDriver = useUnreadDriverChat(token, role);

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
      <div className={tab === "chat" ? "flex flex-1 flex-col overflow-hidden" : "hidden"}>
        <header className="border-b border-zinc-900 bg-zinc-950/95 px-4 py-3">
          <div className="mx-auto flex max-w-3xl items-center gap-2">
            <span className="text-sm font-medium text-zinc-100">
              {role === "passenger" ? "Chat with driver" : "Driver chat"}
            </span>
          </div>
        </header>
        <DriverChat token={token} viewerRole={role} />
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
          <SettingsTab token={token} origin={origin} role={role} />
        </ScrollableTab>
      </div>

      <nav className="z-40 border-t border-zinc-900 bg-zinc-950/95 backdrop-blur pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto flex max-w-3xl">
          <TabButton active={tab === "map"} onClick={() => setTab("map")} icon={<MapIcon size={20} />} label="Map" />
          {/* Chat thread is shared by Mark + Dio + the active trip's
              passenger. Each role's messages render as "mine" on their
              own side and "theirs" to the other two. */}
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
  // Fire ETA for the focused trip — `live` while in motion, else the next
  // scheduled trip. Scheduled trips still need a route polyline + upcoming
  // waypoints so the pending pickup pin can render with the van's route to
  // reach it, not just float on the map alone.
  const { eta } = useEta(token, mapTrip?.id ?? null, 25_000);
  // Rolling-actual-MPG range — pulled from /api/range which multiplies
  // tank-gallons × fuel_pct × rolling_mpg (Bouncie trip data, last 7
  // days). Replaces the old static 18-mpg constant. Updates once a min.
  const range = useRange(token);
  const [sheet, setSheet] = useState<"none" | "dispatch" | "pickup" | "trip">("none");

  // Edit mode — Mark is currently editing one of pickup / dropoff / stop.
  // All three flows share the in-place map transform (violet draggable pin
  // + zoom-in + bottom card). Only one target is active at a time. Null =
  // normal map view.
  // Edit-mode is now PICKUP-ONLY. Dropoff/stop entry moved to the
  // always-on DestinationInput at the bottom of the screen (when Mark is
  // in the van) — single input, server figures out bootstrap vs append,
  // user genuinely cannot mess it up. See /api/destinations + the
  // 2026-05-20 simplification commit for the why.
  type EditTarget = "pickup";
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [editPin, setEditPin] = useState<{ lat: number; lng: number } | null>(null);
  const [editAddress, setEditAddress] = useState<string | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  // Van → pin route preview (replaces ambient van→me when in pickup edit mode).
  const [editRoute, setEditRoute] = useState<{ polyline: string | null; congestion: ("low"|"moderate"|"heavy"|"severe"|"unknown")[] | null; eta_minutes: number | null; distance_miles: number | null }>(
    { polyline: null, congestion: null, eta_minutes: null, distance_miles: null },
  );
  // Convenience aliases for clarity throughout the file.
  const pickupMode = editTarget === "pickup";
  const inEditMode = editTarget !== null;
  // Drop-pin retired — was redundant with Pickup / Dropoff / Stop, each of
  // which already opens a draggable pin with live ETA + address. Drop-pin
  // fired easily by accident (any errant map tap opened the action sheet).
  // Removing it is pure subtraction: tap on map = pan/zoom only.
  const [focusMode, setFocusMode] = useState<"auto" | "van" | "me" | "dest" | "van-me" | "me-dest">("auto");
  const [focusKey, setFocusKey] = useState(0);
  const focus = (mode: typeof focusMode) => {
    setFocusMode(mode);
    setFocusKey((k) => k + 1);
  };
  const [myGps, setMyGps] = useState<{ lat: number; lng: number } | null>(null);
  // Track the wall-clock time of the most recent myGps update so we can
  // pass an accurate age to DestinationInput → X-Phone-GPS header. Stale
  // GPS would lie to the server's bootstrap proximity check.
  const [myGpsTs, setMyGpsTs] = useState<number | null>(null);
  const localGeoOk = useRef<boolean>(false);
  useEffect(() => {
    if (!shareGps || typeof navigator === "undefined" || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (p) => {
        localGeoOk.current = true;
        setMyGps({ lat: p.coords.latitude, lng: p.coords.longitude });
        setMyGpsTs(Date.now());
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
          // 30-minute staleness threshold — iOS PWA gets backgrounded
          // and stops reporting; the last known position is still useful
          // as long as Mark hasn't been on the move recently. The live
          // ETA hook handles "driver picking him up" scenarios where
          // stale-by-minutes would matter; the no-trip view just wants
          // a recent-ish dot to anchor the "Van to you" card on.
          const ageS = (Date.now() - new Date(j.location.reported_at).getTime()) / 1000;
          if (ageS < 1800) {
            setMyGps({ lat: j.location.lat, lng: j.location.lng });
            // Stamp with the reported_at, NOT Date.now(), so DestinationInput
            // sees the true age of this position when it builds the header.
            setMyGpsTs(new Date(j.location.reported_at).getTime());
          }
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

  // Stops array on the trip. Each stop may carry `created_by_token` —
  // the link-token of whoever's Pickup button created it. We use that
  // to find "MY stop" (vs other people's stops) and turn the Pickup
  // button into an in-place modifier instead of an append.
  type TripStop = {
    id: string;
    lat: number | null;
    lng: number | null;
    address: string;
    passenger?: string | null;
    passenger_link_token?: string | null;
    created_by_token?: string | null;
    arrived_at?: string | null;
  };
  const stopsArr =
    ((mapTrip as unknown as { stops?: TripStop[] })?.stops ?? []) as TripStop[];

  // The stop *I* own — created by my Pickup button. Lets the button
  // flip between add ("Pickup") and modify ("Modify pickup") modes.
  const myStop = useMemo<TripStop | null>(() => {
    return stopsArr.find((s) => s.created_by_token === token) ?? null;
  }, [stopsArr, token]);

  // Mirror TV behavior: pin set comes from the live ETA's `upcoming` array
  // (which knows to drop pickup once onboard, etc.) so Mark's home map
  // shows only what's left of the trip.
  const upcoming = (eta as unknown as { upcoming?: Array<{ kind: "pickup" | "stop" | "dropoff"; lat: number; lng: number; label: string }> })?.upcoming;

  const pins = useMemo<MapPin[]>(() => {
    const out: MapPin[] = [];
    // Any edit mode (pickup / dropoff / stop) → just the violet draggable
    // target. The "You" mark pin would compete visually with the pin Mark
    // is actually trying to drag.
    if (inEditMode && editPin) {
      out.push({ kind: "pickup-target", id: "pickup-target", lat: editPin.lat, lng: editPin.lng, label: editAddress ?? undefined });
      return out;
    }
    // No active trip → show ONLY the "you" pin so the map fits to van + me
    // and renders the van→me route polyline. Don't surface a scheduled
    // trip's pickup/dropoff here — that pulls the camera way out and is
    // not what Mark wants to look at while idle.
    if (!live) {
      // Scheduled trip waiting for dispatch. Render the chain:
      //   - First stop  → kind="pickup" (violet pending teardrop)
      //   - Last stop   → kind="dropoff" (flag pin)
      //   - Middle      → numbered stop pins
      // Same rule everywhere now that pickup_*/dropoff_* are gone.
      const lastIdx = stopsArr.length - 1;
      stopsArr.forEach((s, i) => {
        if (s.lat == null || s.lng == null) return;
        const sx = s as unknown as { passenger?: string | null; passenger_link_token?: string | null };
        const kind: "pickup" | "stop" | "dropoff" =
          i === 0 ? "pickup" : i === lastIdx ? "dropoff" : "stop";
        out.push({
          kind,
          id: kind === "pickup" ? "pickup" : kind === "dropoff" ? "dropoff" : s.id,
          lat: s.lat,
          lng: s.lng,
          label: s.address,
          ...(kind === "stop" ? { index: i + 1 } : {}),
          ...(kind === "pickup" ? { pending: true } : {}),
          ...(sx.passenger ? { passenger: sx.passenger } : {}),
          ...(sx.passenger_link_token ? { passenger_link_token: sx.passenger_link_token } : {}),
        });
      });
      if (myGps) out.push({ kind: "mark", lat: myGps.lat, lng: myGps.lng, label: "You" });
      return out;
    }
    // Resolve stop UUIDs + passenger info by matching label against the
    // server-side stops array — `upcoming` (from eta) doesn't include the
    // id or passenger fields directly.
    const stopMetaByLabel = new Map<string, { id: string; passenger: string | null; passenger_link_token: string | null }>();
    stopsArr.forEach((s) => {
      if (s.id) {
        const sx = s as unknown as { passenger?: string | null; passenger_link_token?: string | null };
        stopMetaByLabel.set(s.address, {
          id: s.id,
          passenger: sx.passenger ?? null,
          passenger_link_token: sx.passenger_link_token ?? null,
        });
      }
    });
    if (upcoming && upcoming.length > 0) {
      let stopIdx = 0;
      upcoming.forEach((w) => {
        const idx = w.kind === "stop" ? ++stopIdx : undefined;
        const meta = w.kind === "stop" ? stopMetaByLabel.get(w.label) : undefined;
        const id =
          w.kind === "pickup"
            ? "pickup"
            : w.kind === "dropoff"
              ? "dropoff"
              : meta?.id;
        out.push({
          kind: w.kind,
          lat: w.lat,
          lng: w.lng,
          label: w.label,
          ...(idx != null ? { index: idx } : {}),
          ...(id ? { id } : {}),
          ...(meta?.passenger ? { passenger: meta.passenger } : {}),
          ...(meta?.passenger_link_token ? { passenger_link_token: meta.passenger_link_token } : {}),
        });
      });
    } else {
      // Fallback while ETA hasn't loaded yet. Render the chain directly:
      //   - First un-arrived stop → kind="pickup" (until visited)
      //   - Last stop             → kind="dropoff" (regardless of arrived)
      //   - Middle un-arrived     → numbered stop pins
      // Arrived intermediates are filtered out; the dropoff stays until
      // the trip auto-completes (state machine handles that).
      const lastIdx = stopsArr.length - 1;
      stopsArr.forEach((s, i) => {
        if (s.lat == null || s.lng == null) return;
        const sx = s as unknown as { passenger?: string | null; passenger_link_token?: string | null; arrived_at?: string | null };
        if (sx.arrived_at && i !== lastIdx) return; // arrived intermediate
        if (i === lastIdx) {
          out.push({ kind: "dropoff", id: "dropoff", lat: s.lat, lng: s.lng, label: s.address });
          return;
        }
        out.push({
          kind: "stop",
          id: s.id,
          lat: s.lat,
          lng: s.lng,
          label: s.address,
          index: i + 1,
          ...(sx.passenger ? { passenger: sx.passenger } : {}),
          ...(sx.passenger_link_token ? { passenger_link_token: sx.passenger_link_token } : {}),
        });
      });
    }
    if (myGps) out.push({ kind: "mark", lat: myGps.lat, lng: myGps.lng, label: "You" });
    return out;
    // editPin / editAddress / inEditMode included so the violet
    // pickup-target pin reflects the latest dragged position after the
    // user lifts their finger. Without them the memoized array was
    // stuck on the OLD editPin closure value until an unrelated dep
    // (myGps, upcoming, …) happened to tick, which was visible as the
    // marker drifting back to where it started during the next rebuild.
  }, [live, upcoming, mapTrip, stopsArr, myGps, editPin, editAddress, inEditMode]);

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
    // Skip van→me when ANY trip is in play (active or scheduled). The eta
    // hook will return van→pickup (scheduled) or van→next-waypoint (live);
    // both override the idle-state van→me line.
    if (mapTrip) {
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
  }, [mapTrip, token, pos?.lat?.toFixed(3), pos?.lng?.toFixed(3), myGps?.lat?.toFixed(3), myGps?.lng?.toFixed(3)]);

  // Any edit mode → preview the van→pin route. Otherwise: live ETA
  // polyline first, then van→me route, then saved trip route_polyline.
  const polyline = inEditMode
    ? editRoute.polyline
    : eta?.polyline ?? vanToMe.polyline ?? (mapTrip as unknown as { route_polyline?: string })?.route_polyline ?? null;
  const congestion = inEditMode
    ? editRoute.congestion
    : eta?.congestion ?? vanToMe.congestion ?? null;

  // Dashed walk line: Mark → pending pickup. Renders only when there's a
  // scheduled trip with a pickup distinct from where Mark is standing —
  // i.e. Mark dropped a pickup pin some distance away from himself and
  // intends to walk to that meeting spot. Once the trip is dispatched
  // (driver actively coming), the van comes to Mark and the walk line is
  // no longer useful, so suppress it. Drawn as a 2-point great-circle
  // line; not snapped to streets because OSRM's walking profile isn't
  // wired and a straight guide is honest about "this is approximate."
  const walkPolyline = useMemo<string | null>(() => {
    if (inEditMode) return null;
    if (!myGps || !mapTrip) return null;
    if (mapTrip.status !== "scheduled") return null;
    // Pickup = first stop in the chain.
    const pickup = stopsArr[0];
    if (!pickup || pickup.lat == null || pickup.lng == null) return null;
    // Skip if Mark is essentially at the pickup (< ~30m) — no walk line needed.
    const dLat = (pickup.lat - myGps.lat) * Math.PI / 180;
    const dLng = (pickup.lng - myGps.lng) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(myGps.lat * Math.PI / 180) *
        Math.cos(pickup.lat * Math.PI / 180) *
        Math.sin(dLng / 2) ** 2;
    const distM = 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    if (distM < 30) return null;
    return encodePolyline([
      [myGps.lng, myGps.lat],
      [pickup.lng, pickup.lat],
    ]);
  }, [inEditMode, myGps, mapTrip, stopsArr]);

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
    // Pickup-mode pin: update local state, refresh address + route preview.
    // Doesn't PATCH anything until Mark taps a time chip to commit.
    if (pin.kind === "pickup-target") {
      setEditPin({ lat: newLat, lng: newLng });
      return;
    }
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
      // Destinations-as-chain: pickup = stops[0], dropoff = stops[last],
      // intermediate = match-by-id. Every pin drag becomes a single PUT
      // /stops mutation — no more pickup_*/dropoff_* PATCH path. Send
      // optimize=false so a drag doesn't get reordered out from under
      // the user.
      const targetIdx =
        pin.kind === "pickup"
          ? 0
          : pin.kind === "dropoff"
            ? stopsArr.length - 1
            : stopsArr.findIndex(
                (s) =>
                  (pin.id && s.id === pin.id) ||
                  (!pin.id &&
                    Math.abs((s.lat ?? 0) - pin.lat) < 1e-6 &&
                    Math.abs((s.lng ?? 0) - pin.lng) < 1e-6),
              );
      if (targetIdx >= 0 && targetIdx < stopsArr.length) {
        const next = stopsArr.map((s, i) =>
          i === targetIdx ? { ...s, lat: newLat, lng: newLng, address: address ?? s.address } : s,
        );
        await fetch(`/api/trips/${mapTrip.id}/stops`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ stops: next, optimize: false }),
        });
      }
      refresh();
    } catch (err) {
      console.warn("[MarkApp] pin drag PATCH failed", err);
    }
  };

  // Universal Pickup-button model: every pickup is a stop. The user's
  // own pickup is the stop with created_by_token === their token.
  //   - First tap → ADD that stop ("Pickup").
  //   - Subsequent taps → MODIFY that stop ("Modify pickup").
  // editTrip is the trip the action will apply to (live, else next
  // scheduled). When no trip exists, the action creates one via
  // /api/quick-pickup (which now also writes the stop).
  const editTrip = useMemo<Trip | null>(() => {
    if (live && (live.status === "dispatched" || live.status === "at_pickup")) return live;
    if (!live && mapTrip && mapTrip.status === "scheduled") return mapTrip;
    return live ?? mapTrip ?? null;
  }, [live, mapTrip]);
  const pickupModeKind: "edit" | "new" = myStop ? "edit" : "new";

  // Sticky in-van detection: once Mark's GPS comes within 10m of the
  // van for a given trip, lock him in until the trip ends. Without
  // the latch, GPS jitter (he goes through a tunnel, sits in a metal
  // parking garage, etc.) could briefly read >10m apart and flip the
  // UI back to "Pickup" mid-ride. The latch resets when the trip ID
  // changes.
  const [stickyTripId, setStickyTripId] = useState<string | null>(null);
  useEffect(() => {
    if (!myGps || !pos || !mapTrip) return;
    if (stickyTripId === mapTrip.id) return; // already latched for this trip
    const R = 6_371_000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(pos.lat - myGps.lat);
    const dLng = toRad(pos.lng - myGps.lng);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(myGps.lat)) * Math.cos(toRad(pos.lat)) * Math.sin(dLng / 2) ** 2;
    const m = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    if (m < 10) setStickyTripId(mapTrip.id);
  }, [mapTrip, myGps, pos, stickyTripId]);
  // Reset the latch when the focal trip changes (or disappears).
  useEffect(() => {
    if (mapTrip?.id !== stickyTripId && stickyTripId != null && mapTrip?.id == null) {
      setStickyTripId(null);
    }
  }, [mapTrip, stickyTripId]);

  // Is Mark physically in the van?
  //   1. Trip status says onboard / at_dropoff       → yes (legacy single-pickup trips)
  //   2. My stop has arrived_at set (server-derived) → yes — survives reload
  //   3. Sticky latch tripped during this trip       → yes — covers the few seconds
  //                                                    between getting within 10m
  //                                                    and the server stamping
  //                                                    arrived_at
  //   4. Current GPS within 10m of van               → yes — transient signal
  // Pickup is a ONE-WAY event: once Mark has been within 10m of the van during
  // this trip, every reload should still show Dropoff (server-persisted via
  // arrived_at). Otherwise GPS jitter / a page reload would briefly flip the UI
  // back to "Pickup" mid-ride. Joining passengers far from the van fail all
  // four checks.
  const inVan = useMemo(() => {
    if (live?.status === "onboard" || live?.status === "at_dropoff") return true;
    if (myStop?.arrived_at != null) return true;
    if (mapTrip && stickyTripId === mapTrip.id) return true;
    if (!myGps || !pos) return false;
    const R = 6_371_000;
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(pos.lat - myGps.lat);
    const dLng = toRad(pos.lng - myGps.lng);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(myGps.lat)) * Math.cos(toRad(pos.lat)) * Math.sin(dLng / 2) ** 2;
    const m = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return m < 10;
  }, [live, mapTrip, stickyTripId, myGps, pos, myStop]);

  // Enter pickup mode. If I already have a stop on this trip
  // (created_by_token match), start the pin at THAT stop so I can
  // drag it. Otherwise start at my GPS so the snap-to-me path
  // creates a fresh pickup at where I am.
  const enterPickup = () => {
    let start: { lat: number; lng: number } | null = null;
    if (myStop && myStop.lat != null && myStop.lng != null) {
      start = { lat: myStop.lat, lng: myStop.lng };
      setEditAddress(myStop.address ?? null);
    } else if (myGps) {
      start = { lat: myGps.lat, lng: myGps.lng };
      setEditAddress(meAddress ?? null);
    }
    if (!start) return;
    setEditPin(start);
    setEditTarget("pickup");
    setFocusMode("me");
    setFocusKey((k) => k + 1);
  };

  // enterDropoff + enterStop deleted 2026-05-20 — replaced by the always-
  // on DestinationInput at the bottom of the screen. Single input, single
  // endpoint, server decides bootstrap-vs-append. The drag-pin UX they
  // used is retained for pickup mode only (where the spatial gesture
  // genuinely helps — "I'm standing here, come get me"); dropoff and
  // stops are address-or-typed entries where text + auto-optimize works
  // better than pin dragging in a moving van.

  const exitEdit = () => {
    setEditTarget(null);
    setEditPin(null);
    setEditAddress(null);
    setEditRoute({ polyline: null, congestion: null, eta_minutes: null, distance_miles: null });
  };
  // Legacy alias name kept for the existing X-Cancel button. The button
  // bound to exitPickup historically; it now generically exits whichever
  // edit-target was active.
  const exitPickup = exitEdit;

  // Reverse-geocode the pickup pin whenever it moves so the bottom card
  // shows a real address (e.g., "230 Newport Boulevard") instead of raw
  // coordinates.
  useEffect(() => {
    if (!inEditMode || !editPin) return;
    let cancel = false;
    (async () => {
      try {
        const r = await fetch(`/api/places/reverse-geocode?lat=${editPin.lat}&lng=${editPin.lng}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return;
        const j = (await r.json()) as { display?: string };
        if (!cancel && j.display) setEditAddress(j.display);
      } catch {}
    })();
    return () => {
      cancel = true;
    };
  }, [inEditMode, editPin?.lat?.toFixed(5), editPin?.lng?.toFixed(5), token]);

  // Refresh the van→pin route preview as the pin moves. Uses the same
  // /api/eta POST endpoint as the trip detail editor.
  useEffect(() => {
    if (!inEditMode || !editPin) return;
    let cancel = false;
    (async () => {
      try {
        const r = await fetch("/api/eta", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ waypoints: [{ lat: editPin.lat, lng: editPin.lng, kind: "stop", label: "Pickup" }] }),
        });
        if (!r.ok) return;
        const j = (await r.json()) as { polyline?: string | null; congestion?: ("low"|"moderate"|"heavy"|"severe"|"unknown")[] | null; eta_minutes?: number | null; distance_miles?: number | null };
        if (cancel) return;
        setEditRoute({
          polyline: j.polyline ?? null,
          congestion: j.congestion ?? null,
          eta_minutes: j.eta_minutes ?? null,
          distance_miles: j.distance_miles ?? null,
        });
      } catch {}
    })();
    return () => {
      cancel = true;
    };
  }, [inEditMode, editPin?.lat?.toFixed(4), editPin?.lng?.toFixed(4), token]);

  // Commit a pickup change. Three paths:
  //   1. MY-STOP MODIFY — I already have a stop on this trip → PATCH
  //      the stops array (drag/snap moved my pin to a new location).
  //   2. ADD-MY-STOP — Trip exists but I don't have a stop yet → POST
  //      a new stop with my token + name; server reruns the optimizer.
  //   3. CREATE-TRIP — No trip exists yet → /api/quick-pickup creates
  //      one and adds my pickup as stops[0] in the same call.
  // Dio's app + Mark's app see the change via realtime CDC and re-route.
  const dispatchPickup = async (offsetMin: number) => {
    if (!editPin || editBusy) return;
    setEditBusy(true);
    try {
      const when = offsetMin > 0
        ? new Date(Date.now() + offsetMin * 60_000).toISOString()
        : new Date().toISOString();
      const finalAddress = editAddress ?? `${editPin.lat.toFixed(5)}, ${editPin.lng.toFixed(5)}`;
      if (myStop && editTrip) {
        // (1) Modify my stop in place. PUT-replace the whole stops
        // array so the server can rerun the Mapbox optimizer.
        const next = stopsArr.map((s) =>
          s.created_by_token === token
            ? { ...s, lat: editPin.lat, lng: editPin.lng, address: finalAddress }
            : s,
        );
        await fetch(`/api/trips/${editTrip.id}/stops`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ stops: next }),
        });
        // Only sync scheduled_at when the user explicitly chose a time
        // chip > 0 — modifying location alone shouldn't slide the time.
        if (offsetMin !== 0 || pickupModeKind === "new") {
          await fetch(`/api/trips/${editTrip.id}`, {
            method: "PATCH",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ scheduled_at: when }),
          });
        }
      } else if (editTrip) {
        // (2) Add my stop to an existing trip.
        await fetch(`/api/trips/${editTrip.id}/stops`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: "stop",
            lat: editPin.lat,
            lng: editPin.lng,
            address: finalAddress,
            passenger: name,
            created_by_token: token,
          }),
        });
      } else {
        // (3) No trip yet — bootstrap one via quick-pickup. That
        // endpoint now creates the trip AND seeds stops[0] with my
        // pickup carrying my token + name.
        await postJson(token, "/api/quick-pickup", {
          lat: editPin.lat,
          lng: editPin.lng,
          address: finalAddress,
          scheduled_at: when,
          passenger: name,
          created_by_token: token,
          notes: offsetMin === 0 ? "Pick me up now" : `Pick me up in ${offsetMin} min`,
        });
      }
      exitEdit();
      refresh();
    } catch (err) {
      console.warn("[MarkApp] pickup dispatch failed", err);
    } finally {
      setEditBusy(false);
    }
  };

  // commitDropoff + commitStop deleted 2026-05-20. Both flows now go
  // through DestinationInput → POST /api/destinations, which has
  // idempotency, optimistic UI, offline queue, geo-bounds check, and
  // bootstrap-or-append decided server-side. The morning incident that
  // motivated this rewrite (passenger tapped "Set dropoff", nothing
  // happened, because her link had trip_id=null) is now structurally
  // impossible — the new endpoint bootstraps a trip from her first
  // entry. See app/api/destinations/route.ts.

  // Remove a single intermediate stop. Used when Mark taps a stop pin on
  // the map and chooses "Remove this stop". Matches by id when possible
  // (preferred), falls back to lat/lng proximity if no id was wired on
  // the upstream pin.
  const removeStopPin = async (pin: MapPin) => {
    if (pin.kind !== "stop" || editBusy) return;
    setEditBusy(true);
    try {
      const trip = live ?? mapTrip;
      if (!trip) return;
      const next = stopsArr.filter((s) => {
        if (pin.id && s.id === pin.id) return false;
        if (!pin.id && Math.abs((s.lat ?? 0) - pin.lat) < 1e-6 && Math.abs((s.lng ?? 0) - pin.lng) < 1e-6) return false;
        return true;
      });
      await fetch(`/api/trips/${trip.id}/stops`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ stops: next }),
      });
      refresh();
    } catch (err) {
      console.warn("[MarkApp] removeStopPin failed", err);
    } finally {
      setEditBusy(false);
    }
  };

  // Tag a stop with a passenger name and auto-mint a passenger-link token.
  // Returns the share URL (passenger tracker page) so the popup can switch
  // straight into share-sheet mode without waiting for the next refresh
  // cycle. Passing null clears the name + revokes the token.
  const savePinPassenger = async (pin: MapPin, name: string | null): Promise<string | null> => {
    if (pin.kind !== "stop" || !pin.id) return null;
    const trip = live ?? mapTrip;
    if (!trip) return null;
    try {
      const res = await fetch(`/api/trips/${trip.id}/stops/${pin.id}/passenger`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const j = (await res.json().catch(() => null)) as { token?: string | null } | null;
      refresh();
      if (j?.token) {
        const base = typeof window !== "undefined" ? window.location.origin : "";
        return `${base}/p/${j.token}`;
      }
      return null;
    } catch (err) {
      console.warn("[MarkApp] savePinPassenger failed", err);
      throw err;
    }
  };

  // Clear ALL pending stops at once. Used when Mark long-presses the Stop
  // button (or as a fallback when the list grows unwieldy). Arrived stops
  // stay in place because their history matters.
  // clearStops deleted 2026-05-20 — only ever rendered as a button
  // inside the now-deleted stopMode branch of the edit panel. Removing
  // a stop is still possible via the TripSheet drag-reorder list (per-row
  // X button) or by tapping the pin on the map (removeStopPin). The
  // "nuke everything pending" gesture lacked a safe path anyway — Mark
  // can hold-to-confirm or use TripSheet's bulk-clear if he wants it
  // back later.

  return (
    <div className="relative h-full w-full overflow-hidden">
      <ClientMap
        position={pos}
        pins={pins}
        polyline={polyline}
        walkPolyline={walkPolyline}
        congestion={congestion}
        className="h-full w-full"
        focusMode={focusMode}
        focusKey={focusKey}
        // Pin-tap popups are intentionally NOT wired here. The trip
        // card is the one place to remove / invite a passenger /
        // reorder stops — the map is for viewing only. The single
        // exception is `onPinDragEnd`, which lets Mark drag a pin
        // geographically to nudge its location; that's an interaction
        // the list can't replicate.
        onPinDragEnd={mapTrip || inEditMode ? handlePinDrag : undefined}
        routeLineWidth={6}
        routeGlowWidth={14}
        vanIconSize={45}
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

      {/* Map focus controls — left edge, aligned with the right-side
          rail (Pickup / GPS / vitals) at the top of the screen. */}
      <div className="absolute left-3 top-3 z-30 flex flex-col gap-1.5">
        <FocusBtn label={<VanIcon size={26} />} onClick={() => focus("van")} title="Center on van" />
        {stopsArr.some((s) => s.lat != null && s.lng != null) && (
          <FocusBtn label={<span className="text-2xl leading-none">🏁</span>} onClick={() => focus("dest")} title="Center on destination" />
        )}
        {myGps && pos && (
          <FocusBtn
            label={
              <span className="flex flex-col items-center leading-none">
                <VanIcon size={22} />
                {/* Full-width double-headed arrow spans the van glyph so
                    the "fit both" intent reads at a glance. */}
                <svg
                  width="22"
                  height="6"
                  viewBox="0 0 22 6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="mt-0.5"
                  aria-hidden
                >
                  <line x1="1.5" y1="3" x2="20.5" y2="3" />
                  <polyline points="4.5,1 1.5,3 4.5,5" />
                  <polyline points="17.5,1 20.5,3 17.5,5" />
                </svg>
              </span>
            }
            onClick={() => focus("van-me")}
            title="Fit van + me"
          />
        )}
        <FocusBtn
          label={
            // Full-size SVG version of the ⤢ "fit-to-window" glyph —
            // arrows reach into opposite corners so the icon visually
            // fills the button at the same scale as icons 1-3.
            <svg
              width="22"
              height="22"
              viewBox="0 0 22 22"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <polyline points="8,2 2,2 2,8" />
              <line x1="2" y1="2" x2="9" y2="9" />
              <polyline points="14,20 20,20 20,14" />
              <line x1="20" y1="20" x2="13" y2="13" />
            </svg>
          }
          onClick={() => focus("auto")}
          title="Auto-fit"
        />
        {/* "Snap to me" — replaces the old external-Google-Maps link,
            which was misleading (the Navigation icon reads as 'locate
            me' everywhere else in iOS) and not actually useful since
            Mark drives with built-in nav. Two behaviors:
              • In edit mode (pickup / dropoff / stop): SNAP the
                violet pin to Mark's current GPS. "Pick me up here" =
                one tap.
              • Otherwise: recenter the camera on Mark.
            Hidden when myGps is unknown — no point offering "snap to
            me" before the browser geolocation watcher has reported. */}
        {myGps && (
          <FocusBtn
            label={<Navigation size={16} />}
            onClick={() => {
              if (inEditMode) {
                setEditPin({ lat: myGps.lat, lng: myGps.lng });
                setEditAddress(meAddress ?? null);
              }
              setFocusMode("me");
              setFocusKey((k) => k + 1);
            }}
            title={inEditMode ? "Snap pickup to my location" : "Center on me"}
          />
        )}
        {/* Share — sits below the snap-to-me icon. Always visible: with
            a live trip it mints the trip's passenger link; without one
            it mints a generic "track my van" link (passenger role,
            null trip_id, 24h expiry). Recipient lands on /p/<token>
            either way; the only thing that changes is whether they
            see trip details too. */}
        <ShareTripButton token={token} tripId={live?.id ?? null} compact />
      </div>

      {/* Vitals strip — top-right column. Pickup button sits at the top
          of the column (above fuel%) so it's always reachable without
          competing with the map controls on the left. */}
      <div className="absolute right-3 top-3 z-30 flex w-fit flex-col items-stretch gap-1.5">
        {/* Top-right button column — Pickup ONLY (out-of-van case).
            Dropoff and Add Stop buttons removed 2026-05-20: when
            Mark is in the van, the always-on DestinationInput at the
            bottom of the screen is the single entry point for any new
            destination. The server figures out bootstrap-vs-append; he
            doesn't have to pre-classify. In edit mode (pickup pin
            drag), this morphs to "✕ Cancel". */}
        {inEditMode ? (
          <button
            onClick={exitEdit}
            className="rounded-2xl px-3 py-2 text-xs font-semibold text-white shadow bg-zinc-800 hover:bg-zinc-700"
          >
            ✕ Cancel
          </button>
        ) : (
          !inVan && (
            <button
              onClick={enterPickup}
              disabled={!myGps && !myStop}
              className="rounded-2xl px-3 py-2 text-xs font-semibold text-white shadow bg-gradient-to-br from-violet-600 to-fuchsia-700 hover:from-violet-500 hover:to-fuchsia-600 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {pickupModeKind === "edit" ? "Modify" : "Pickup"}
            </button>
          )
        )}
        <button
          onClick={() => setShareGps((v) => !v)}
          className={`rounded-2xl border border-zinc-800 px-2.5 py-2 text-[11px] backdrop-blur ${shareGps ? "bg-violet-900/50 text-violet-200" : "bg-zinc-950/85 text-zinc-400"}`}
          title="Share live GPS"
        >
          📍 {shareGps ? "on" : "off"}
        </button>
        {pos && (
          <>
            {/* Combined fuel/range chip. Range is the actionable
                number (how far can we go), fuel % is the secondary
                context (how full is the tank). Fuel icon implies
                the topic so we don't need both labels. */}
            <VitalChip>
              <Fuel size={11} className="text-emerald-400" />
              <span
                title={
                  range?.mpg_source === "bouncie_trips" && range.mpg
                    ? `${range.mpg.toFixed(1)} mpg · ${range.window_miles?.toFixed(0)} mi over ${range.window_days}d`
                    : undefined
                }
              >
                {range?.range_miles ?? "—"} mi
                {pos.fuel_pct != null && (
                  <span className="text-zinc-500">
                    {" · "}
                    {(pos.fuel_pct * 100).toFixed(0)}%
                  </span>
                )}
              </span>
            </VitalChip>
            <SpeedChip mph={pos.speed_mph ?? null} />
          </>
        )}
        {/* Cabin climate buttons — vertical stack under the vital chips
            (warmer / cooler / fan up / fan down). Moved here from the
            bottom-center horizontal strip so the climate controls live
            with the rest of the trip-context column. Only when a trip
            is active and Dio is the one driving (Mark wouldn't ping
            himself for cabin changes). */}
        {live && (
          <CabinQuickStrip token={token} tripId={live.id} vertical />
        )}
      </div>

      {/* Cabin climate strip moved into the top-right vital column above
          (see CabinQuickStrip vertical=true). Bottom-center placement
          retired so the destination card has the full bottom strip. */}

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
              <button onClick={() => setSheet("trip")} className="block w-full text-left">
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
            )}
          </div>
        );
      })()}

      {/* Pickup-mode bottom strip — pin drag + address autocomplete +
          4 time chips. Tapping a chip dispatches the pickup trip.
          Dropoff and stop entry no longer live here; they use the
          always-on DestinationInput rendered below when inVan. */}
      {inEditMode && pickupMode && (
        <div className="absolute inset-x-3 bottom-3 z-30">
          <div className="rounded-2xl border border-violet-700/60 bg-zinc-950 px-4 py-2 shadow-2xl">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-violet-300">
              <span aria-hidden>📍</span>
              <span>{pickupModeKind === "edit" ? "Modify pickup" : "Pick me up"}</span>
              <span className="text-zinc-500">·</span>
              <span className="text-zinc-400">Drag purple icon</span>
            </div>
            <div className="mt-0.5 truncate text-base font-semibold text-zinc-100 leading-tight">
              {editAddress ?? (editPin ? `${editPin.lat.toFixed(5)}, ${editPin.lng.toFixed(5)}` : "Locating…")}
            </div>
            <div className="mt-2">
              <AddressAutocomplete
                token={token}
                placeholder="Or type an address"
                onSelect={(r) => {
                  setEditPin({ lat: r.lat, lng: r.lng });
                  setEditAddress(r.display);
                  setFocusMode("me");
                  setFocusKey((k) => k + 1);
                }}
              />
            </div>
            {(editRoute.eta_minutes != null || (pickupModeKind === "edit" && editTrip?.scheduled_at)) && (
              <div className="mt-1 flex items-baseline justify-between gap-3 text-sm text-zinc-300">
                <div>
                  {editRoute.eta_minutes != null && editRoute.distance_miles != null && (
                    <>
                      Van: <span className="font-mono font-semibold tabular-nums text-emerald-300">{editRoute.eta_minutes}</span> min · <span className="font-mono font-semibold tabular-nums text-zinc-100">{editRoute.distance_miles}</span> mi away
                    </>
                  )}
                </div>
                {pickupModeKind === "edit" && editTrip?.scheduled_at && (
                  <div className="flex items-baseline gap-1.5 text-[10px] uppercase tracking-widest text-zinc-500">
                    <span>Currently</span>
                    <span className="font-mono text-sm font-bold tabular-nums text-emerald-300 normal-case tracking-normal">
                      {shortTime(editTrip.scheduled_at)}
                    </span>
                  </div>
                )}
              </div>
            )}
            <div className="mt-2 grid grid-cols-4 gap-2">
              {[0, 10, 15, 20].map((m) => {
                const targetAt = new Date(Date.now() + m * 60_000);
                const targetLabel = targetAt.toLocaleTimeString("en-US", {
                  timeZone: "America/Los_Angeles",
                  hour: "numeric",
                  minute: "2-digit",
                });
                return (
                  <button
                    key={m}
                    onClick={() => dispatchPickup(m)}
                    disabled={editBusy || !editPin}
                    className="flex flex-col items-center justify-center rounded-xl bg-gradient-to-br from-violet-600 to-fuchsia-700 py-1 text-sm font-semibold text-white shadow active:scale-95 hover:from-violet-500 hover:to-fuchsia-600 disabled:opacity-50"
                  >
                    <span className="leading-tight">{m === 0 ? "Now" : `${m} min`}</span>
                    <span className="font-mono text-[13px] font-normal text-violet-100/90 tabular-nums leading-tight">
                      {targetLabel}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Always-on "Where to?" entry — in-van case. The single source of
          truth for adding a destination once Mark / passenger is in the
          van. Bootstrap-or-append decided server-side. Idempotent,
          optimistic, offline-queue-backed. Hides during pickup-mode
          editing to avoid two competing input panels. */}
      {inVan && !inEditMode && (
        <div className="absolute inset-x-3 bottom-3 z-30">
          <DestinationInput
            token={token}
            myGps={myGps && myGpsTs ? { lat: myGps.lat, lng: myGps.lng, ageMs: Date.now() - myGpsTs } : null}
            onTripChanged={refresh}
          />
        </div>
      )}

      {/* No active trip + NOT in pickup mode — operational cards stacked
          with the "Van to you" tile pinned to the bottom (same visual slot
          the Final-destination card occupies when a trip is live). Mark
          always glances at the bottom of the screen for time-to-target:
          when waiting that's time-to-van; when picked up it becomes
          time-to-destination. The Van card is hidden when Mark is
          essentially in the van already (< 0.1 mi). */}
      {!live && !inEditMode && (
        <div className="absolute inset-x-3 bottom-3 z-30 space-y-2">
          <TripRecapCard token={token} />
          <FuelAlertCard
            fuelPct={pos?.fuel_pct ?? null}
            vanLat={pos?.lat ?? null}
            vanLng={pos?.lng ?? null}
            rangeMi={range?.range_miles ?? null}
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

      {/* Voice-cabin button retired — climate is one-tap on the right
          column already, and music / quiet / restroom voice-only commands
          were faster to just say out loud to Dio. Removing the float
          frees the bottom-right corner of the map. */}
      {/* External-Maps fallback removed — Mark's app doesn't need to
          deep-link out to Google Maps. He drives with built-in nav,
          and the in-app Van→destination view is the always-available
          context for waiting passengers. */}

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
  stops: Array<{
    id: string;
    address: string;
    lat?: number | null;
    lng?: number | null;
    arrived_at?: string | null;
    passenger?: string | null;
    passenger_link_token?: string | null;
  }>;
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

  const [reorderBusy, setReorderBusy] = useState(false);
  const [reorderErr, setReorderErr] = useState<string | null>(null);

  // Treat pickup as fixed, stops + dropoff as one ordered list. The
  // LAST entry in the list is the trip's dropoff; everything before it
  // is in stops[]. Arrived stops stay pinned in chronological order
  // at the front.
  type Destination = {
    id: string;
    address: string;
    lat?: number | null;
    lng?: number | null;
    arrived_at?: string | null;
    passenger?: string | null;
    passenger_link_token?: string | null;
    isDropoff: boolean;
  };
  // Filter out arrived stops entirely. Mark's spec: "as soon as
  // sprinter comes within 30m of a stop, that stop is GONE." Don't
  // render visited stops with a checkmark — drop them from the list
  // outright so the card always reflects what's still ahead.
  //
  // The last stop in the chain IS the trip's final destination — flag
  // it with isDropoff so the row renders with the dropoff treatment.
  const lastUnarrivedIdx = (() => {
    for (let i = stops.length - 1; i >= 0; i--) {
      if (!stops[i].arrived_at) return i;
    }
    return -1;
  })();
  const destinations: Destination[] = stops
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !s.arrived_at)
    .map(({ s, i }) => ({ ...s, isDropoff: i === lastUnarrivedIdx }));

  // Invite a passenger to a stop: prompt for name, POST it to the
  // per-stop passenger endpoint (which mints a link), then offer to
  // share the resulting tracking URL. Uses the same backend the map-
  // pin popup uses; this is just a more discoverable surface.
  const invitePassenger = async (id: string, currentName: string | null) => {
    if (reorderBusy) return;
    if (id.startsWith("__")) return; // dropoff invite goes through trip dispatch
    const name =
      typeof window !== "undefined"
        ? window.prompt(
            currentName ? "Update passenger name" : "Who's being picked up here?",
            currentName ?? "",
          )
        : null;
    if (name == null) return; // cancelled
    const trimmed = name.trim();
    setReorderErr(null);
    setReorderBusy(true);
    try {
      const res = await fetch(`/api/trips/${trip.id}/stops/${id}/passenger`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: trimmed || null }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`passenger POST ${res.status}: ${body.slice(0, 200)}`);
      }
      const j = (await res.json().catch(() => null)) as { token?: string | null } | null;
      if (trimmed && j?.token && typeof window !== "undefined") {
        const url = `${window.location.origin}/p/${j.token}`;
        await sharePassengerLink(trimmed, url);
      }
      refresh();
    } catch (err) {
      console.warn("[MarkApp] invitePassenger failed", err);
      setReorderErr((err as Error).message);
    } finally {
      setReorderBusy(false);
    }
  };

  // "Share live tracking" — mints (or reuses) the trip's GENERIC
  // passenger link via invite-guest. Anyone Mark sends this to opens
  // /p/<token> and sees the van moving in real time + ETA. Idempotent
  // so a second tap just re-shares the same link.
  const inviteGuest = async () => {
    if (reorderBusy) return;
    setReorderErr(null);
    setReorderBusy(true);
    try {
      const res = await fetch(`/api/trips/${trip.id}/invite-guest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`invite-guest ${res.status}: ${body.slice(0, 200)}`);
      }
      const j = (await res.json().catch(() => null)) as { token?: string } | null;
      if (!j?.token || typeof window === "undefined") return;
      const url = `${window.location.origin}/p/${j.token}`;
      await sharePassengerLink("passenger", url);
    } catch (err) {
      console.warn("[MarkApp] inviteGuest failed", err);
      setReorderErr((err as Error).message);
    } finally {
      setReorderBusy(false);
    }
  };

  // Open the native share sheet (iOS/Android). The recipient lands on
  // /p/<token> with the full passenger app (same map + trip card +
  // chat that Mark sees; settings tab is restricted to push toggle).
  //
  // On platforms with no Web Share API (mostly desktop), fall back to
  // an `sms:` deep link that opens iMessage with the URL prefilled.
  // Last resort copies silently to clipboard. Deliberately no follow-
  // up alert / prompt — once the share sheet closes, the user has
  // either sent the link or chosen not to; nagging them with a "copied"
  // banner after iMessage is just noise.
  const sharePassengerLink = async (name: string, url: string) => {
    // Keep the URL OUT of the `text` field — iOS appends it
    // automatically, so including it here makes the link show up
    // twice in iMessage. Same pattern as ShareTripButton.
    const text = "Join Sprinter trip here:";
    if (typeof navigator !== "undefined" && "share" in navigator) {
      try {
        await (
          navigator as Navigator & {
            share: (d: { title: string; text: string; url: string }) => Promise<void>;
          }
        ).share({
          title: `Sprinter ride${name && name !== "passenger" ? ` for ${name}` : ""}`,
          text,
          url,
        });
      } catch {
        // user cancelled or platform rejected the share — drop silently
      }
      return;
    }
    if (typeof window !== "undefined") {
      window.location.href = `sms:&body=${encodeURIComponent(`${text}\n${url}`)}`;
    }
  };

  // Push the destinations array to the server. Whole chain goes through
  // PUT /stops with optimize=false (so the user's explicit reorder
  // isn't clobbered). The legacy "PATCH /trips/[id] with dropoff_*" leg
  // is gone — chain ends ARE the pickup and dropoff now.
  const persist = async (next: Destination[]): Promise<void> => {
    const newStops = next.map((d) => ({
      // Pass everything through so the PUT endpoint re-fills with the
      // full Stop shape (passenger / token / arrived_at etc).
      ...(stops.find((s) => s.id === d.id) ?? {}),
      id: d.id.startsWith("__") ? undefined : d.id,
      address: d.address,
      lat: d.lat,
      lng: d.lng,
      arrived_at: d.arrived_at ?? null,
    }));
    const stopsRes = await fetch(`/api/trips/${trip.id}/stops`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ stops: newStops, optimize: false }),
    });
    if (!stopsRes.ok) {
      const body = await stopsRes.text().catch(() => "");
      throw new Error(`stops PUT ${stopsRes.status}: ${body.slice(0, 200)}`);
    }
  };

  // Drag-to-reorder state. Touch-friendly pointer-events: capture on
  // the grip handle means we get pointermove on the button even when
  // the finger wanders over neighboring rows, and rowRefs let us
  // hit-test which row the pointer is currently over.
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const dragRef = useRef<{ id: string; pointerId: number } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const startDrag = (id: string, e: React.PointerEvent<HTMLElement>) => {
    if (reorderBusy) return;
    dragRef.current = { id, pointerId: e.pointerId };
    setDraggingId(id);
    setDragOverId(id);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore — some browsers reject the capture on synthetic events
    }
  };

  const onDragMove = (e: React.PointerEvent<HTMLElement>) => {
    if (!dragRef.current) return;
    const y = e.clientY;
    for (const [rid, el] of rowRefs.current) {
      const r = el.getBoundingClientRect();
      if (y >= r.top && y < r.bottom) {
        setDragOverId(rid);
        return;
      }
    }
  };

  const endDrag = async () => {
    const drag = dragRef.current;
    const overId = dragOverId;
    dragRef.current = null;
    setDraggingId(null);
    setDragOverId(null);
    if (!drag || !overId || overId === drag.id) return;
    const fromIdx = destinations.findIndex((d) => d.id === drag.id);
    const toIdx = destinations.findIndex((d) => d.id === overId);
    if (fromIdx < 0 || toIdx < 0) return;
    const firstPending = destinations.findIndex((d) => !d.arrived_at);
    // Can't drop into the arrived/historical range.
    if (toIdx < firstPending) return;
    const next = destinations.slice();
    const [picked] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, picked);
    setReorderErr(null);
    setReorderBusy(true);
    try {
      await persist(next);
      refresh();
    } catch (err) {
      console.warn("[MarkApp] drag reorder failed", err);
      setReorderErr((err as Error).message);
    } finally {
      setReorderBusy(false);
    }
  };

  // Remove an intermediate stop. The dropoff isn't deletable from
  // here — a trip needs an endpoint. To swap the dropoff out, Mark
  // promotes a different stop (Flag button) first, which demotes the
  // old dropoff into the stops list where IT becomes removable.
  const deleteStop = async (id: string, address: string) => {
    if (reorderBusy) return;
    if (id.startsWith("__")) return; // can't delete the virtual dropoff
    const ok =
      typeof window !== "undefined"
        ? window.confirm(`Remove this stop?\n\n${address}`)
        : false;
    if (!ok) return;
    setReorderErr(null);
    setReorderBusy(true);
    try {
      const res = await fetch(`/api/trips/${trip.id}/stops?stop=${id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`stops DELETE ${res.status}: ${body.slice(0, 200)}`);
      }
      refresh();
    } catch (err) {
      console.warn("[MarkApp] deleteStop failed", err);
      setReorderErr((err as Error).message);
    } finally {
      setReorderBusy(false);
    }
  };

  // Promote a destination to be the LAST one (the trip's final
  // dropoff). Move it to the end of the destinations array; whatever
  // WAS the dropoff slides into its old position.
  const promoteToDropoff = async (id: string) => {
    if (reorderBusy) return;
    setReorderErr(null);
    const idx = destinations.findIndex((d) => d.id === id);
    if (idx < 0 || idx === destinations.length - 1) return;
    const next = destinations.slice();
    const [picked] = next.splice(idx, 1);
    next.push(picked);
    setReorderBusy(true);
    try {
      await persist(next);
      refresh();
    } catch (err) {
      console.warn("[MarkApp] promoteToDropoff failed", err);
      setReorderErr((err as Error).message);
    } finally {
      setReorderBusy(false);
    }
  };

  // Manual cancel escape hatch — for stuck/test trips that the cron
  // sweep would eventually catch but Mark wants gone now. Confirms
  // before firing so an accidental tap doesn't kill a real trip.
  const [cancelBusy, setCancelBusy] = useState(false);
  const cancelTrip = async () => {
    if (cancelBusy) return;
    const ok = typeof window !== "undefined"
      ? window.confirm("Cancel this trip? This can't be undone.")
      : false;
    if (!ok) return;
    setCancelBusy(true);
    try {
      await postJson(token, `/api/trips/${trip.id}/cancel`, {});
      refresh();
      onClose();
    } catch (err) {
      console.warn("[MarkApp] cancel trip failed", err);
    } finally {
      setCancelBusy(false);
    }
  };

  return (
    <Sheet title={`Trip · ${statusLabel(trip.status)}`} onClose={onClose}>
      <div className="text-base font-semibold text-zinc-100">{trip.passenger_name}</div>
      <div className="mt-2 space-y-1.5 text-sm text-zinc-300">
        {/* Pickup line — first stop in the chain, only when it hasn't
            been visited yet. After the 30m gate the destinations list
            below already shows what's still ahead. */}
        {stops[0] && !stops[0].arrived_at && stops[0].address && (
          <div className="py-1">📍 {stops[0].address}</div>
        )}
        {destinations.map((d, i) => {
          const isPending = !d.arrived_at;
          const isLast = i === destinations.length - 1;
          const prefix = d.arrived_at ? "✓" : isLast ? "🏁" : `${i + 1}.`;
          const isDragSource = draggingId === d.id;
          const isDropTarget = dragOverId === d.id && draggingId && draggingId !== d.id;
          return (
            <div
              key={d.id}
              ref={(el) => {
                if (el) rowRefs.current.set(d.id, el);
                else rowRefs.current.delete(d.id);
              }}
              className={`flex items-center gap-1.5 rounded-lg px-1 py-1 transition-colors ${
                isDragSource ? "opacity-40" : ""
              } ${isDropTarget ? "bg-emerald-900/30 ring-1 ring-emerald-700" : ""}`}
            >
              <span className="flex-1 leading-snug">
                <span>{prefix} {d.address}</span>
                {d.passenger && (
                  <span className="ml-1 text-xs text-violet-300">· {d.passenger}</span>
                )}
              </span>
              {isPending && (
                <>
                  {!d.id.startsWith("__") && (
                    <>
                      {d.passenger && d.passenger_link_token && (
                        <button
                          onClick={() => {
                            const url = `${window.location.origin}/p/${d.passenger_link_token}`;
                            void sharePassengerLink(d.passenger ?? "passenger", url);
                          }}
                          disabled={reorderBusy}
                          className="flex h-9 w-9 items-center justify-center rounded-lg border border-violet-900/60 bg-violet-950/30 text-violet-300 hover:bg-violet-900/40 disabled:opacity-25"
                          aria-label="Share passenger link"
                          title={`Share link for ${d.passenger}`}
                        >
                          <Share2 size={18} />
                        </button>
                      )}
                      <button
                        onClick={() => invitePassenger(d.id, d.passenger ?? null)}
                        disabled={reorderBusy}
                        className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-violet-300 hover:bg-zinc-800 disabled:opacity-25"
                        aria-label={d.passenger ? "Edit passenger" : "Invite passenger"}
                        title={d.passenger ? `Edit ${d.passenger}` : "Invite passenger"}
                      >
                        <UserPlus size={18} />
                      </button>
                    </>
                  )}
                  {!isLast && !d.id.startsWith("__") && (
                    <button
                      onClick={() => deleteStop(d.id, d.address)}
                      disabled={reorderBusy}
                      className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-red-400 hover:bg-red-950/50 disabled:opacity-25"
                      aria-label="Delete this stop"
                      title="Delete this stop"
                    >
                      <Trash2 size={18} />
                    </button>
                  )}
                  {!isLast && (
                    <button
                      onClick={() => promoteToDropoff(d.id)}
                      disabled={reorderBusy}
                      className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-emerald-400 hover:bg-zinc-800 disabled:opacity-25"
                      aria-label="Make this the final destination"
                      title="Make this the final destination"
                    >
                      <Flag size={18} />
                    </button>
                  )}
                  {/* Drag handle. Pointer events on the handle only —
                      tapping the row text still lets the sheet scroll
                      normally. touch-action: none stops the browser
                      from claiming the touch as a vertical scroll. */}
                  <button
                    onPointerDown={(e) => startDrag(d.id, e)}
                    onPointerMove={onDragMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    disabled={reorderBusy}
                    style={{ touchAction: "none" }}
                    className="flex h-9 w-9 cursor-grab items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400 hover:bg-zinc-800 active:cursor-grabbing disabled:opacity-25"
                    aria-label="Drag to reorder"
                  >
                    <GripVertical size={20} />
                  </button>
                </>
              )}
            </div>
          );
        })}
        {reorderErr && (
          <div className="rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-300">
            Reorder failed: {reorderErr}
          </div>
        )}
      </div>
      <div className="mt-4">
        <AddressAutocomplete token={token} onSelect={addStopAddress} placeholder="Add a stop or destination — autocompletes" />
      </div>
      {/* Invite passenger — mints (or reuses) the trip-level passenger
          link via /invite-guest and opens the native share sheet. The
          recipient gets the FULL passenger app at /p/<token> (same map,
          trip card, chat, all of it — only the settings tab is
          restricted to push toggle). Distinct from the per-stop
          UserPlus button above, which mints a NAMED link tied to a
          specific pickup point. */}
      <button
        onClick={inviteGuest}
        disabled={reorderBusy}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
      >
        <UserPlus size={16} /> Invite passenger
      </button>
      <button
        onClick={cancelTrip}
        disabled={cancelBusy}
        className="mt-3 w-full rounded-2xl border border-red-900/60 bg-red-950/40 px-4 py-2.5 text-sm font-semibold text-red-300 hover:bg-red-900/60 disabled:opacity-50"
      >
        {cancelBusy ? "Cancelling…" : "Cancel trip"}
      </button>
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

function SettingsTab({
  token,
  origin,
  role,
}: {
  token: string;
  origin: string;
  role: "mark" | "passenger";
}) {
  // Passengers see ONLY the push-notifications toggle. Everything else
  // (insights, Bouncie credentials, link minting, Dio status editor) is
  // owner-only. Keeps the surface identical between roles otherwise so
  // the same component serves both apps.
  if (role === "passenger") {
    return (
      <main className="mx-auto max-w-3xl space-y-3 px-3 pb-6 pt-3">
        <PushToggle token={token} />
      </main>
    );
  }
  return (
    <main className="mx-auto max-w-3xl space-y-3 px-3 pb-6 pt-3">
      <InsightsCard token={token} />
      <PushToggle token={token} />
      <BouncieConnectCard token={token} />
      <LinkGenerator token={token} origin={origin} />
    </main>
  );
}
