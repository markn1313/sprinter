"use client";

import { useEffect, useState } from "react";
import { VanPosition } from "@/lib/types";
import { api } from "@/lib/api-client";
import { useRealtime } from "@/components/useRealtime";

type PosWithSource = VanPosition & { source?: "bouncie" | "bouncie_cached" | "mock" };

// LocalStorage cache so reloads (and the TV display in particular) don't sit
// blank for 6 seconds before the first /api/position poll returns. Stale by
// a few seconds is ALWAYS better than "no current location" on a screen that
// is physically inside the van — Bouncie's last reading is the truth.
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

export function usePosition(token: string, intervalMs = 8000) {
  const [pos, setPos] = useState<PosWithSource | null>(() => readCache());
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const data = await api<PosWithSource>(token, "/api/position");
      setPos(data);
      writeCache(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, intervalMs]);

  // Push fresh position to every connected client whenever Bouncie writes a
  // new row to van_position. Bypasses the 6–8s polling cadence.
  useRealtime({ table: "van_position", onChange: refresh });

  return { pos, error };
}
