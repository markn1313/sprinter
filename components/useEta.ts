"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";

export interface EtaData {
  eta_seconds: number;
  eta_minutes: number;
  distance_meters: number;
  distance_miles: number;
  polyline: string;
  van: {
    lat: number;
    lng: number;
    heading: number;
    speed_mph: number;
    source: "bouncie" | "mock";
  };
  target: { lat: number; lng: number };
  traffic_aware: boolean;
}

export function useEta(token: string, tripId: string | null, intervalMs = 25_000) {
  const [eta, setEta] = useState<EtaData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tripId) {
      setEta(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      setLoading(true);
      try {
        const data = await api<EtaData>(token, `/api/eta?trip=${tripId}`);
        if (!cancelled) {
          setEta(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(tick, intervalMs);
        }
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [token, tripId, intervalMs]);

  return { eta, loading, error };
}
