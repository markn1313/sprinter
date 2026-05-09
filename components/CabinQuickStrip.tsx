"use client";

import { useState } from "react";
import { postJson } from "@/lib/api-client";
import {
  ThermometerSnowflake,
  ThermometerSun,
  Wind,
  Check,
} from "lucide-react";

interface Props {
  token: string;
  tripId?: string | null;
}

const CHIPS = [
  { kind: "cooler", icon: ThermometerSnowflake, color: "text-sky-300", bg: "bg-sky-900/40", label: "Cooler" },
  { kind: "warmer", icon: ThermometerSun, color: "text-orange-300", bg: "bg-orange-900/40", label: "Warmer" },
  { kind: "fan_up", icon: Wind, color: "text-emerald-300", bg: "bg-emerald-900/40", label: "Fan +" },
  { kind: "fan_down", icon: Wind, color: "text-zinc-300", bg: "bg-zinc-800/80", label: "Fan −" },
] as const;

// Compact cabin-control pill row that overlays the main map. Tap a chip →
// sends a cabin_request that the driver app surfaces as a toast.
export default function CabinQuickStrip({ token, tripId }: Props) {
  const [recent, setRecent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (kind: string) => {
    setBusy(true);
    try {
      await postJson(token, "/api/cabin-requests", { kind, trip_id: tripId ?? null });
      setRecent(kind);
      setTimeout(() => setRecent(null), 1600);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5 rounded-2xl border border-zinc-800 bg-zinc-950/85 p-1.5 backdrop-blur shadow-2xl">
      {CHIPS.map((c) => {
        const Icon = c.icon;
        const just = recent === c.kind;
        const flipFan = c.kind === "fan_down";
        return (
          <button
            key={c.kind}
            onClick={() => send(c.kind)}
            disabled={busy}
            title={c.label}
            className={`flex h-10 w-10 items-center justify-center rounded-xl transition active:scale-95 disabled:opacity-50 ${
              just ? "bg-emerald-600 text-white" : `${c.bg} ${c.color} hover:bg-zinc-800`
            }`}
          >
            {just ? (
              <Check size={16} />
            ) : (
              <Icon size={18} className={flipFan ? "rotate-180" : ""} />
            )}
          </button>
        );
      })}
    </div>
  );
}
