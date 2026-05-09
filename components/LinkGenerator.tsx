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
  const [tvToken, setTvToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  // Auto-load existing singletons on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api<{ links: Link[] }>(token, "/api/links");
        if (cancelled) return;
        const dio = res.links.find((l) => l.role === "dio");
        const tv = res.links.find((l) => l.role === "tv");
        if (dio) setDioToken(dio.token);
        if (tv) setTvToken(tv.token);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const mintTv = async (regenerate = false) => {
    setBusy(true);
    try {
      const res = await postJson<{ token: string; reused: boolean }>(token, "/api/links", {
        role: "tv",
        name: "TV display",
        regenerate,
      });
      setTvToken(res.token);
    } finally {
      setBusy(false);
    }
  };

  const mintDio = async () => {
    setBusy(true);
    try {
      const res = await postJson<{ token: string; reused: boolean }>(token, "/api/links", {
        role: "dio",
        name: "Driver",
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
    ? `sms:&body=${encodeURIComponent(`Open for today's trip:\n${url}`)}`
    : "#";

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4 backdrop-blur">
      <div className="text-xs uppercase tracking-wider text-zinc-500">Driver link</div>
      <div className="mt-2 text-sm text-zinc-300">
        Send the driver his app once — he opens, taps "Add to Home Screen," done.
      </div>
      {dioToken ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <a
              href={smsHref}
              className="flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500"
            >
              <MessageSquare size={14} /> Text to driver
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
          Generate driver link
        </button>
      )}

      <div className="mt-5 border-t border-zinc-800 pt-4">
        <div className="text-xs uppercase tracking-wider text-zinc-500">In-van TV display</div>
        <div className="mt-2 text-sm text-zinc-300">
          Type this URL into the Apple TV / van TV browser. View-only live map.
        </div>
        {tvToken ? (
          <>
            <div className="mt-3 rounded-lg border border-blue-900/60 bg-blue-950/30 p-4 text-center">
              <div className="font-mono text-2xl font-bold tracking-wide text-blue-200">
                {origin.replace(/^https?:\/\//, "")}/tv/{tvToken}
              </div>
            </div>
            <button
              onClick={() => mintTv(true)}
              disabled={busy}
              className="mt-2 text-[11px] text-zinc-500 hover:text-zinc-300"
            >
              Regenerate (old URL stops working)
            </button>
          </>
        ) : (
          <button
            onClick={() => mintTv(false)}
            disabled={busy}
            className="mt-3 rounded-lg bg-zinc-800 px-3 py-2 text-sm font-medium hover:bg-zinc-700 disabled:opacity-50"
          >
            Generate TV display link
          </button>
        )}
      </div>
    </div>
  );
}
