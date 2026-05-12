"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";

export interface InsightStats {
  miles: number;
  driving_minutes: number;
  idle_minutes: number;
  avg_speed_mph: number;
  fuel_cost_dollars: number;
  trips_completed: number;
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
  top_destinations: DestEntry[];
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
