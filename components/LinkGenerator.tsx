"use client";

import { useState } from "react";
import { postJson } from "@/lib/api-client";
import { Copy, Check } from "lucide-react";

interface Props {
  token: string;
  origin: string;
}

export default function LinkGenerator({ token, origin }: Props) {
  const [dioToken, setDioToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const mintDio = async () => {
    setBusy(true);
    try {
      const res = await postJson<{ token: string; reused: boolean }>(token, "/api/links", {
        role: "dio",
        name: "Dio",
      });
      setDioToken(res.token);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (label: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4 backdrop-blur">
      <div className="text-xs uppercase tracking-wider text-zinc-500">Driver link</div>
      <div className="mt-2 text-sm text-zinc-300">
        One link for Dio — give it once, he saves the URL on his home screen.
      </div>
      {dioToken ? (
        <div className="mt-3 flex items-center gap-2">
          <code className="flex-1 truncate rounded-lg bg-black/40 p-2 font-mono text-xs text-emerald-300">
            {origin}/d/{dioToken}
          </code>
          <button
            onClick={() => copy("dio", `${origin}/d/${dioToken}`)}
            className="flex items-center gap-1 rounded-lg bg-zinc-800 px-3 py-2 text-xs hover:bg-zinc-700"
          >
            {copied === "dio" ? <Check size={14} /> : <Copy size={14} />}
            {copied === "dio" ? "Copied" : "Copy"}
          </button>
        </div>
      ) : (
        <button
          onClick={mintDio}
          disabled={busy}
          className="mt-3 rounded-lg bg-zinc-800 px-3 py-2 text-sm font-medium hover:bg-zinc-700 disabled:opacity-50"
        >
          Generate Dio link
        </button>
      )}
    </div>
  );
}
