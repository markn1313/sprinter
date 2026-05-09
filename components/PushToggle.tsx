"use client";

import { usePush } from "@/components/usePush";
import { Bell, BellOff, Loader2 } from "lucide-react";

export default function PushToggle({ token }: { token: string }) {
  const { supported, enabled, busy, subscribe, unsubscribe } = usePush(token);

  if (!supported) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4 backdrop-blur">
        <div className="text-xs uppercase tracking-wider text-zinc-500">
          Notifications
        </div>
        <div className="mt-2 text-sm text-zinc-400">
          Add this app to your home screen first, then enable notifications
          from there.
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4 backdrop-blur">
      <div className="text-xs uppercase tracking-wider text-zinc-500">
        Notifications
      </div>
      <div className="mt-2 text-sm text-zinc-300">
        {enabled
          ? "On — you’ll get pings for cabin requests, chat, and trip updates."
          : "Get pings for cabin requests, chat, and trip updates without keeping the app open."}
      </div>
      <button
        onClick={() => (enabled ? unsubscribe() : subscribe())}
        disabled={busy}
        className={`mt-3 inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition ${
          enabled
            ? "bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
            : "bg-emerald-600 text-white hover:bg-emerald-500"
        } disabled:opacity-50`}
      >
        {busy ? (
          <Loader2 size={14} className="animate-spin" />
        ) : enabled ? (
          <BellOff size={14} />
        ) : (
          <Bell size={14} />
        )}
        {enabled ? "Turn off notifications" : "Enable notifications"}
      </button>
    </div>
  );
}
