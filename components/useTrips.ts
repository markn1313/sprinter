"use client";

import { useEffect, useState, useCallback } from "react";
import { Trip } from "@/lib/types";
import { api } from "@/lib/api-client";

export function useTrips(token: string, intervalMs = 5000) {
  const [trips, setTrips] = useState<Trip[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ trips: Trip[] }>(token, "/api/trips");
      setTrips(data.trips || []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
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

  return { trips, loading, error, refresh };
}

export function activeTrip(trips: Trip[]): Trip | null {
  const live = trips.find(
    (t) =>
      t.status === "dispatched" ||
      t.status === "at_pickup" ||
      t.status === "onboard" ||
      t.status === "at_dropoff",
  );
  return live ?? null;
}
