"use client";

import { EtaData } from "./useEta";
import { Clock, Navigation, AlertCircle } from "lucide-react";

interface Props {
  eta: EtaData | null;
  label?: string;
  variant?: "compact" | "hero";
}

export default function EtaBadge({ eta, label = "ETA", variant = "compact" }: Props) {
  if (!eta) {
    return (
      <div className="inline-flex items-center gap-2 rounded-xl bg-zinc-900/80 px-3 py-2 text-xs text-zinc-500">
        <Clock size={12} className="animate-pulse" /> Calculating ETA…
      </div>
    );
  }
  const minutes = eta.eta_minutes;
  const isHero = variant === "hero";
  return (
    <div
      className={`inline-flex items-center gap-3 rounded-2xl bg-gradient-to-br from-emerald-900/60 to-zinc-950/80 backdrop-blur ${isHero ? "px-5 py-3" : "px-3 py-2"}`}
    >
      <Navigation size={isHero ? 18 : 14} className="text-emerald-400" />
      <div className="leading-tight">
        <div className={`font-mono font-semibold tabular-nums text-emerald-300 ${isHero ? "text-3xl" : "text-base"}`}>
          {minutes} min
        </div>
        <div className={`text-zinc-400 ${isHero ? "text-xs" : "text-[10px]"}`}>
          {label} · {eta.distance_miles} mi
          {!eta.traffic_aware && <span className="ml-1 text-zinc-600">· no traffic</span>}
        </div>
      </div>
    </div>
  );
}
