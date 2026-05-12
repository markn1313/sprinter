"use client";

import { Flag, MapPin as PinIcon } from "lucide-react";
import { stripZip } from "@/lib/format";

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

// Shared bottom-strip card used on TV and Mark home. Address fills the
// left of the row, distance/time/arrival hug the right. The TV uses the
// large size; Mark home opts in to `compact` so the same component lays
// out cleanly on a phone-width screen.
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
  const sizes = compact
    ? {
        pad: "px-3 py-1.5",
        gap: "gap-4",
        labelText: "text-[9px]",
        addr: "text-base",
        statLabel: "text-[10px]",
        statNum: "text-lg",
        statUnit: "text-[10px]",
        iconSize: 12,
        arrival: "text-lg",
      }
    : {
        pad: "px-5 py-2.5",
        gap: "gap-8",
        labelText: "text-xs",
        addr: "text-2xl",
        statLabel: "text-sm",
        statNum: "text-4xl",
        statUnit: "text-base",
        iconSize: 16,
        arrival: "text-4xl",
      };
  return (
    <div
      className={`rounded-2xl border ${sizes.pad} shadow-2xl ${
        primary ? "border-emerald-700/60 bg-zinc-950" : "border-blue-700/60 bg-zinc-950"
      }`}
    >
      <div className={`grid grid-cols-[1fr_auto_auto_auto] ${sizes.gap} items-center`}>
        <div className="min-w-0">
          {/* Label row: hidden in compact mode to save vertical real-estate
              on the Mark home bottom banner (Mark explicitly asked: drop
              the flag icon + the word "Final" so the strip can be shorter).
              TV's large variant still shows the icon + label since it has
              headroom and benefits from the visual anchor. */}
          {!compact && (
            <div className="flex items-center gap-1.5">
              <Icon size={sizes.iconSize} className={primary ? "text-emerald-400" : "text-blue-400"} />
              <span className={`${sizes.labelText} uppercase tracking-widest ${primary ? "text-emerald-300" : "text-blue-300"}`}>
                {titleOverride ?? (kind === "pickup" ? "Pickup" : kind === "stop" ? "Next stop" : "Final destination")}
              </span>
            </div>
          )}
          <div className={`${compact ? "" : "mt-0.5"} truncate ${sizes.addr} font-semibold text-zinc-100 leading-tight`}>
            {stripZip(label)}
          </div>
        </div>
        <div>
          <div className={`${sizes.statLabel} uppercase tracking-widest text-zinc-400 leading-none`}>Distance</div>
          <div className="mt-0.5 flex items-baseline gap-1">
            <span className={`font-mono ${sizes.statNum} font-bold tabular-nums leading-none text-zinc-100`}>{miles}</span>
            <span className={`${sizes.statUnit} text-zinc-400`}>mi</span>
          </div>
        </div>
        <div>
          <div className={`${sizes.statLabel} uppercase tracking-widest text-zinc-400 leading-none`}>Time</div>
          <div className="mt-0.5 flex items-baseline gap-1">
            <span className={`font-mono ${sizes.statNum} font-bold tabular-nums leading-none ${primary ? "text-emerald-300" : "text-blue-300"}`}>{minutes}</span>
            <span className={`${sizes.statUnit} text-zinc-400`}>min</span>
          </div>
        </div>
        <div className="text-right">
          <div className={`${sizes.statLabel} uppercase tracking-widest text-zinc-400 leading-none`}>Arrival</div>
          <div className={`mt-0.5 font-mono ${sizes.arrival} font-bold tabular-nums leading-none text-zinc-100`}>{arrival}</div>
        </div>
      </div>
    </div>
  );
}
