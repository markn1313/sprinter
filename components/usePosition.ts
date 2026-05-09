"use client";

import { useEffect, useState } from "react";
import { VanPosition } from "@/lib/types";
import { api } from "@/lib/api-client";

export function usePosition(token: string, intervalMs = 8000) {
  const [pos, setPos] = useState<(VanPosition & { source?: "bouncie" | "mock" }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const data = await api<VanPosition & { source: "bouncie" | "mock" }>(token, "/api/position");
        if (!cancelled) setPos(data);
        if (!cancelled) setError(null);
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
  }, [token, intervalMs]);

  return { pos, error };
}
