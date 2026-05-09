"use client";

import { useState } from "react";
import { postJson } from "@/lib/api-client";
import { Fan, Check } from "lucide-react";

interface Props {
  token: string;
  tripId?: string | null;
}

// Compact cabin-control row overlaying the main map. Tap → fires a cabin_request
// that surfaces as a toast in the driver app. Icons:
//   ▲ red   = Warmer
//   ▼ blue  = Cooler
//   big Fan = Fan up
//   small Fan = Fan down
export default function CabinQuickStrip({ token, tripId }: Props) {
  const [recent, setRecent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const send = async (kind: string) => {
    setBusy(true);
    try {
      await postJson(token, "/api/cabin-requests", { kind, trip_id: tripId ?? null });
      setRecent(kind);
      setTimeout(() => setRecent(null), 1600);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5 rounded-2xl border border-zinc-800 bg-zinc-950/85 p-1.5 backdrop-blur shadow-2xl">
      <Btn kind="warmer" onClick={send} busy={busy} just={recent === "warmer"} title="Warmer">
        <span className="text-2xl leading-none text-red-500">▲</span>
      </Btn>
      <Btn kind="cooler" onClick={send} busy={busy} just={recent === "cooler"} title="Cooler">
        <span className="text-2xl leading-none text-blue-400">▼</span>
      </Btn>
      <Btn kind="fan_up" onClick={send} busy={busy} just={recent === "fan_up"} title="More fan">
        <Fan size={22} className="text-zinc-100" />
      </Btn>
      <Btn kind="fan_down" onClick={send} busy={busy} just={recent === "fan_down"} title="Less fan">
        <Fan size={12} className="text-zinc-400" />
      </Btn>
    </div>
  );
}

function Btn({
  kind,
  onClick,
  busy,
  just,
  title,
  children,
}: {
  kind: string;
  onClick: (kind: string) => void;
  busy: boolean;
  just: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={() => onClick(kind)}
      disabled={busy}
      title={title}
      aria-label={title}
      className={`flex h-12 w-12 items-center justify-center rounded-xl transition active:scale-95 disabled:opacity-50 ${
        just ? "bg-emerald-600" : "bg-zinc-800 hover:bg-zinc-700"
      }`}
    >
      {just ? <Check size={18} className="text-white" /> : children}
    </button>
  );
}
