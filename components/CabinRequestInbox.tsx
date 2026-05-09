"use client";

import { useEffect, useState } from "react";
import { api, postJson } from "@/lib/api-client";
import { Bell, Check, ThermometerSnowflake, ThermometerSun, Wind, Music, VolumeX, Toilet } from "lucide-react";

interface Req {
  id: string;
  kind: string;
  value: string | null;
  trip_id: string | null;
  requested_at: string;
  acknowledged_at: string | null;
}

const ICONS: Record<string, { Icon: typeof Bell; color: string; label: string }> = {
  cooler: { Icon: ThermometerSnowflake, color: "text-sky-400", label: "Make it cooler" },
  warmer: { Icon: ThermometerSun, color: "text-orange-400", label: "Make it warmer" },
  fan_up: { Icon: Wind, color: "text-emerald-400", label: "Fan higher" },
  fan_down: { Icon: Wind, color: "text-zinc-400", label: "Fan lower" },
  music: { Icon: Music, color: "text-pink-400", label: "Play music" },
  quiet: { Icon: VolumeX, color: "text-violet-400", label: "Less music" },
  restroom: { Icon: Toilet, color: "text-amber-400", label: "Restroom needed" },
};

interface Props {
  token: string;
}

export default function CabinRequestInbox({ token }: Props) {
  const [requests, setRequests] = useState<Req[]>([]);

  const load = async () => {
    try {
      const data = await api<{ requests: Req[] }>(token, "/api/cabin-requests?pending=1");
      setRequests(data.requests || []);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [token]);

  const ack = async (id: string) => {
    setRequests((prev) => prev.filter((r) => r.id !== id));
    try {
      await postJson(token, "/api/cabin-requests", { id }); // wrong method but server handles
      await fetch("/api/cabin-requests", {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
    } catch {
      // ignore — will reappear on next poll if it failed
      load();
    }
  };

  if (requests.length === 0) return null;

  return (
    <div className="space-y-2">
      {requests.map((r) => {
        const meta = ICONS[r.kind] ?? { Icon: Bell, color: "text-zinc-300", label: r.kind };
        const Icon = meta.Icon;
        return (
          <div
            key={r.id}
            className="flex items-center justify-between gap-3 rounded-2xl border border-amber-700/60 bg-amber-950/30 px-3 py-2 shadow-lg shadow-amber-900/20 animate-in slide-in-from-top duration-300"
          >
            <div className="flex items-center gap-2">
              <Icon size={18} className={meta.color} />
              <div>
                <div className="text-sm font-medium text-amber-100">{meta.label}</div>
                <div className="text-[10px] text-amber-400/60">
                  {new Date(r.requested_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                </div>
              </div>
            </div>
            <button
              onClick={() => ack(r.id)}
              className="flex items-center gap-1 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-500"
            >
              <Check size={12} /> Got it
            </button>
          </div>
        );
      })}
    </div>
  );
}
