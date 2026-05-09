"use client";

import { useState } from "react";
import { postJson } from "@/lib/api-client";
import { Trip } from "@/lib/types";
import { Send } from "lucide-react";

interface Props {
  token: string;
  onDispatched: (trip: Trip, guestToken: string | null) => void;
}

export default function DispatchBar({ token, onDispatched }: Props) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    if (!input.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await postJson<{ trip: Trip; guestToken: string | null }>(
        token,
        "/api/dispatch",
        { input, mintGuestLink: true },
      );
      setInput("");
      onDispatched(res.trip, res.guestToken);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-3 backdrop-blur">
      <div className="flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) submit();
          }}
          placeholder="Pick up Greg at 2pm, drop off at LAX"
          className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-500 outline-none"
          disabled={busy}
        />
        <button
          onClick={submit}
          disabled={busy || !input.trim()}
          className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 hover:bg-emerald-500"
        >
          <Send size={14} /> Dispatch
        </button>
      </div>
      {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
      <div className="mt-2 text-xs text-zinc-500">
        Try: <em>Pick up Greg now, drop off at LAX</em> · <em>Pick up Sarah at 2pm from Wynn, drop off at Cosmo</em> · <em>Pick me up in 15 min</em>
      </div>
    </div>
  );
}
