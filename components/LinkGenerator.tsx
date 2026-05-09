"use client";

import { useEffect, useState } from "react";
import { api, postJson } from "@/lib/api-client";
import { Copy, Check, MessageSquare } from "lucide-react";

interface Props {
  token: string;
  origin: string;
}

interface Link {
  token: string;
  role: string;
  name: string;
}

export default function LinkGenerator({ token, origin }: Props) {
  const [dioToken, setDioToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  // Auto-load existing Dio link on mount (since it's a singleton)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ links: Link[] }>(token, "/api/links");
        if (cancelled) return;
        const dio = res.links.find((l) => l.role === "dio");
        if (dio) setDioToken(dio.token);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

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

  const url = dioToken ? `${origin}/d/${dioToken}` : "";
  const smsHref = dioToken
    ? `sms:&body=${encodeURIComponent(`Sprinter driver app — open & save to your home screen: ${url}`)}`
    : "#";

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4 backdrop-blur">
      <div className="text-xs uppercase tracking-wider text-zinc-500">Driver link</div>
      <div className="mt-2 text-sm text-zinc-300">
        Send Dio his app once — he opens, taps "Add to Home Screen," done.
      </div>
      {dioToken ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <a
              href={smsHref}
              className="flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500"
            >
              <MessageSquare size={14} /> Text to Dio
            </a>
            <button
              onClick={() => copy("dio", url)}
              className="flex items-center justify-center gap-2 rounded-xl bg-zinc-800 px-3 py-2.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700"
            >
              {copied === "dio" ? <Check size={14} /> : <Copy size={14} />}
              {copied === "dio" ? "Copied" : "Copy link"}
            </button>
          </div>
          <code className="mt-2 block truncate rounded-lg bg-black/40 p-2 font-mono text-[11px] text-zinc-500">
            {url}
          </code>
        </>
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
