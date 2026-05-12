"use client";

import { useEffect, useState } from "react";

export interface RangeData {
  range_miles: number | null;
  gallons_remaining: number | null;
  fuel_pct: number | null;
  mpg: number;
  mpg_source: "bouncie_trips" | "fallback";
  window_miles: number | null;
  window_days: number | null;
  computed_at: string | null;
}

// useRange — polls /api/range to get a rolling-actual-MPG-derived range
// estimate. Refreshes every 60s plus on token change. The endpoint caches
// the underlying MPG computation server-side (30 min TTL) so polling here
// is cheap.
//
// Why polling instead of a one-shot fetch: fuel_pct ticks down as Mark
// drives, so the range needs to update live. The number doesn't change
// quickly enough to need realtime CDC subscriptions — a minute is fine.
export function useRange(token: string | null): RangeData | null {
  const [data, setData] = useState<RangeData | null>(null);
  useEffect(() => {
    if (!token) {
      setData(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/range", {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        });
        if (!r.ok) return;
        const j = (await r.json()) as RangeData;
        if (!cancelled) setData(j);
      } catch {
        // swallow — keep last good value
      }
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [token]);
  return data;
}
