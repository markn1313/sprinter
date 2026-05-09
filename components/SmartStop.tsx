"use client";

import { useState } from "react";
import { postJson } from "@/lib/api-client";
import { Coffee, Search, Loader2 } from "lucide-react";

interface Suggestion {
  id: string;
  name: string;
  category: string;
  lat: number;
  lng: number;
  distance_m_from_anchor: number;
  eta_to_stop_minutes: number;
  tags: Record<string, string>;
}

interface Props {
  token: string;
  tripId: string | null;
  onAdded: () => void;
}

export default function SmartStop({ token, tripId, onAdded }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [adding, setAdding] = useState<string | null>(null);

  const search = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      const offsetMatch = text.match(/(\d+)\s*(?:min|m)\b/i);
      const offset = offsetMatch ? Number(offsetMatch[1]) : 15;
      const res = await postJson<{ suggestions: Suggestion[] }>(token, "/api/suggest-stops", {
        text,
        offset_minutes: offset,
      });
      setSuggestions(res.suggestions || []);
    } finally {
      setBusy(false);
    }
  };

  const add = async (s: Suggestion) => {
    if (!tripId) return;
    setAdding(s.id);
    try {
      await postJson(token, `/api/trips/${tripId}/stops`, {
        kind: "stop",
        category: s.category,
        address: s.name,
        lat: s.lat,
        lng: s.lng,
      });
      setSuggestions([]);
      setText("");
      onAdded();
    } finally {
      setAdding(null);
    }
  };

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4">
      <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-zinc-500">
        <Coffee size={12} /> Add a stop on the way
      </div>
      <div className="flex items-center gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") search();
          }}
          placeholder="coffee in 20 min · gas before LAX · restroom asap"
          className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-500 outline-none"
          disabled={busy}
        />
        <button
          onClick={search}
          disabled={busy || !text.trim()}
          className="rounded-lg bg-cyan-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 hover:bg-cyan-500"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
        </button>
      </div>
      {suggestions.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {suggestions.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-zinc-100">{s.name}</div>
                <div className="text-[11px] text-zinc-500">
                  {(s.distance_m_from_anchor / 1609.34).toFixed(1)} mi
                  {s.tags.brand ? ` · ${s.tags.brand}` : ""}
                </div>
              </div>
              <button
                onClick={() => add(s)}
                disabled={adding === s.id || !tripId}
                className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                title={!tripId ? "Need an active trip to add a stop" : ""}
              >
                {adding === s.id ? "Adding…" : "Add"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!tripId && suggestions.length > 0 && (
        <div className="mt-2 text-[11px] text-amber-400">
          Need an active trip to add stops to.
        </div>
      )}
    </div>
  );
}
