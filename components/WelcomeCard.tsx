"use client";

import { useState } from "react";
import { useInsights } from "@/components/useInsights";
import { postJson } from "@/lib/api-client";
import { Loader2, Home, Sparkles } from "lucide-react";

interface Props {
  token: string;
  vanLat: number | null;
  vanLng: number | null;
  myLat: number | null;
  myLng: number | null;
  onDispatched?: () => void;
}

// "Welcome back" card. Shows on Mark home when there's no active trip.
// Smart move: if Mark's GPS (or van) is far from his most-frequent address
// (assumed home), surface a big "Take me home" button. Otherwise greet
// with quick stats from the last day.
export default function WelcomeCard({ token, vanLat, vanLng, myLat, myLng, onDispatched }: Props) {
  const { data } = useInsights(token);
  const [busy, setBusy] = useState(false);

  if (!data) return null;
  const home = data.top_destinations[0];
  if (!home || home.lat == null || home.lng == null) return null;

  // Are we far from "home"?
  const ref = myLat != null && myLng != null ? { lat: myLat, lng: myLng } : vanLat != null && vanLng != null ? { lat: vanLat, lng: vanLng } : null;
  if (!ref) return null;
  const milesFromHome = haversineMi(ref.lat, ref.lng, home.lat, home.lng);
  if (milesFromHome < 5) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950/90 p-4 backdrop-blur shadow-xl">
        <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-zinc-500">
          <Sparkles size={12} className="text-emerald-400" /> Welcome back
        </div>
        <div className="mt-1 text-base text-zinc-100">
          You drove <span className="font-mono font-bold text-emerald-300">{data.today.miles}</span> mi today
          {data.today.fuel_cost_dollars > 0 && (
            <> · <span className="font-mono font-bold text-zinc-200">${data.today.fuel_cost_dollars}</span> in fuel</>
          )}
        </div>
      </div>
    );
  }

  const dispatchHome = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const coords = await getGps();
      await postJson(token, "/api/quick-pickup", {
        lat: coords.lat,
        lng: coords.lng,
        address: "My current location",
        dropoff_address: home.address,
        dropoff_lat: home.lat,
        dropoff_lng: home.lng,
        notes: "Take me home",
      });
      onDispatched?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-emerald-700/60 bg-gradient-to-br from-emerald-950/70 to-zinc-950 p-4 shadow-2xl">
      <div className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-emerald-300">
        <Sparkles size={12} /> Welcome back
      </div>
      <div className="mt-1 text-sm text-zinc-300">
        You're <span className="font-mono font-bold text-zinc-100">{milesFromHome.toFixed(0)}</span> mi from{" "}
        <span className="text-zinc-100">{shortLabel(home.address)}</span>
      </div>
      <button
        onClick={dispatchHome}
        disabled={busy}
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 px-4 py-3 text-base font-semibold text-white shadow-lg hover:bg-emerald-500 disabled:opacity-50"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Home size={16} />}
        Take me home
      </button>
    </div>
  );
}

function haversineMi(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 3959;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function shortLabel(addr: string): string {
  return addr.split(",")[0].trim();
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
