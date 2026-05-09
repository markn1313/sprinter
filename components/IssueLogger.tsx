"use client";

import { useState } from "react";
import { postJson } from "@/lib/api-client";
import { IssueKind } from "@/lib/types";
import { AlertTriangle, Check } from "lucide-react";

const CHIPS: { kind: IssueKind; emoji: string; label: string }[] = [
  { kind: "dent", emoji: "🚙", label: "Dent" },
  { kind: "noise", emoji: "🔊", label: "Noise" },
  { kind: "low_tire", emoji: "🛞", label: "Low tire" },
  { kind: "battery_low", emoji: "🔋", label: "Battery" },
  { kind: "detail", emoji: "🧽", label: "Needs detail" },
  { kind: "other", emoji: "❗", label: "Other" },
];

interface Props {
  token: string;
}

export default function IssueLogger({ token }: Props) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<IssueKind | null>(null);

  const log = async (kind: IssueKind) => {
    setBusy(true);
    try {
      await postJson(token, "/api/issues", { kind });
      setLast(kind);
      setTimeout(() => setLast(null), 1800);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4">
      <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-zinc-500">
        <AlertTriangle size={12} /> Report issue
      </div>
      <div className="grid grid-cols-3 gap-2">
        {CHIPS.map((c) => (
          <button
            key={c.kind}
            onClick={() => log(c.kind)}
            disabled={busy}
            className={`flex flex-col items-center gap-1 rounded-xl border border-zinc-800 px-2 py-3 text-xs transition disabled:opacity-50 ${
              last === c.kind ? "bg-emerald-700 text-white" : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
            }`}
          >
            <span className="text-lg">{last === c.kind ? "✓" : c.emoji}</span>
            <span>{c.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
