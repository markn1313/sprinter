"use client";

import { EtaData } from "./useEta";
import { Clock, Navigation, Flag, MapPin } from "lucide-react";

interface Props {
  eta: EtaData | null;
  label?: string;
  variant?: "compact" | "hero" | "dual";
}

const KIND_ICON: Record<string, typeof Flag> = {
  pickup: MapPin,
  stop: MapPin,
  dropoff: Flag,
};

export default function EtaBadge({ eta, label = "ETA", variant = "compact" }: Props) {
  if (!eta) {
    return (
      <div className="inline-flex items-center gap-2 rounded-xl bg-zinc-900/80 px-3 py-2 text-xs text-zinc-500">
        <Clock size={12} className="animate-pulse" /> Calculating ETA…
      </div>
    );
  }

  // Dual variant: shows next stop AND final destination
  if (variant === "dual" && (eta.to_next || eta.to_final)) {
    const next = eta.to_next;
    const final = eta.to_final;
    const showSeparate = next && final && next.label !== final.label;
    return (
      <div className="inline-flex flex-col gap-1.5 rounded-2xl border border-emerald-900/60 bg-gradient-to-br from-emerald-950/80 to-zinc-950/90 px-4 py-3 backdrop-blur shadow-xl">
        {next && (
          <Row icon={KIND_ICON[next.kind] ?? Navigation} label={next.kind === "stop" ? "Next stop" : next.kind === "pickup" ? "Pickup" : "Dropoff"} mins={next.eta_minutes} miles={next.distance_miles} primary />
        )}
        {showSeparate && final && (
          <Row icon={Flag} label="Final" mins={final.eta_minutes} miles={final.distance_miles} />
        )}
        {!eta.traffic_aware && <div className="text-[9px] text-zinc-500">· no live traffic</div>}
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
          {minutes ?? "—"} min
        </div>
        <div className={`text-zinc-400 ${isHero ? "text-xs" : "text-[10px]"}`}>
          {label} · {eta.distance_miles ?? "—"} mi
          {!eta.traffic_aware && <span className="ml-1 text-zinc-600">· no traffic</span>}
        </div>
      </div>
    </div>
  );
}

function Row({ icon: Icon, label, mins, miles, primary }: { icon: typeof Flag; label: string; mins: number; miles: number; primary?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <Icon size={primary ? 18 : 14} className={primary ? "text-emerald-400" : "text-blue-400"} />
      <div className="leading-tight">
        <div className={`font-mono font-semibold tabular-nums ${primary ? "text-2xl text-emerald-300" : "text-base text-blue-300"}`}>
          {mins} min
        </div>
        <div className="text-[10px] text-zinc-500">
          {label} · {miles} mi
        </div>
      </div>
    </div>
  );
}
