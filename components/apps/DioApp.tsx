"use client";

import { useEffect, useMemo, useState } from "react";
import { Trip } from "@/lib/types";
import { useTrips, activeTrip } from "@/components/useTrips";
import { useEta } from "@/components/useEta";
import { postJson } from "@/lib/api-client";
import { googleMapsTo } from "@/lib/maps-link";
import { shortTime } from "@/lib/format";
import CabinRequestInbox from "@/components/CabinRequestInbox";
import { Navigation, User, MapPin, Check, Phone } from "lucide-react";

// Driving-mode Dio app: GIANT buttons, glanceable, single column.
// Eyes-on-road design: the main action is always the largest visible element.
export default function DioApp({ token, name }: { token: string; name: string }) {
  const { trips, refresh } = useTrips(token, 4000);
  const live = activeTrip(trips);
  const upcoming = trips.filter((t) => t.status === "scheduled").sort((a, b) => new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime());
  const focus: Trip | null = live ?? upcoming[0] ?? null;
  const { eta } = useEta(token, focus?.id ?? null, 25_000);

  return (
    <div className="min-h-screen bg-zinc-950 pb-24">
      {/* Inbox always at top — climate / restroom requests */}
      <div className="sticky top-0 z-30 mx-auto max-w-2xl px-3 pt-3">
        <CabinRequestInbox token={token} />
      </div>

      <div className="mx-auto max-w-2xl px-3 pt-3 space-y-3">
        {/* Hero panel */}
        {focus ? (
          <DriverHero trip={focus} live={!!live} etaMin={eta?.eta_minutes ?? null} token={token} onAdvance={refresh} />
        ) : (
          <IdlePanel name={name} />
        )}

        {/* Compact upcoming queue (only when nothing live) */}
        {!live && upcoming.length > 1 && (
          <UpcomingList trips={upcoming.slice(1, 5)} />
        )}
      </div>
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
    <div className="space-y-3">
      {/* Passenger + ETA — large, simple */}
      <div className="rounded-3xl border border-zinc-800 bg-zinc-950/80 p-5">
        <div className="text-xs uppercase tracking-widest text-zinc-500">{live ? "Active trip" : "Next pickup"}</div>
        <div className="mt-1 flex items-center gap-2">
          <User size={22} className="text-zinc-400" />
          <span className="text-2xl font-bold text-zinc-100">{trip.passenger_name}</span>
        </div>
        <div className="mt-2 flex items-start gap-2 text-zinc-300">
          <MapPin size={16} className="mt-1 text-amber-400" />
          <span className="text-base">{targetAddr ?? "(no address)"}</span>
        </div>
        <div className="mt-3 flex items-center justify-between">
          <div className="text-xl font-mono tabular-nums text-emerald-300">
            {etaMin != null ? `${etaMin} min` : "—"}
          </div>
          <div className="text-sm text-zinc-500">
            {live ? "" : `Pickup at ${shortTime(trip.scheduled_at)}`}
          </div>
        </div>
      </div>

      {/* GIANT Navigate button — primary action */}
      {navUrl && (
        <a
          href={navUrl}
          target="_blank"
          rel="noreferrer"
          className="flex h-24 w-full items-center justify-center gap-3 rounded-3xl bg-gradient-to-br from-emerald-500 to-emerald-700 text-3xl font-bold text-white shadow-2xl shadow-emerald-900/40 active:scale-[0.99]"
        >
          <Navigation size={32} />
          <span>Navigate in Google Maps</span>
        </a>
      )}

      {/* GIANT next-action button (At pickup → Onboard → At dropoff → Complete) */}
      {action && (
        <button
          onClick={advance}
          disabled={busy}
          className={`flex h-20 w-full items-center justify-center gap-3 rounded-3xl text-2xl font-bold text-white shadow-2xl active:scale-[0.99] disabled:opacity-50 ${action.color}`}
        >
          <Check size={28} />
          <span>{action.label}</span>
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

function IdlePanel({ name }: { name: string }) {
  return (
    <div className="rounded-3xl border border-zinc-800 bg-zinc-950/60 p-8 text-center">
      <div className="text-3xl">🛌</div>
      <div className="mt-2 text-xl font-semibold text-zinc-100">All clear, {name}</div>
      <div className="mt-1 text-sm text-zinc-500">No trips scheduled. Mark will dispatch when needed.</div>
    </div>
  );
}

function UpcomingList({ trips }: { trips: Trip[] }) {
  if (!trips.length) return null;
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3">
      <div className="mb-2 px-1 text-xs uppercase tracking-wider text-zinc-500">Later today</div>
      <ul className="space-y-1.5">
        {trips.map((t) => (
          <li key={t.id} className="flex items-center justify-between rounded-xl bg-zinc-900/60 px-3 py-2 text-sm">
            <div>
              <div className="font-medium text-zinc-100">{t.passenger_name}</div>
              {t.pickup_address && <div className="text-xs text-zinc-500">{t.pickup_address.split(",")[0]}</div>}
            </div>
            <div className="text-xs text-zinc-400">{shortTime(t.scheduled_at)}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}
