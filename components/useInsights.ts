"use client";

import { useEffect, useState } from "react";
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

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const r = await api<InsightsData>(token, "/api/insights");
        if (!cancelled) {
          setData(r);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) timer = setTimeout(tick, intervalMs);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [token, intervalMs]);

  return { data, error };
}
