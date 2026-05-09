"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Trip } from "@/lib/types";
import { useTrips, activeTrip } from "@/components/useTrips";
import { useEta } from "@/components/useEta";
import { useDriverGpsReporter } from "@/components/useMarkLocation";
import { api, postJson } from "@/lib/api-client";
import { googleMapsTo } from "@/lib/maps-link";
import { shortTime } from "@/lib/format";
import CabinRequestInbox from "@/components/CabinRequestInbox";
import { Navigation, User, MapPin, Check, ArrowUp, Loader2 } from "lucide-react";

interface ChatMsg {
  id: string;
  sender_role: "mark" | "dio";
  body: string;
  sent_at: string;
  read_at: string | null;
}

// Driving-mode design: ONE screen, big tap targets, minimal interaction.
// Cabin requests at top → trip card → giant navigate + advance buttons → chat.
export default function DioApp({ token, name: _name }: { token: string; name: string }) {
  useDriverGpsReporter(token, true);
  const { trips, refresh } = useTrips(token, 4000);
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
      <div className="mx-auto flex max-w-2xl flex-col gap-3 px-3 pt-3">
        <CabinRequestInbox token={token} />

        {focus ? (
          <DriverHero
            trip={focus}
            live={!!live}
            etaMin={eta?.eta_minutes ?? null}
            etaMiles={eta?.to_next?.distance_miles ?? null}
            token={token}
            onAdvance={refresh}
          />
        ) : (
          <IdleCard />
        )}

        <ChatBlock token={token} />
      </div>
    </div>
  );
}

function DriverHero({
  trip,
  live,
  etaMin,
  etaMiles,
  token,
  onAdvance,
}: {
  trip: Trip;
  live: boolean;
  etaMin: number | null;
  etaMiles: number | null;
  token: string;
  onAdvance: () => void;
}) {
  const target: "pickup" | "dropoff" =
    trip.status === "onboard" || trip.status === "at_dropoff" ? "dropoff" : "pickup";
  const targetLat = target === "pickup" ? trip.pickup_lat : trip.dropoff_lat;
  const targetLng = target === "pickup" ? trip.pickup_lng : trip.dropoff_lng;
  const targetAddr = target === "pickup" ? trip.pickup_address : trip.dropoff_address;

  const navUrl = targetLat != null && targetLng != null ? googleMapsTo(targetLat, targetLng) : null;

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
    <div className="space-y-3">
      <div className="rounded-3xl border border-zinc-800 bg-zinc-950/90 p-5">
        <div className="text-xs uppercase tracking-widest text-zinc-500">
          {live ? "Active trip" : "Next trip"}
        </div>
        <div className="mt-2 flex items-center gap-2">
          <User size={26} className="text-zinc-400" />
          <span className="text-3xl font-bold text-zinc-100">{trip.passenger_name}</span>
        </div>
        <div className="mt-3 flex items-start gap-2 text-zinc-200">
          <MapPin size={20} className="mt-1 shrink-0 text-amber-400" />
          <span className="text-lg">{targetAddr ?? "(no address)"}</span>
        </div>
        <div className="mt-3 flex items-baseline justify-between">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-4xl font-bold tabular-nums text-emerald-300">
              {etaMin != null ? etaMin : "—"}
            </span>
            <span className="text-base text-zinc-500">min</span>
            {etaMiles != null && (
              <span className="ml-2 font-mono text-base text-zinc-400">{etaMiles} mi</span>
            )}
          </div>
          <div className="text-base text-zinc-500">
            {live ? "" : `Pickup ${shortTime(trip.scheduled_at)}`}
          </div>
        </div>
      </div>

      {navUrl && (
        <a
          href={navUrl}
          target="_blank"
          rel="noreferrer"
          className="flex h-20 w-full items-center justify-center gap-3 rounded-3xl bg-gradient-to-br from-emerald-500 to-emerald-700 text-2xl font-bold text-white shadow-2xl shadow-emerald-900/40 active:scale-[0.99]"
        >
          <Navigation size={28} /> Navigate in Google Maps
        </a>
      )}

      {action && (
        <button
          onClick={advance}
          disabled={busy}
          className={`flex h-16 w-full items-center justify-center gap-2 rounded-3xl text-xl font-bold text-white shadow-2xl active:scale-[0.99] disabled:opacity-50 ${action.color}`}
        >
          {busy ? <Loader2 size={20} className="animate-spin" /> : <Check size={22} />}{" "}
          {action.label}
        </button>
      )}
    </div>
  );
}

