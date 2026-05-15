"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trip } from "@/lib/types";
import { useTrips, activeTrip } from "@/components/useTrips";
import { useEta } from "@/components/useEta";
import { useDriverGpsReporter } from "@/components/useMarkLocation";
import { useRealtime } from "@/components/useRealtime";
import { api, postJson } from "@/lib/api-client";
import { googleMapsTo } from "@/lib/maps-link";
import { compactAddr } from "@/lib/format";
import PushToggle from "@/components/PushToggle";
import InstallPrompt from "@/components/InstallPrompt";
import {
  Bell,
  MessageCircle,
  Navigation,
  ThermometerSnowflake,
  ThermometerSun,
  Wind,
  Music,
  VolumeX,
  Toilet,
} from "lucide-react";

// Driver app — radically minimal. One screen:
//   1. Where to drive next + when to arrive + one-tap Google Maps.
//   2. Alerts inbox: chat messages + cabin requests, each blinking
//      until the driver taps to acknowledge.
// No advance buttons (GPS auto-advance handles state transitions).
// No passenger name, no fuel, no settings — just what a driver needs
// to glance at while parked at a light.
export default function DioApp({ token, name: _name }: { token: string; name: string }) {
  useDriverGpsReporter(token, true);
  const { trips } = useTrips(token, 4000);
  const live = activeTrip(trips);
  const focus: Trip | null =
    live ??
    trips
      .filter((t) => t.status === "scheduled")
      .sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime())[0] ??
    null;
  const { eta } = useEta(token, focus?.id ?? null, 25_000);

  return (
    <div className="min-h-screen bg-zinc-950 pb-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-3 pt-3">
        {focus ? <DestinationCard trip={focus} eta={eta} /> : <IdleCard />}
        <Alerts token={token} />
        <div className="mt-2">
          <PushToggle token={token} />
        </div>
      </div>
      {/* Add-to-Home-Screen prompt. Dio is a daily user — installing
          unlocks reliable push alerts for new trips, so he gets the
          firm nudge. */}
      <InstallPrompt role="dio" />
    </div>
  );
}

interface EtaShape {
  eta_minutes: number | null;
  to_next?: {
    kind: "pickup" | "stop" | "dropoff";
    label: string;
    eta_minutes: number;
    distance_miles: number;
  } | null;
  to_final?: {
    kind: "pickup" | "stop" | "dropoff";
    label: string;
    eta_minutes: number;
    distance_miles: number;
  } | null;
}

// Stable storage key for the destination Dio last acknowledged.
// Persists across reloads so a casual app refresh mid-trip doesn't
// re-flash an already-seen destination. Cleared automatically when
// the destination changes (the new key won't match).
const DIO_ACK_DEST_KEY = "sprinter:dio:acked_destination";

