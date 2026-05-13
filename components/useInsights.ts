"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";

export interface InsightStats {
  miles: number;
  driving_minutes: number;
  idle_minutes: number;
  avg_speed_mph: number;
  fuel_cost_dollars: number;
  // Per-window diesel rate applied to fuel_cost. Latest EIA value
  // for the 24h window; average over the window for 7d / 30d.
  fuel_price_per_gal: number;
}

export interface DestEntry {
  address: string;
  lat: number | null;
  lng: number | null;
  count: number;
  last: string;
}

export interface InsightsData {
  today: InsightStats;
  week: InsightStats;
  month: InsightStats;
  top_destinations: DestEntry[];
  fuel?: {
    price_per_gal: number;
    source: "eia" | "fallback" | "cache_stale" | "manual";
    effective_date: string | null;
  };
}

export function useInsights(token: string, intervalMs = 60_000) {
  const [data, setData] = useState<InsightsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api<InsightsData>(token, "/api/insights");
      setData(r);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      await refresh();
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refresh, intervalMs]);

  return { data, error, refresh };
}
