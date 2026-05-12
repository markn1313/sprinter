"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

// ETA recomputation hits Mapbox's Directions API (server-side, via /api/eta).
// We don't want to re-call it on every Bouncie/phone position sample — that
// would be every 1-3 seconds. Throttle to 15s; freshness comes from local
// position state, which animates the van marker independently.
const MIN_ETA_REFETCH_MS = 15_000;

export function useEta(token: string, tripId: string | null, intervalMs = 60_000) {
  const [eta, setEta] = useState<EtaData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastFetchAtRef = useRef<number>(0);
  const inflightRef = useRef<Promise<void> | null>(null);

  const refresh = useCallback(async () => {
    if (!tripId) {
      setEta(null);
      return;
    }
    if (inflightRef.current) return inflightRef.current;
    const now = Date.now();
    if (now - lastFetchAtRef.current < MIN_ETA_REFETCH_MS) return;
    lastFetchAtRef.current = now;
    setLoading(true);
    const p = (async () => {
      try {
        const data = await api<EtaData>(token, `/api/eta?trip=${tripId}`);
        setEta(data);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
        inflightRef.current = null;
      }
    })();
    inflightRef.current = p;
    return p;
  }, [token, tripId]);

  // Manual refresh that bypasses the throttle — needed when the route
  // itself changes (status flip, stop edited). Realtime trip-row events
  // call this; van-movement events call the throttled `refresh`.
  const forceRefresh = useCallback(async () => {
    lastFetchAtRef.current = 0;
    await refresh();
  }, [refresh]);

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

  // Realtime: van moves → ETA may have changed. Throttled to 15s by refresh.
  useRealtime({ table: "van_position", onChange: refresh, enabled: !!tripId });
  useRealtime({ table: "driver_location", onChange: refresh, enabled: !!tripId });
  // Trip rows (status / stops) changing also affect ETA. Force refresh so a
  // route edit shows up immediately even if we just refetched 2s ago.
  useRealtime({
    table: "trips",
    filter: tripId ? `id=eq.${tripId}` : undefined,
    onChange: forceRefresh,
    enabled: !!tripId,
  });

  return { eta, loading, error };
}
