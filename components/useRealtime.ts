"use client";

import { useEffect, useRef } from "react";
import { supabaseAnon } from "@/lib/supabase";

type EventKind = "INSERT" | "UPDATE" | "DELETE" | "*";

interface RealtimeOptions {
  table: string;
  event?: EventKind;
  filter?: string; // e.g. "trip_id=eq.<uuid>"
  onChange: () => void;
  enabled?: boolean;
}

// Subscribe to Postgres CDC events for a table and fire `onChange` whenever
// something we care about happens. The intent isn't to merge the row payload
// into local state — we just trigger an immediate refresh of whatever hook
// owns the data, so the existing single source of truth (the REST endpoint)
// stays authoritative. Polling stays as a fallback at a long interval.
//
// IMPORTANT: every hook instance gets its OWN channel name. Supabase Realtime
// rejects `.on('postgres_changes', …)` after `.subscribe()`, so reusing a
// channel between two component instances (e.g. DriverChat AND
// useUnreadDriverChat both watching `messages`) crashes the page on hydration.
// We append a random suffix to make every subscription independent.
export function useRealtime({ table, event = "*", filter, onChange, enabled = true }: RealtimeOptions) {
  // onChange ref so we don't re-subscribe on every render
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Stable per-instance suffix so the channel name is unique across hook
  // instances even when they watch the same table+filter.
  const suffixRef = useRef<string | null>(null);
  if (suffixRef.current === null) {
    suffixRef.current =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
  }

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let sb: ReturnType<typeof supabaseAnon> | null = null;
    try {
      sb = supabaseAnon();
    } catch {
      // No anon client available (env not configured) — silently skip.
      return;
    }
    const channelName = `rt:${table}${filter ? ":" + filter : ""}:${suffixRef.current}`;
    const channel = sb
      .channel(channelName)
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "postgres_changes" as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { event, schema: "public", table, ...(filter ? { filter } : {}) } as any,
        () => {
          if (!cancelled) onChangeRef.current();
        },
      )
      .subscribe();
    return () => {
      cancelled = true;
      try {
        sb?.removeChannel(channel);
      } catch {
        // ignore — channel may already be torn down
      }
    };
  }, [table, event, filter, enabled]);
}
