"use client";

import { useState } from "react";
import { postJson } from "@/lib/api-client";

interface Props {
  token: string;
  tripId?: string | null;
}

const CHIPS = [
  { kind: "cooler", label: "Cooler" },
  { kind: "warmer", label: "Warmer" },
  { kind: "fan_up", label: "Fan +" },
  { kind: "fan_down", label: "Fan −" },
] as const;

// Compact cabin-control row that overlays the main map. Tap a chip → fires a
// cabin_request that the driver app surfaces as a toast.
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
        const just = recent === c.kind;
        return (
          <button
            key={c.kind}
            onClick={() => send(c.kind)}
            disabled={busy}
            className={`rounded-xl px-3 py-2 text-xs font-semibold transition active:scale-95 disabled:opacity-50 ${
              just ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-100 hover:bg-zinc-700"
            }`}
          >
            {just ? "Sent" : c.label}
          </button>
        );
      })}
    </div>
  );
}
