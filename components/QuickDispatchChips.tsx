"use client";

import { useState } from "react";
import { useInsights, type DestEntry } from "@/components/useInsights";
import { postJson } from "@/lib/api-client";
import { Loader2, Repeat } from "lucide-react";

// Frequent-destinations one-tap dispatch. Shows the top recurring dropoffs
// from the past month; tapping a chip dispatches a fresh trip with that
// dropoff using Mark's CURRENT GPS as pickup. Single-trip mode means any
// existing open trip gets auto-cancelled.
export default function QuickDispatchChips({
  token,
  onDispatched,
}: {
  token: string;
  onDispatched?: () => void;
}) {
  const { data } = useInsights(token);
  const [busy, setBusy] = useState<string | null>(null);

  const dispatch = async (d: DestEntry) => {
    if (busy) return;
    setBusy(d.address);
    try {
      const coords = await getGps();
      await postJson(token, "/api/quick-pickup", {
        lat: coords.lat,
        lng: coords.lng,
        address: "My current location",
        dropoff_address: d.address,
        dropoff_lat: d.lat,
        dropoff_lng: d.lng,
        notes: `Quick dispatch: ${d.address}`,
      });
      onDispatched?.();
    } catch (err) {
      console.warn("[QuickDispatch] failed", err);
    } finally {
      setBusy(null);
    }
  };

  const dests = data?.top_destinations ?? [];
  if (dests.length === 0) return null;

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/85 p-4 backdrop-blur shadow-xl">
      <div className="mb-2 flex items-center gap-1.5 text-xs uppercase tracking-wider text-zinc-500">
        <Repeat size={12} /> Take me to…
      </div>
      <div className="flex flex-wrap gap-2">
        {dests.map((d) => (
          <button
            key={d.address}
            onClick={() => dispatch(d)}
            disabled={!!busy}
            className="flex items-center gap-1.5 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-800 active:scale-[0.98] disabled:opacity-50"
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
  // First comma-separated component is usually the street/landmark name.
  const first = addr.split(",")[0].trim();
  return first.length > 28 ? first.slice(0, 26) + "…" : first;
}

function getGps(): Promise<{ lat: number; lng: number }> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      reject(new Error("Geolocation not available"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => reject(new Error(err.message)),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 15_000 },
    );
  });
}
