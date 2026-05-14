"use client";

import { useState } from "react";
import { Share2, Loader2 } from "lucide-react";

// One-tap "share live ride / track my van" — mints (or reuses) a
// passenger link and opens the native share sheet (falls back to
// `sms:` deep link on platforms without Web Share).
//
// Two modes determined by `tripId`:
//   - tripId set    → /api/trips/<id>/invite-guest. Recipient sees
//                     the trip on /p/<token> (live van + ETA + chat).
//   - tripId null   → /api/invite-tracker mints a passenger link
//                     with no trip_id. Recipient sees the live van
//                     position on /p/<token>, no trip details.
//
// The map's left-column rendering passes the active trip when there
// is one, null otherwise, so the chip is always there for Mark to
// tap.
export default function ShareTripButton({
  token,
  tripId,
  label,
  compact = false,
}: {
  token: string;
  tripId: string | null;
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
      const endpoint = tripId
        ? `/api/trips/${tripId}/invite-guest`
        : `/api/invite-tracker`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const { token: passengerToken } = (await res.json()) as { token: string };
      const url = `${window.location.origin}/p/${passengerToken}`;
      const body = `Join Sprinter trip here:\n${url}`;
      if ("share" in navigator) {
        try {
          await (
            navigator as Navigator & {
              share: (d: { title: string; text: string; url: string }) => Promise<void>;
            }
          ).share({
            title: tripId ? "Sprinter ride" : "Sprinter van",
            text: body,
            url,
          });
        } catch {
          // user cancelled or platform rejected — drop silently
        }
        // Web Share API was available: success OR cancel both end here.
        // Don't fall through to the `sms:` deep link, that would
        // forward Mark to Messages a SECOND time after he just sent.
        return;
      }
      window.location.href = `sms:&body=${encodeURIComponent(body)}`;
    } finally {
      setBusy(false);
    }
  };

  const computedLabel = label ?? (tripId ? "Share ride" : "Share van");

  if (compact) {
    return (
      <button
        onClick={share}
        disabled={busy}
        title={tripId ? "Share live trip link" : "Share live van location"}
        aria-label="Share"
        className="flex h-10 w-10 items-center justify-center rounded-xl border border-emerald-700/60 bg-zinc-950/85 text-emerald-300 backdrop-blur hover:bg-zinc-900 active:scale-95 disabled:opacity-50"
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : <Share2 size={16} />}
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
      {computedLabel}
    </button>
  );
}
