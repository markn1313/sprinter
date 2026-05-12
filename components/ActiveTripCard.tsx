"use client";

import { useEffect, useState } from "react";
import { Trip, Role } from "@/lib/types";
import { postJson } from "@/lib/api-client";
import { dollars, durationMinutes, statusLabel, statusColor, stripZip } from "@/lib/format";
import { Check, MapPin, User, Clock } from "lucide-react";

interface Props {
  token: string;
  role: Role;
  trip: Trip;
  hourlyRateCents?: number;
  onAdvance: () => void;
}

export default function ActiveTripCard({ token, role, trip, hourlyRateCents = 3500, onAdvance }: Props) {
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const minutes =
    trip.dispatched_at && !trip.completed_at
      ? Math.max(0, Math.floor((now - new Date(trip.dispatched_at).getTime()) / 60_000))
      : trip.actual_minutes ?? 0;

  const liveCost = trip.driver_pay_cents ?? Math.round((minutes / 60) * hourlyRateCents);

  const showMoney = role === "mark";

  const advance = async (action: string) => {
    setBusy(true);
    try {
      await postJson(token, `/api/trips/${trip.id}/action`, { action });
      onAdvance();
    } finally {
      setBusy(false);
    }
  };

  const nextActions = (() => {
    switch (trip.status) {
      case "scheduled":
        return [{ label: "Dispatch", action: "dispatch", color: "bg-blue-600 hover:bg-blue-500" }];
      case "dispatched":
        return [{ label: "At pickup", action: "at_pickup", color: "bg-amber-600 hover:bg-amber-500" }];
      case "at_pickup":
        return [{ label: "Onboard", action: "onboard", color: "bg-emerald-600 hover:bg-emerald-500" }];
      case "onboard":
        return [{ label: "At dropoff", action: "at_dropoff", color: "bg-amber-600 hover:bg-amber-500" }];
      case "at_dropoff":
        return [{ label: "Trip complete", action: "complete", color: "bg-emerald-600 hover:bg-emerald-500" }];
      default:
        return [];
    }
  })();

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4 backdrop-blur">
      <div className="flex items-center justify-between">
        <div className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium text-white ${statusColor(trip.status)}`}>
          {statusLabel(trip.status)}
        </div>
        {showMoney && (
          <div className="text-right">
            <div className="text-xs text-zinc-500">Trip running</div>
            <div className="text-lg font-mono font-semibold text-emerald-400 tabular-nums">
              {dollars(liveCost)}
            </div>
          </div>
        )}
      </div>
      <div className="mt-3 grid gap-2">
        <div className="flex items-center gap-2 text-zinc-200">
          <User size={14} className="text-zinc-500" />
          <span className="text-sm font-medium">{trip.passenger_name}</span>
        </div>
        {trip.pickup_address && (
          <div className="flex items-center gap-2 text-zinc-300">
            <MapPin size={14} className="text-amber-500" />
            <span className="text-sm">From {stripZip(trip.pickup_address)}</span>
          </div>
        )}
        {trip.dropoff_address && (
          <div className="flex items-center gap-2 text-zinc-300">
            <MapPin size={14} className="text-blue-500" />
            <span className="text-sm">To {stripZip(trip.dropoff_address)}</span>
          </div>
        )}
        <div className="flex items-center gap-2 text-zinc-400">
          <Clock size={14} />
          <span className="text-sm">
            {trip.dispatched_at
              ? `${minutes} min in trip`
              : `Scheduled ${new Date(trip.scheduled_at).toLocaleTimeString("en-US", {
                  hour: "numeric",
                  minute: "2-digit",
                  timeZone: "America/Los_Angeles",
                })}`}
          </span>
        </div>
      </div>
      {nextActions.length > 0 && (
        <div className="mt-4 grid grid-cols-1 gap-2">
          {nextActions.map((a) => (
            <button
              key={a.action}
              onClick={() => advance(a.action)}
              disabled={busy}
              className={`flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-white transition disabled:opacity-50 ${a.color}`}
            >
              <Check size={16} /> {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
