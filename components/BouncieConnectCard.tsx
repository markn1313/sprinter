"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { Wifi, WifiOff, Check } from "lucide-react";

interface Status {
  connected: boolean;
  vehicle_vin: string | null;
  expires_at: string | null;
  source: "bouncie" | "mock";
}

export default function BouncieConnectCard({ token }: { token: string }) {
  const [status, setStatus] = useState<Status | null>(null);

  const refresh = async () => {
    try {
      const s = await api<Status>(token, "/api/bouncie/status");
      setStatus(s);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [token]);

  // After OAuth callback, URL has ?bouncie=connected — refresh status
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.has("bouncie")) {
      refresh();
      const url = new URL(window.location.href);
      url.searchParams.delete("bouncie");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

  if (!status) return null;
  if (status.connected) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
        <Check size={14} /> Bouncie connected
        {status.vehicle_vin && (
          <span className="text-emerald-500/60">· VIN ···{status.vehicle_vin.slice(-6)}</span>
        )}
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
      <div className="flex items-center gap-2">
        <WifiOff size={14} /> Bouncie not connected — using mock van position
      </div>
      <a
        href={`/api/bouncie/connect?t=${token}`}
        className="rounded-lg bg-amber-600 px-3 py-1 font-medium text-white hover:bg-amber-500"
      >
        Connect
      </a>
    </div>
  );
}
