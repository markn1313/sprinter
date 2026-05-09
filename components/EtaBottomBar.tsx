"use client";

import { EtaData } from "./useEta";
import { Clock, Flag, MapPin, Navigation } from "lucide-react";

interface Props {
  eta: EtaData | null;
}

export default function EtaBottomBar({ eta }: Props) {
  if (!eta) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950/85 px-4 py-3 backdrop-blur shadow-2xl">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <Clock size={12} className="animate-pulse" /> Calculating route…
        </div>
      </div>
    );
  }

  const next = eta.to_next;
  const final = eta.to_final;
  const showFinal = final && next && final.label !== next.label;

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/90 backdrop-blur shadow-2xl divide-y divide-zinc-900">
      {next && (
        <Row
          icon={next.kind === "dropoff" ? Flag : MapPin}
          color={next.kind === "dropoff" ? "text-blue-400" : "text-amber-400"}
          accent={next.kind === "dropoff" ? "text-blue-300" : "text-emerald-300"}
          kindLabel={next.kind === "stop" ? "Next stop" : next.kind === "pickup" ? "Pickup" : "Final"}
          location={next.label}
          mins={next.eta_minutes}
          miles={next.distance_miles}
          primary
        />
      )}
      {showFinal && final && (
        <Row
          icon={Flag}
          color="text-blue-400"
          accent="text-blue-300"
          kindLabel="Final destination"
          location={final.label}
          mins={final.eta_minutes}
          miles={final.distance_miles}
        />
      )}
      {!eta.traffic_aware && (
        <div className="px-4 py-1.5 text-[10px] text-zinc-600">no live traffic</div>
      )}
    </div>
  );
}

function Row({
  icon: Icon,
  color,
  accent,
  kindLabel,
  location,
  mins,
  miles,
  primary,
}: {
  icon: typeof Flag;
  color: string;
  accent: string;
  kindLabel: string;
  location: string;
  mins: number;
  miles: number;
  primary?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <Icon size={primary ? 18 : 16} className={color} />
      <div className="min-w-0 flex-1">
        <div className={`text-[10px] uppercase tracking-wider ${color}`}>{kindLabel}</div>
        <div className="truncate text-sm text-zinc-100">{location.split(",")[0]}</div>
      </div>
      <div className="flex items-baseline gap-1.5 whitespace-nowrap">
        <span className={`font-mono font-bold tabular-nums ${primary ? "text-2xl" : "text-xl"} ${accent}`}>
          {mins}
        </span>
        <span className="text-xs font-semibold text-zinc-500">min</span>
        <span className="ml-2 font-mono text-xs tabular-nums text-zinc-400">{miles} mi</span>
      </div>
    </div>
  );
}
