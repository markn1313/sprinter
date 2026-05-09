"use client";

import { useEffect, useState } from "react";
import { api, postJson } from "@/lib/api-client";
import { DioStatusEmoji } from "@/lib/types";

const OPTIONS: { key: DioStatusEmoji; emoji: string; label: string }[] = [
  { key: "driving", emoji: "🚐", label: "Driving" },
  { key: "idle", emoji: "🟢", label: "Idle" },
  { key: "fueling", emoji: "⛽", label: "Fueling" },
  { key: "lunch", emoji: "🍔", label: "Break" },
  { key: "parked", emoji: "🅿️", label: "Parked" },
  { key: "traffic", emoji: "🚦", label: "Traffic" },
  { key: "off", emoji: "🛌", label: "Off" },
];

interface Props {
  token: string;
  editable: boolean;
}

export default function DioStatusBar({ token, editable }: Props) {
  const [emoji, setEmoji] = useState<DioStatusEmoji>("idle");
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      const res = await api<{ status: { emoji: DioStatusEmoji } }>(token, "/api/dio/status");
      if (res.status?.emoji) setEmoji(res.status.emoji);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [token]);

  const set = async (k: DioStatusEmoji) => {
    if (!editable) return;
    setBusy(true);
    setEmoji(k);
    try {
      await postJson(token, "/api/dio/status", { emoji: k });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      {OPTIONS.map((opt) => {
        const active = opt.key === emoji;
        return (
          <button
            key={opt.key}
            onClick={() => set(opt.key)}
            disabled={busy || !editable}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition ${
              active
                ? "bg-emerald-600 text-white"
                : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:cursor-default disabled:hover:bg-zinc-800"
            }`}
          >
            <span>{opt.emoji}</span>
            <span>{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
