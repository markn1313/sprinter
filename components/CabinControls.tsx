"use client";

import { useState } from "react";
import { postJson } from "@/lib/api-client";
import { ThermometerSnowflake, ThermometerSun, Wind, Music, VolumeX, Toilet } from "lucide-react";

const REQUESTS = [
  { kind: "cooler", label: "Cooler", icon: ThermometerSnowflake, color: "text-sky-400" },
  { kind: "warmer", label: "Warmer", icon: ThermometerSun, color: "text-orange-400" },
  { kind: "fan_up", label: "Fan ↑", icon: Wind, color: "text-emerald-400" },
  { kind: "fan_down", label: "Fan ↓", icon: Wind, color: "text-zinc-400" },
  { kind: "music", label: "Music", icon: Music, color: "text-pink-400" },
  { kind: "quiet", label: "Quiet", icon: VolumeX, color: "text-violet-400" },
  { kind: "restroom", label: "Restroom", icon: Toilet, color: "text-amber-400" },
] as const;

interface Props {
  token: string;
  tripId: string | null;
}

export default function CabinControls({ token, tripId }: Props) {
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState<string | null>(null);

  const send = async (kind: string) => {
    setBusy(true);
    try {
      await postJson(token, "/api/cabin-requests", { kind, trip_id: tripId });
      setRecent(kind);
      setTimeout(() => setRecent(null), 1800);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4">
      <div className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Cabin requests</div>
      <div className="grid grid-cols-4 gap-2">
        {REQUESTS.map((r) => {
          const Icon = r.icon;
          const just = recent === r.kind;
          return (
            <button
              key={r.kind}
              onClick={() => send(r.kind)}
              disabled={busy}
              className={`flex flex-col items-center gap-1 rounded-xl border border-zinc-800 px-2 py-3 transition disabled:opacity-50 ${
                just ? "bg-emerald-700 text-white" : "bg-zinc-900 hover:bg-zinc-800"
              }`}
            >
              <Icon size={20} className={just ? "text-white" : r.color} />
              <span className={`text-xs ${just ? "text-white" : "text-zinc-300"}`}>
                {just ? "Sent" : r.label}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-2 text-[11px] text-zinc-500">Your driver sees these as toasts and adjusts.</div>
    </div>
  );
}
