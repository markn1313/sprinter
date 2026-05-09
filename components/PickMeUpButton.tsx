"use client";

import { useState } from "react";
import { postJson } from "@/lib/api-client";
import { Hand, Loader2, MapPin } from "lucide-react";

interface Props {
  token: string;
  onDispatched: () => void;
}

export default function PickMeUpButton({ token, onDispatched }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [whenMin, setWhenMin] = useState<number>(0); // 0 = now

  const trigger = async (offsetMin: number) => {
    setBusy(true);
    setError(null);
    try {
      const coords = await getGps();
      const when = offsetMin > 0 ? new Date(Date.now() + offsetMin * 60_000).toISOString() : new Date().toISOString();
      await postJson(token, "/api/quick-pickup", {
        lat: coords.lat,
        lng: coords.lng,
        address: "My current location",
        scheduled_at: when,
        notes: offsetMin === 0 ? "Pick me up now" : `Pick me up in ${offsetMin} min`,
      });
      onDispatched();
      setShowOptions(false);
      setWhenMin(0);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!showOptions) {
    return (
      <button
        onClick={() => setShowOptions(true)}
        className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-br from-violet-600 to-fuchsia-700 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-fuchsia-900/40 hover:from-violet-500 hover:to-fuchsia-600"
      >
        <Hand size={16} /> Pick me up
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-violet-900/60 bg-zinc-950/80 p-4">
      <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-violet-300">
        <MapPin size={12} /> Pick me up — uses your current GPS
      </div>
      <div className="grid grid-cols-4 gap-2">
        {[0, 5, 15, 30].map((m) => (
          <button
            key={m}
            onClick={() => trigger(m)}
            disabled={busy}
            className="rounded-xl bg-zinc-800 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
          >
            {busy && whenMin === m ? <Loader2 size={14} className="mx-auto animate-spin" /> : m === 0 ? "Now" : `${m}m`}
          </button>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-xs">
        <button
          onClick={() => setShowOptions(false)}
          disabled={busy}
          className="text-zinc-400 hover:text-zinc-200"
        >
          Cancel
        </button>
        {error && <span className="text-red-400">{error}</span>}
      </div>
    </div>
  );
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