// Simplified driver-facing button labels. Two states cycle as the trip
// progresses ("On my way" / "Arrived"), with "Complete" only at the end.
// The underlying status machine still has 5 stops so passengers/Mark see
// progress, but Dio sees just the next action he needs.
function nextAction(status: Trip["status"]): { label: string; action: string; color: string } | null {
  switch (status) {
    case "scheduled":
      return { label: "On my way", action: "dispatch", color: "bg-blue-600 hover:bg-blue-500" };
    case "dispatched":
      return { label: "Arrived", action: "at_pickup", color: "bg-emerald-600 hover:bg-emerald-500" };
    case "at_pickup":
      return { label: "On my way", action: "onboard", color: "bg-blue-600 hover:bg-blue-500" };
    case "onboard":
      return { label: "Arrived", action: "at_dropoff", color: "bg-emerald-600 hover:bg-emerald-500" };
    case "at_dropoff":
      return { label: "Complete", action: "complete", color: "bg-emerald-700 hover:bg-emerald-600" };
    default:
      return null;
  }
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

// Inline chat block — last 3 messages + a single-line input. No tabs, no
// switching screens. Designed so Dio can glance at Mark's last note while
// stopped without leaving the trip view.
function ChatBlock({ token }: { token: string }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const lastSeenRef = useRef<string | null>(null);

  const refresh = async () => {
    try {
      const data = await api<{ messages: ChatMsg[] }>(token, "/api/messages");
      setMessages(data.messages || []);
    } catch {
      // ignore
    }
  };
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [token]);

  const last3 = messages.slice(-3);
  const latestId = messages[messages.length - 1]?.id ?? null;
  const isNewFromMark =
    latestId &&
    latestId !== lastSeenRef.current &&
    messages[messages.length - 1]?.sender_role === "mark";
  useEffect(() => {
    if (latestId) lastSeenRef.current = latestId;
  }, [latestId]);

  const send = async () => {
    if (!input.trim() || busy) return;
    setBusy(true);
    const text = input;
    setInput("");
    try {
      await postJson(token, "/api/messages", { body: text });
      await refresh();
    } catch {
      setInput(text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`rounded-3xl border bg-zinc-950/90 p-4 ${
        isNewFromMark ? "border-amber-500/70 shadow-lg shadow-amber-900/30" : "border-zinc-800"
      }`}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs uppercase tracking-widest text-zinc-500">Mark</span>
        {isNewFromMark && (
          <span className="rounded-full bg-amber-600 px-2 py-0.5 text-[10px] font-bold uppercase text-white">
            New
          </span>
        )}
      </div>
      {last3.length === 0 ? (
        <div className="text-sm text-zinc-500">No messages yet.</div>
      ) : (
        <ul className="space-y-1.5">
          {last3.map((m) => {
            const mine = m.sender_role === "dio";
            return (
              <li
                key={m.id}
                className={`max-w-[85%] rounded-2xl px-3 py-2 text-base ${
                  mine ? "ml-auto bg-emerald-700 text-white" : "mr-auto bg-zinc-800 text-zinc-100"
                }`}
              >
                {m.body}
              </li>
            );
          })}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="mt-3"
      >
        <div className="relative">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Message Mark…"
            className="w-full rounded-2xl border border-zinc-800 bg-zinc-900 px-4 py-3 pr-14 text-base text-zinc-100 placeholder-zinc-500 outline-none focus:border-emerald-700"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="absolute right-2 top-1/2 -translate-y-1/2 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg disabled:bg-zinc-700 disabled:opacity-50 enabled:hover:bg-emerald-500"
            aria-label="Send"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={18} strokeWidth={3} />}
          </button>
        </div>
      </form>
    </div>
  );
}

