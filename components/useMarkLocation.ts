"use client";

import { useEffect, useState } from "react";
import { postJson, api } from "@/lib/api-client";

export interface MarkLocation {
  lat: number;
  lng: number;
  accuracy_m: number | null;
  reported_at: string;
}

// Sends Mark's GPS to the server. Throttled to 3s — frequent enough that
// the server-side fuser in /api/position can prefer phone GPS over
// Bouncie's 15–30s OBD cadence while Mark is in the van.
export function useMarkGpsReporter(token: string, enabled: boolean) {
  const [last, setLast] = useState<MarkLocation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("Geolocation not supported");
      return;
    }
    let lastSent = 0;
    const id = navigator.geolocation.watchPosition(
      async (pos) => {
        const now = Date.now();
        if (now - lastSent < 3_000) return; // throttle
        lastSent = now;
        const payload = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy_m: pos.coords.accuracy,
        };
        try {
          await postJson(token, "/api/mark-location", payload);
          setLast({
            lat: payload.lat,
            lng: payload.lng,
            accuracy_m: payload.accuracy_m,
            reported_at: new Date().toISOString(),
          });
        } catch (err) {
          setError((err as Error).message);
        }
      },
      (err) => setError(err.message),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [token, enabled]);

  return { last, error };
}

// Subscribes to Mark's last reported location (used by Dio's app)
export function useMarkLocation(token: string, intervalMs = 15_000) {
  const [loc, setLoc] = useState<MarkLocation | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const data = await api<{ location: MarkLocation | null }>(token, "/api/mark-location");
        if (!cancelled) setLoc(data.location);
      } catch {
        // ignore
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
  return loc;
}

// Driver's phone GPS reporter — Dio's app calls this so ETA routing
// originates from him (not the van) when he hasn't picked Mark up yet,
// AND so the in-van /api/position fuser has a fresh fix to prefer over
// Bouncie's lagged OBD reports while driving. Throttled to 3s.
export function useDriverGpsReporter(token: string, enabled: boolean) {
  const [last, setLast] = useState<MarkLocation | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setError("Geolocation not supported");
      return;
    }
    let lastSent = 0;
    const id = navigator.geolocation.watchPosition(
      async (pos) => {
        const now = Date.now();
        if (now - lastSent < 3_000) return;
        lastSent = now;
        const payload = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy_m: pos.coords.accuracy,
        };
        try {
          await postJson(token, "/api/driver-location", payload);
          setLast({
            lat: payload.lat,
            lng: payload.lng,
            accuracy_m: payload.accuracy_m,
            reported_at: new Date().toISOString(),
          });
        } catch (err) {
          setError((err as Error).message);
        }
      },
      (err) => setError(err.message),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [token, enabled]);
  return { last, error };
}
