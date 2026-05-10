"use client";

import { useEffect, useState } from "react";
import { VanPosition } from "@/lib/types";
import { api } from "@/lib/api-client";

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

export function usePosition(token: string, intervalMs = 8000) {
  const [pos, setPos] = useState<PosWithSource | null>(() => readCache());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let last: PosWithSource | null = readCache();

    const tick = async () => {
      if (cancelled) return;
      try {
        const data = await api<PosWithSource>(token, "/api/position");
        if (cancelled) return;
        // Suppress the state update if the new reading is essentially the
        // same as the last one — keeps the map marker still instead of
        // ping-ponging on tiny GPS jitter.
        const same =
          last &&
          near(data.lat, last.lat) &&
          near(data.lng, last.lng) &&
          data.fuel_pct === last.fuel_pct &&
          Math.abs((data.speed_mph ?? 0) - (last.speed_mph ?? 0)) < 1;
        if (!same) {
          setPos(data);
          writeCache(data);
          last = data;
        }
        setError(null);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      } finally {
        if (!cancelled) timer = setTimeout(tick, intervalMs);
      }
    };

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, intervalMs]);

  // Note: previously this hook also subscribed to van_position realtime, but
  // that triggered a feedback loop — every /api/position write to the cache
  // table fired a CDC event that triggered another /api/position fetch, and
  // GPS noise made the marker ping-pong. Polling alone is fine here.

  return { pos, error };
}
