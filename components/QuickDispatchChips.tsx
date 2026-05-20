"use client";

import { useMemo, useRef, useState } from "react";
import { useInsights, type DestEntry } from "@/components/useInsights";
import { postJson } from "@/lib/api-client";
import { shortAddr } from "@/lib/format";
import { Loader2, Repeat } from "lucide-react";

// Long-press duration before a chip triggers the "hide this destination"
// action. 500ms is the standard mobile long-press threshold.
const LONG_PRESS_MS = 500;

// Frequent-destinations one-tap dispatch. Shows the top recurring dropoffs
// from the past month; tapping a chip dispatches a fresh trip with that
// dropoff using Mark's CURRENT GPS as pickup. Long-pressing a chip hides
// the destination permanently — useful for one-off pickups that won't be
// reused (random business addresses, single-visit clients, etc.).
//
// Single-trip mode means any existing open trip gets auto-cancelled when
// dispatching.
export default function QuickDispatchChips({
  token,
  onDispatched,
}: {
  token: string;
  onDispatched?: () => void;
}) {
  const { data, refresh } = useInsights(token);
  const [busy, setBusy] = useState<string | null>(null);
  // Addresses the user just long-pressed; hidden optimistically before the
  // server confirms so the chip vanishes immediately. Server-side filter
  // takes over on next /api/insights refresh.
  const [hiddenLocal, setHiddenLocal] = useState<Set<string>>(() => new Set());
  // Per-chip long-press timer state.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef<boolean>(false);

  const dispatch = async (d: DestEntry) => {
    if (busy) return;
    setBusy(d.address);
    try {
      // /api/destinations is the single bootstrap-or-append endpoint —
      // pickup is derived from the van's GPS server-side, we only send
      // the destination. Fresh idempotencyKey per tap so double-tapping
      // the same chip can't accidentally create two trips.
      await postJson(token, "/api/destinations", {
        address: d.address,
        lat: d.lat,
        lng: d.lng,
        idempotencyKey: crypto.randomUUID(),
      });
      onDispatched?.();
    } catch (err) {
      console.warn("[QuickDispatch] failed", err);
    } finally {
      setBusy(null);
    }
  };

  const hide = async (address: string) => {
    setHiddenLocal((s) => new Set(s).add(address.toLowerCase()));
    try {
      await postJson(token, "/api/hidden-destinations", { address });
      // Re-pull insights so the chip stays gone on next render even after
      // refresh-cycle (the server now filters this key out).
      refresh?.();
    } catch (err) {
      console.warn("[QuickDispatch] hide failed", err);
      // Restore on failure so Mark can try again.
      setHiddenLocal((s) => {
        const next = new Set(s);
        next.delete(address.toLowerCase());
        return next;
      });
    }
  };

  const startPress = (d: DestEntry) => {
    longPressFired.current = false;
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      // Haptic feedback if available.
      if (typeof navigator !== "undefined" && "vibrate" in navigator) {
        try {
          navigator.vibrate?.(35);
        } catch {}
      }
      void hide(d.address);
    }, LONG_PRESS_MS);
  };
  const cancelPress = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };
  const handleClick = (d: DestEntry) => {
    // If the long-press already fired, swallow the click so we don't ALSO
    // dispatch a trip to a chip Mark was trying to delete.
    if (longPressFired.current) {
      longPressFired.current = false;
      return;
    }
    dispatch(d);
  };

  const dests = useMemo(
    () => (data?.top_destinations ?? []).filter((d) => !hiddenLocal.has(d.address.toLowerCase())),
    [data, hiddenLocal],
  );
  if (dests.length === 0) return null;

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/85 p-4 backdrop-blur shadow-xl">
      <div className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-wider text-zinc-500">
        <Repeat size={12} /> Take me to…
        <span className="ml-auto text-[10px] normal-case tracking-normal text-zinc-600">Long-press to remove</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {dests.map((d) => (
          <button
            key={d.address}
            onClick={() => handleClick(d)}
            onPointerDown={() => startPress(d)}
            onPointerUp={cancelPress}
            onPointerLeave={cancelPress}
            onPointerCancel={cancelPress}
            onContextMenu={(e) => {
              // Desktop right-click also hides — matches mobile long-press.
              e.preventDefault();
              void hide(d.address);
            }}
            disabled={!!busy}
            className="flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-800 active:scale-[0.98] disabled:opacity-50 select-none"
          >
            {busy === d.address ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              <span className="text-zinc-500 text-[10px]">×{d.count}</span>
            )}
            <span className="max-w-[200px] truncate">{shortLabel(d.address)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function shortLabel(addr: string): string {
  const first = shortAddr(addr);
  return first.length > 28 ? first.slice(0, 26) + "…" : first;
}
