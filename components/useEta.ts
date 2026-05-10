"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { useRealtime } from "@/components/useRealtime";

export type CongestionLevel = "low" | "moderate" | "heavy" | "severe" | "unknown";

export interface EtaLeg {
  kind: "pickup" | "stop" | "dropoff";
  label: string;
  eta_seconds: number;
  eta_minutes: number;
  distance_miles: number;
  polyline: string;
  congestion?: CongestionLevel[] | null;
  traffic_aware: boolean;
}

export interface ManeuverInfo {
  step: {
    instruction: string;
    type: string;
    modifier?: string;
    distance_m: number;
    duration_s: number;
    location: [number, number];
    street_name?: string;
  };
  meters_to: number;
}

export interface EtaData {
  eta_seconds: number | null;
  eta_minutes: number | null;
  distance_miles: number | null;
  polyline: string | null;
  congestion?: CongestionLevel[] | null;
  van: {
    lat: number;
    lng: number;
    heading: number;
    speed_mph: number;
    source: "bouncie" | "bouncie_cached" | "mock";
  };
  to_next?: EtaLeg | null;
  to_final?: EtaLeg | null;
  next_maneuver?: ManeuverInfo | null;
  traffic_aware: boolean;
}

export function useEta(token: string, tripId: string | null, intervalMs = 30_000) {
  const [eta, setEta] = useState<EtaData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!tripId) {
      setEta(null);
      return;
    }
    setLoading(true);
    try {
      const data = await api<EtaData>(token, `/api/eta?trip=${tripId}`);
      setEta(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [token, tripId]);

  useEffect(() => {
    if (!tripId) {
      setEta(null);
      return;
    }
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
  }, [refresh, tripId, intervalMs]);

  // Realtime: any driver_location change → recompute ETA.
  useRealtime({ table: "driver_location", onChange: refresh, enabled: !!tripId });
  // Trip rows (status / stops) changing also affect ETA.
  useRealtime({
    table: "trips",
    filter: tripId ? `id=eq.${tripId}` : undefined,
    onChange: refresh,
    enabled: !!tripId,
  });

  return { eta, loading, error };
}
