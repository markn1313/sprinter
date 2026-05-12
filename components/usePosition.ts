"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { VanPosition } from "@/lib/types";
import { api } from "@/lib/api-client";
import { useRealtime } from "@/components/useRealtime";

type PosWithSource = VanPosition & { source?: "bouncie" | "bouncie_cached" | "mock" };

// LocalStorage cache so reloads (and the TV display in particular) don't sit
// blank before the first /api/position poll returns. Stale by a few seconds is
// always better than "no current location" on a screen that's physically
// inside the van.
const CACHE_KEY = "sprinter:last-position";

function readCache(): PosWithSource | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PosWithSource;
  } catch {
    return null;
  }
}

function writeCache(p: PosWithSource): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(p));
  } catch {
    // ignore
  }
}

// Round to ~5m precision so identical-with-GPS-noise readings don't trigger
// re-renders that re-fit the map and jitter the marker.
function near(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return a == b;
  return Math.abs(a - b) < 0.00005; // ~5.5m of latitude
}

// Minimum gap between refetches triggered by realtime CDC. The Bouncie webhook
// can fire 10+ samples per second on busy roads; without this, every event
// re-hits /api/position which writes to van_position which... fires another
// CDC event. The /api/position write side is also idempotent now (skip when
// nothing changed), but the throttle here is belt-and-suspenders.
const MIN_REFETCH_MS = 2000;

export function usePosition(token: string, intervalMs = 20_000) {
  const [pos, setPos] = useState<PosWithSource | null>(() => readCache());
  const [error, setError] = useState<string | null>(null);
  const lastFetchAtRef = useRef<number>(0);
  const inflightRef = useRef<Promise<void> | null>(null);
  const lastRef = useRef<PosWithSource | null>(readCache());

  const fetchNow = useCallback(async () => {
    if (inflightRef.current) return inflightRef.current;
    const now = Date.now();
    if (now - lastFetchAtRef.current < MIN_REFETCH_MS) return;
    lastFetchAtRef.current = now;
    const p = (async () => {
      try {
        const data = await api<PosWithSource>(token, "/api/position");
        const last = lastRef.current;
        const same =
          last &&
          near(data.lat, last.lat) &&
          near(data.lng, last.lng) &&
          data.fuel_pct === last.fuel_pct &&
          Math.abs((data.speed_mph ?? 0) - (last.speed_mph ?? 0)) < 1;
        if (!same) {
          setPos(data);
          writeCache(data);
          lastRef.current = data;
        }
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        inflightRef.current = null;
      }
    })();
    inflightRef.current = p;
    return p;
  }, [token]);

  // Long-interval poll as a safety net. The bulk of the freshness comes from
  // realtime subscriptions below; polling only fires when subscriptions are
  // disconnected (PWA backgrounded on iOS, network blip, etc.).
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      await fetchNow();
      if (!cancelled) timer = setTimeout(tick, intervalMs);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [fetchNow, intervalMs]);

  // Realtime: refetch when ANY of the three position-relevant tables change.
  // Each subscription is independent and uses its own channel (per useRealtime
  // contract). The MIN_REFETCH_MS throttle and the /api/position idempotent
  // write together prevent the feedback loop the old comment in this file
  // warned about.
  useRealtime({ table: "van_position", onChange: fetchNow });
  useRealtime({ table: "mark_location", onChange: fetchNow });
  useRealtime({ table: "driver_location", onChange: fetchNow });

  return { pos, error };
}