function DestinationCard({ trip, eta }: { trip: Trip; eta: EtaShape | null }) {
  // The ETA endpoint's "next waypoint" knows about stops + arrived-at
  // flags so it always reflects the right next destination. Trip's
  // legacy pickup/dropoff fields are the fallback for the brief window
  // before the first ETA arrives.
  const next = eta?.to_next ?? null;
  const fallbackTarget: "pickup" | "dropoff" =
    trip.status === "onboard" || trip.status === "at_dropoff" ? "dropoff" : "pickup";
  const fallbackLat = fallbackTarget === "pickup" ? trip.pickup_lat : trip.dropoff_lat;
  const fallbackLng = fallbackTarget === "pickup" ? trip.pickup_lng : trip.dropoff_lng;
  const fallbackAddr = fallbackTarget === "pickup" ? trip.pickup_address : trip.dropoff_address;
  const kind: "pickup" | "stop" | "dropoff" = next?.kind ?? fallbackTarget;
  const label = next?.label ?? fallbackAddr ?? "(no address)";

  // Stable identity for the current destination. Used to detect when
  // Mark's changed it: if `destKey` doesn't match what Dio acknowledged
  // last, the card flashes gold until he taps it or hits Navigate.
  // Trip id + kind + label is sufficient — when Mark swaps an address
  // the label changes; when the trip's destination kind transitions
  // (pickup→dropoff after pickup arrival) the kind changes.
  const destKey = useMemo(
    () => `${trip.id}|${kind}|${label}`,
    [trip.id, kind, label],
  );

  const [acknowledgedKey, setAcknowledgedKey] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return window.localStorage.getItem(DIO_ACK_DEST_KEY);
    } catch {
      return null;
    }
  });
  const isNewDestination = destKey !== acknowledgedKey;
  const acknowledge = useCallback(() => {
    setAcknowledgedKey(destKey);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(DIO_ACK_DEST_KEY, destKey);
      } catch {
        // private mode / quota — fine, the in-memory state already
        // suppresses the flash for this session.
      }
    }
  }, [destKey]);

  // Where Google Maps should drop the user. Use the trip's dropoff/pickup
  // lat/lng — the ETA endpoint doesn't echo per-waypoint coords today.
  const navUrl =
    fallbackLat != null && fallbackLng != null ? googleMapsTo(fallbackLat, fallbackLng) : null;

  // Per Mark's spec: only the PRIMARY scheduled pickup shows a time.
  // Along-the-way pickups (added by joining passengers) and the dropoff
  // have no commitment time — just the address + Navigate. The trip's
  // scheduled_at is the commitment for the first pickup; once the trip
  // moves past at_pickup (onboard / at_dropoff), the scheduled time is
  // historical and we don't surface it.
  const showScheduledPickupTime =
    kind === "pickup" &&
    (trip.status === "scheduled" || trip.status === "dispatched" || trip.status === "at_pickup");
  const scheduledTime = useMemo(() => {
    if (!showScheduledPickupTime || !trip.scheduled_at) return null;
    return new Date(trip.scheduled_at).toLocaleTimeString("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "numeric",
      minute: "2-digit",
    });
  }, [showScheduledPickupTime, trip.scheduled_at]);

  // Live "are we on track?" indicator. Compares the trip's committed
  // time against Mapbox's current ETA. Updates every ETA poll. Green
  // when on-time or early, red when late. Only shown on the primary
  // pickup, alongside the scheduled time.
  const minutesAvailable = eta?.eta_minutes ?? eta?.to_next?.eta_minutes ?? null;
  const lateness = useMemo<{ tone: "early" | "on" | "late"; label: string } | null>(() => {
    if (!showScheduledPickupTime || !trip.scheduled_at || minutesAvailable == null) return null;
    const computedArrivalMs = Date.now() + minutesAvailable * 60_000;
    const scheduledMs = new Date(trip.scheduled_at).getTime();
    const deltaMin = Math.round((computedArrivalMs - scheduledMs) / 60_000);
    if (Math.abs(deltaMin) <= 2) return { tone: "on", label: "On time" };
    if (deltaMin < 0) return { tone: "early", label: `${Math.abs(deltaMin)} min early` };
    return { tone: "late", label: `${deltaMin} min late` };
  }, [showScheduledPickupTime, trip.scheduled_at, minutesAvailable]);

  const typeLabel = kind === "pickup" ? "Pickup" : kind === "dropoff" ? "Dropoff" : "Stop";
  const typeTint = kind === "pickup" ? "text-amber-300" : "text-blue-300";

  return (
    <div className="space-y-3">
      {/* Inline keyframes for the gold-flash. Loaded once; the
          .sprinter-dest-new class is gated by isNewDestination below
          so the animation only runs on a destination Dio hasn't
          acknowledged yet. */}
      <style>{`
        @keyframes sprinter-dest-gold-pulse {
          0%, 100% {
            box-shadow:
              0 0 0 4px rgba(250, 204, 21, 1),
              0 0 24px 8px rgba(250, 204, 21, 0.55);
          }
          50% {
            box-shadow:
              0 0 0 6px rgba(250, 204, 21, 0.35),
              0 0 36px 18px rgba(250, 204, 21, 0.15);
          }
        }
        .sprinter-dest-new {
          animation: sprinter-dest-gold-pulse 1.2s ease-in-out infinite;
          border-color: rgb(250, 204, 21) !important;
        }
      `}</style>
      <div
        onClick={acknowledge}
        className={`rounded-3xl border bg-zinc-950/90 p-5 transition-all ${
          isNewDestination
            ? "sprinter-dest-new cursor-pointer border-yellow-400"
            : "border-zinc-800"
        }`}
      >
        <div className={`text-xs uppercase tracking-widest ${typeTint}`}>{typeLabel}</div>
        <div className="mt-2 text-3xl font-bold leading-tight text-zinc-100">
          {compactAddr(label)}
        </div>
        {scheduledTime && (
          <div className="mt-4">
            <div className="text-[10px] uppercase tracking-widest text-zinc-500">Be there at</div>
            <div className="mt-1 flex items-baseline justify-between gap-3">
              <div className="font-mono text-4xl font-bold tabular-nums leading-none text-emerald-300">
                {scheduledTime}
              </div>
              {lateness && (
                <div
                  className={`rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wider ${
                    lateness.tone === "late"
                      ? "bg-red-600 text-white"
                      : "bg-emerald-700 text-emerald-100"
                  }`}
                >
                  {lateness.label}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {navUrl && (
        <a
          href={navUrl}
          target="_blank"
          rel="noreferrer"
          onClick={acknowledge}
          className="flex h-20 w-full items-center justify-center gap-3 rounded-3xl bg-gradient-to-br from-emerald-500 to-emerald-700 text-2xl font-bold text-white shadow-2xl shadow-emerald-900/40 active:scale-[0.99]"
        >
          <Navigation size={28} /> Navigate
        </a>
      )}
    </div>
  );
}

function IdleCard() {
  return (
    <div className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-8 text-center">
      <div className="text-3xl">🛌</div>
      <div className="mt-2 text-2xl font-semibold text-zinc-100">All clear</div>
      <div className="mt-1 text-base text-zinc-500">No trips scheduled.</div>
    </div>
  );
}

// ===================================================================
// Alerts inbox — chat messages + cabin requests as a single stream.
// ===================================================================

interface ChatMsg {
  id: string;
  sender_role: "mark" | "dio" | "passenger";
  body: string;
  sent_at: string;
  read_at: string | null;
}

interface CabinReq {
  id: string;
  kind: string;
  value: string | null;
  trip_id: string | null;
  requested_at: string;
  acknowledged_at: string | null;
}

interface AlertItem {
  id: string;
  kind: "chat" | "cabin";
  ts: number; // unix ms for sort
  // Chat fields
  sender?: ChatMsg["sender_role"];
  body?: string;
  // Cabin fields
  reqKind?: string;
  reqLabel?: string;
}

const CABIN_META: Record<string, { Icon: typeof Bell; label: string; tint: string }> = {
  cooler: { Icon: ThermometerSnowflake, label: "Make it cooler", tint: "text-sky-300" },
  warmer: { Icon: ThermometerSun, label: "Make it warmer", tint: "text-orange-300" },
  fan_up: { Icon: Wind, label: "Fan higher", tint: "text-emerald-300" },
  fan_down: { Icon: Wind, label: "Fan lower", tint: "text-zinc-300" },
  music: { Icon: Music, label: "Play music", tint: "text-pink-300" },
  quiet: { Icon: VolumeX, label: "Less music", tint: "text-violet-300" },
  restroom: { Icon: Toilet, label: "Restroom needed", tint: "text-amber-300" },
};

const ACK_KEY = "dio:acked-chat-ids";

// Persisted chat ack-set. We don't have a server-side "seen by Dio"
// column today, so the driver's app remembers which message ids it
// already acknowledged in localStorage. Cabin requests have a proper
// server-side acknowledged_at and don't need this hack.
function useAckedChat(): {
  acked: Set<string>;
  ack: (id: string) => void;
} {
  const [acked, setAcked] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const raw = window.localStorage.getItem(ACK_KEY);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  });
  const ack = useCallback((id: string) => {
    setAcked((prev) => {
      const next = new Set(prev);
      next.add(id);
      try {
        window.localStorage.setItem(ACK_KEY, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  }, []);
  return { acked, ack };
}

function Alerts({ token }: { token: string }) {
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [cabin, setCabin] = useState<CabinReq[]>([]);
  const { acked, ack } = useAckedChat();

  const loadChat = useCallback(async () => {
    try {
      const data = await api<{ messages: ChatMsg[] }>(token, "/api/messages");
      setChat(data.messages ?? []);
    } catch {
      // ignore
    }
  }, [token]);
  const loadCabin = useCallback(async () => {
    try {
      const data = await api<{ requests: CabinReq[] }>(token, "/api/cabin-requests?pending=1");
      setCabin(data.requests ?? []);
    } catch {
      // ignore
    }
  }, [token]);

  useEffect(() => {
    loadChat();
    loadCabin();
    const id = setInterval(() => {
      loadChat();
      loadCabin();
    }, 8000);
    return () => clearInterval(id);
  }, [loadChat, loadCabin]);
  useRealtime({ table: "messages", onChange: loadChat });
  useRealtime({ table: "cabin_requests", onChange: loadCabin });

  // When Dio swipes back from Google Maps / lock screen into the app,
  // refetch immediately so the alerts list isn't lagged by the 8s poll
  // interval. Push notifications wake him up; this catches state any
  // time the tab regains visibility (foreground, unlock, app switch).
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        loadChat();
        loadCabin();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [loadChat, loadCabin]);

  // Vibrate when a new alert lands while the tab is foregrounded.
  // iOS Safari doesn't support navigator.vibrate yet — silent no-op
  // there. Android Chrome PWAs do.
  const lastAlertCountRef = useRef(0);
  useEffect(() => {
    const count = chat.filter((m) => m.sender_role !== "dio" && !acked.has(m.id)).length + cabin.length;
    if (count > lastAlertCountRef.current && typeof navigator !== "undefined") {
      try {
        (navigator as Navigator & { vibrate?: (p: number | number[]) => boolean }).vibrate?.([60, 40, 60]);
      } catch {
        // ignore
      }
    }
    lastAlertCountRef.current = count;
  }, [chat, cabin, acked]);

  const ackCabin = async (id: string) => {
    setCabin((prev) => prev.filter((r) => r.id !== id));
    try {
      await fetch("/api/cabin-requests", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
    } catch {
      loadCabin();
    }
  };

  const items: AlertItem[] = useMemo(() => {
    const out: AlertItem[] = [];
    // Chat: every message NOT sent by Dio and not yet acked locally.
    for (const m of chat) {
      if (m.sender_role === "dio") continue;
      if (acked.has(m.id)) continue;
      out.push({
        id: `chat:${m.id}`,
        kind: "chat",
        ts: new Date(m.sent_at).getTime(),
        sender: m.sender_role,
        body: m.body,
      });
    }
    // Cabin: every pending request.
    for (const r of cabin) {
      const meta = CABIN_META[r.kind];
      out.push({
        id: `cabin:${r.id}`,
        kind: "cabin",
        ts: new Date(r.requested_at).getTime(),
        reqKind: r.kind,
        reqLabel: meta?.label ?? r.kind,
      });
    }
    // Newest first.
    out.sort((a, b) => b.ts - a.ts);
    return out;
  }, [chat, cabin, acked]);

  if (items.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-widest text-zinc-500">Alerts</div>
      {items.map((item) => {
        const onTap = () => {
          if (item.kind === "chat") {
            ack(item.id.replace(/^chat:/, ""));
          } else {
            void ackCabin(item.id.replace(/^cabin:/, ""));
          }
        };
        return <AlertCard key={item.id} item={item} onTap={onTap} />;
      })}
    </div>
  );
}

function AlertCard({ item, onTap }: { item: AlertItem; onTap: () => void }) {
  const isCabin = item.kind === "cabin";
  const meta = isCabin && item.reqKind ? CABIN_META[item.reqKind] : null;
  const Icon = meta?.Icon ?? MessageCircle;
  const tint = meta?.tint ?? "text-amber-300";
  const senderLabel =
    item.sender === "mark" ? "Mark" : item.sender === "passenger" ? "Passenger" : "";
  return (
    <button
      onClick={onTap}
      className="flex w-full items-center gap-3 rounded-2xl border border-amber-600/60 bg-amber-950/40 px-4 py-3 text-left shadow-lg shadow-amber-900/30 animate-pulse active:scale-[0.99]"
      aria-label="Acknowledge"
    >
      <Icon size={26} className={`${tint} shrink-0`} />
      <div className="min-w-0 flex-1">
        {isCabin ? (
          <div className="text-lg font-semibold text-amber-50 leading-tight">{item.reqLabel}</div>
        ) : (
          <>
            {senderLabel && (
              <div className="text-[10px] uppercase tracking-widest text-amber-400/80">
                {senderLabel}
              </div>
            )}
            <div className="text-base font-medium text-amber-50 leading-tight">{item.body}</div>
          </>
        )}
      </div>
      <div className="text-[10px] uppercase tracking-widest text-amber-400/60">Tap</div>
    </button>
  );
}
