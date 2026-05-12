"use client";

import { useState } from "react";
import { postJson } from "@/lib/api-client";
import { Check } from "lucide-react";

interface Props {
  token: string;
  tripId?: string | null;
}

// Compact cabin-control row overlaying the main map. Inline SVG icons so colors
// and sizes render reliably on iOS (Unicode triangles are sometimes drawn with
// the system emoji font and ignore CSS color).
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

  // Buttons sized to match the Mark-home right-column vital chips
  // (h-10 w-10) — Mark asked for visual consistency. Previously this
  // strip used h-12 w-12 which dominated the bottom of the map.
  return (
    <div className="flex items-center gap-1 rounded-2xl border border-zinc-800 bg-zinc-950/85 p-1 backdrop-blur shadow-2xl">
      <Btn kind="warmer" onClick={send} busy={busy} just={recent === "warmer"} title="Warmer">
        <TriangleUp />
      </Btn>
      <Btn kind="cooler" onClick={send} busy={busy} just={recent === "cooler"} title="Cooler">
        <TriangleDown />
      </Btn>
      <Btn kind="fan_up" onClick={send} busy={busy} just={recent === "fan_up"} title="More fan">
        <FanIcon size={20} />
      </Btn>
      <Btn kind="fan_down" onClick={send} busy={busy} just={recent === "fan_down"} title="Less fan">
        <FanIcon size={12} />
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
      className={`flex h-10 w-10 items-center justify-center rounded-xl transition active:scale-95 disabled:opacity-50 ${
        just ? "bg-emerald-600" : "bg-zinc-800 hover:bg-zinc-700"
      }`}
    >
      {just ? <Check size={16} className="text-white" /> : children}
    </button>
  );
}

function TriangleUp() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <polygon points="12,3 22,21 2,21" fill="#ef4444" />
    </svg>
  );
}

function TriangleDown() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <polygon points="12,21 22,3 2,3" fill="#3b82f6" />
    </svg>
  );
}

// 4-bladed pinwheel fan
function FanIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <g fill="#e4e4e7">
        <path d="M12 12 C 12 4, 4 4, 12 12 Z" />
        <path d="M12 12 C 20 12, 20 4, 12 12 Z" />
        <path d="M12 12 C 12 20, 20 20, 12 12 Z" />
        <path d="M12 12 C 4 12, 4 20, 12 12 Z" />
        <circle cx="12" cy="12" r="1.6" fill="#52525b" />
      </g>
    </svg>
  );
}
