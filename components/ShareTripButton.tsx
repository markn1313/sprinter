"use client";

import { useState } from "react";
import { Share2, Loader2 } from "lucide-react";

// One-tap "share live ride" — mints (or reuses) a per-trip passenger link
// then opens iMessage with the URL prefilled. Recipient sees the live van
// position + ETA on /p/<token>.
export default function ShareTripButton({
  token,
  tripId,
  label = "Share ride",
  compact = false,
}: {
  token: string;
  tripId: string;
  label?: string;
  // Compact = icon-only chip styled to match the vital-strip column on
  // Mark home. Default keeps the wider pill used elsewhere.
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);

  const share = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/trips/${tripId}/invite-guest`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const { token: passengerToken } = (await res.json()) as { token: string };
      const url = `${window.location.origin}/p/${passengerToken}`;
      const sms = `sms:&body=${encodeURIComponent(`Live track my ride home — van location updates in real time:\n${url}`)}`;
      window.location.href = sms;
    } finally {
      setBusy(false);
    }
  };

  if (compact) {
    return (
      <button
        onClick={share}
        disabled={busy}
        title="Share live tracking link"
        aria-label="Share"
        className="flex items-center justify-center rounded-xl border border-emerald-700/60 bg-zinc-950/85 px-2.5 py-1.5 text-emerald-300 backdrop-blur hover:bg-zinc-900 disabled:opacity-50"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Share2 size={14} />}
      </button>
    );
  }

  return (
    <button
      onClick={share}
      disabled={busy}
      className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : <Share2 size={12} />}
      {label}
    </button>
  );
}
