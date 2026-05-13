"use client";

import { useEffect, useRef, useState } from "react";
import { Flag, MapPin as PinIcon } from "lucide-react";
import { stripZip, compactAddr, compactAddrNoCity } from "@/lib/format";

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
          <AddressLine label={label} compact={compact} addrClass={sizes.addr} />
        </div>
        {/* Compact mode skips the DISTANCE / TIME / ARRIVAL header row
            on each stat — the units (mi / min / PM) already tell you
            what each number is, so the headers were pure overhead. This
            also shrinks each column from "DISTANCE" width to the number
            width, freeing horizontal room for the address. */}
        <div>
          {!compact && (
            <div className={`${sizes.statLabel} uppercase tracking-widest text-zinc-400 leading-none`}>Distance</div>
          )}
          <div className={`${compact ? "" : "mt-0.5"} flex items-baseline gap-1`}>
            <span className={`font-mono ${sizes.statNum} font-bold tabular-nums leading-none text-zinc-100`}>{miles}</span>
            <span className={`${sizes.statUnit} text-zinc-400`}>mi</span>
          </div>
        </div>
        <div>
          {!compact && (
            <div className={`${sizes.statLabel} uppercase tracking-widest text-zinc-400 leading-none`}>Time</div>
          )}
          <div className={`${compact ? "" : "mt-0.5"} flex items-baseline gap-1`}>
            <span className={`font-mono ${sizes.statNum} font-bold tabular-nums leading-none ${primary ? "text-emerald-300" : "text-blue-300"}`}>{minutes}</span>
            <span className={`${sizes.statUnit} text-zinc-400`}>min</span>
          </div>
        </div>
        <div className="text-right">
          {!compact && (
            <div className={`${sizes.statLabel} uppercase tracking-widest text-zinc-400 leading-none`}>Arrival</div>
          )}
          <div className={`${compact ? "" : "mt-0.5"} font-mono ${sizes.arrival} font-bold tabular-nums leading-none text-zinc-100`}>{arrival}</div>
        </div>
      </div>
    </div>
  );
}

// Address renderer with a 2-stage fallback for the compact banner:
//   1) compactAddr — street-type abbreviations + drop state/country
//   2) if even that overflows the container, drop the city too
// TV's large variant still uses stripZip + truncate since it has the
// horizontal room and shouldn't lose city context.
function AddressLine({
  label,
  compact,
  addrClass,
}: {
  label: string;
  compact: boolean;
  addrClass: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  // Start at level 0 (compactAddr); bump to 1 (no city) if the text
  // would overflow its single-line container. Reset whenever the label
  // changes so a shorter address re-tries level 0.
  const [level, setLevel] = useState(0);
  useEffect(() => {
    setLevel(0);
  }, [label, compact]);
  useEffect(() => {
    if (!compact) return;
    const el = ref.current;
    if (!el) return;
    // scrollWidth > clientWidth means the text is being clipped/truncated.
    // Bump to the no-city form. We only escalate once — if even that
    // overflows the existing `truncate` ellipsis handles the rest.
    if (level === 0 && el.scrollWidth > el.clientWidth + 1) {
      setLevel(1);
    }
  });

  const displayed = !compact
    ? stripZip(label)
    : level === 0
      ? compactAddr(label)
      : compactAddrNoCity(label);
  return (
    <div
      ref={ref}
      className={`${compact ? "" : "mt-0.5"} truncate ${addrClass} font-semibold text-zinc-100 leading-tight`}
    >
      {displayed}
    </div>
  );
}
