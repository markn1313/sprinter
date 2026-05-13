"use client";

import { Flag, MapPin as PinIcon } from "lucide-react";
import { stripZip, compactAddr } from "@/lib/format";

interface Props {
  kind: "pickup" | "stop" | "dropoff";
  label: string;
  minutes: number;
  miles: number;
  primary?: boolean;
  titleOverride?: string;
  // compact = mobile / Mark-home sizing; default (large) = TV.
  compact?: boolean;
}

// Shared bottom-strip card used on TV and Mark home.
//
// Compact (Mark home, phone): two rows stacked.
//   Row 1 = address (full width, with USPS-style abbreviations).
//   Row 2 = distance · time · arrival, right-aligned.
// Two rows give the address its own line and stop fighting the stats for
// horizontal room — addresses now never need to be truncated or have
// their city dropped.
//
// Large (TV): single row, address left, stats right with DISTANCE /
// TIME / ARRIVAL headers above each number. Plenty of width on a TV.
export default function EtaCard({
  kind,
  label,
  minutes,
  miles,
  primary,
  titleOverride,
  compact = false,
}: Props) {
  const Icon = kind === "dropoff" ? Flag : PinIcon;
  const arrival = new Date(Date.now() + minutes * 60_000).toLocaleTimeString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
  });

  if (compact) {
    return (
      <div
        className={`rounded-2xl border px-3 py-2 shadow-2xl ${
          primary ? "border-emerald-700/60 bg-zinc-950" : "border-blue-700/60 bg-zinc-950"
        }`}
      >
        {/* Row 1: address. truncate kept as a safety net for absurdly
            long single-segment addresses but with full row width it
            should essentially never fire. */}
        <div className="truncate text-base font-semibold text-zinc-100 leading-tight">
          {compactAddr(label)}
        </div>
        {/* Row 2: distance · time · arrival. Right-aligned cluster so
            the trio visually anchors with the address baseline. Time
            picks up the primary color when this is the primary card. */}
        <div className="mt-1 flex items-baseline justify-end gap-4">
          <div className="flex items-baseline gap-1">
            <span className="font-mono text-lg font-bold tabular-nums leading-none text-zinc-100">{miles}</span>
            <span className="text-[10px] text-zinc-400">mi</span>
          </div>
          <div className="flex items-baseline gap-1">
            <span className={`font-mono text-lg font-bold tabular-nums leading-none ${primary ? "text-emerald-300" : "text-blue-300"}`}>{minutes}</span>
            <span className="text-[10px] text-zinc-400">min</span>
          </div>
          <span className="font-mono text-lg font-bold tabular-nums leading-none text-zinc-100">{arrival}</span>
        </div>
      </div>
    );
  }

  // Large (TV) — unchanged single-row layout.
  return (
    <div
      className={`rounded-2xl border px-5 py-2.5 shadow-2xl ${
        primary ? "border-emerald-700/60 bg-zinc-950" : "border-blue-700/60 bg-zinc-950"
      }`}
    >
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-8 items-center">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Icon size={16} className={primary ? "text-emerald-400" : "text-blue-400"} />
            <span className={`text-xs uppercase tracking-widest ${primary ? "text-emerald-300" : "text-blue-300"}`}>
              {titleOverride ?? (kind === "pickup" ? "Pickup" : kind === "stop" ? "Next stop" : "Final destination")}
            </span>
          </div>
          <div className="mt-0.5 truncate text-2xl font-semibold text-zinc-100 leading-tight">
            {stripZip(label)}
          </div>
        </div>
        <div>
          <div className="text-sm uppercase tracking-widest text-zinc-400 leading-none">Distance</div>
          <div className="mt-0.5 flex items-baseline gap-1">
            <span className="font-mono text-4xl font-bold tabular-nums leading-none text-zinc-100">{miles}</span>
            <span className="text-base text-zinc-400">mi</span>
          </div>
        </div>
        <div>
          <div className="text-sm uppercase tracking-widest text-zinc-400 leading-none">Time</div>
          <div className="mt-0.5 flex items-baseline gap-1">
            <span className={`font-mono text-4xl font-bold tabular-nums leading-none ${primary ? "text-emerald-300" : "text-blue-300"}`}>{minutes}</span>
            <span className="text-base text-zinc-400">min</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-sm uppercase tracking-widest text-zinc-400 leading-none">Arrival</div>
          <div className="mt-0.5 font-mono text-4xl font-bold tabular-nums leading-none text-zinc-100">{arrival}</div>
        </div>
      </div>
    </div>
  );
}
