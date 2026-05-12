"use client";

import { Fuel, ExternalLink } from "lucide-react";

interface Props {
  fuelPct: number | null;
  vanLat: number | null;
  vanLng: number | null;
  // Range in miles from /api/range (rolling actual MPG). When null we
  // fall back to a coarse static estimate to keep the card render-safe.
  rangeMi?: number | null;
}

// When the tank is below 25% and there's no active trip, prominently surface
// a refuel alert with a one-tap Maps deep-link that opens 'gas stations near
// me' centered at the van. The Sprinter holds ~24 gal, so 25% = ~6 gal = 100
// mi range — comfortable runway to find a station before the warning light.
//
// Hidden when fuel is unknown (Bouncie hasn't reported yet) or above the
// threshold. Hides itself when above the threshold so it doesn't take up
// real estate when not needed.
const LOW_THRESHOLD = 0.25;

export default function FuelAlertCard({ fuelPct, vanLat, vanLng, rangeMi: rangeProp }: Props) {
  if (fuelPct == null || fuelPct >= LOW_THRESHOLD) return null;
  const pct = Math.round(fuelPct * 100);
  const tone = pct < 10 ? "red" : pct < 18 ? "amber" : "amber";
  const palette = tone === "red"
    ? { ring: "border-red-700/70", text: "text-red-300", icon: "text-red-400", bar: "bg-red-500" }
    : { ring: "border-amber-700/60", text: "text-amber-300", icon: "text-amber-400", bar: "bg-amber-400" };

  // Prefer the rolling-MPG range from /api/range. Coarse fallback uses
  // 24.5 gal × pct × 22 mpg if the prop isn't wired yet.
  const rangeMi = rangeProp ?? Math.round(24.5 * fuelPct * 22);

  // Maps deep link: search 'gas stations' centered at the van. Works on iOS
  // (handed off to Apple Maps if Google Maps not installed) and Android.
  const mapsUrl =
    vanLat != null && vanLng != null
      ? `https://www.google.com/maps/search/gas+stations/@${vanLat},${vanLng},14z`
      : "https://www.google.com/maps/search/gas+stations";

  return (
    <div className={`rounded-2xl border ${palette.ring} bg-zinc-950/95 p-4 backdrop-blur shadow-xl`}>
      <div className={`flex items-center gap-1.5 text-xs uppercase tracking-wider ${palette.text}`}>
        <Fuel size={12} className={palette.icon} />
        Low fuel
      </div>
      <div className="mt-2 flex items-baseline justify-between">
        <div className={`font-mono text-2xl font-bold tabular-nums ${palette.text}`}>{pct}%</div>
        <div className="text-xs text-zinc-400">~{rangeMi} mi range</div>
      </div>
      {/* Visual fuel bar */}
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <div
          className={`h-full ${palette.bar} transition-all`}
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>
      <a
        href={mapsUrl}
        target="_blank"
        rel="noreferrer"
        className={`mt-3 flex items-center justify-center gap-1.5 rounded-xl py-2.5 text-sm font-semibold ${
          tone === "red" ? "bg-red-600 text-white hover:bg-red-500" : "bg-amber-500 text-zinc-950 hover:bg-amber-400"
        }`}
      >
        <ExternalLink size={14} /> Find gas
      </a>
    </div>
  );
}
