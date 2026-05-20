"use client";

// The ONE input on the passenger screen. "Where to?" — type an address,
// drop a pin on the map, hit Go. Everything downstream of this is the
// server's problem: bootstrap-or-append, optimization, dual-write, the
// whole dance lives in /api/destinations.
//
// Live incident 2026-05-20: a passenger tapped Go three times in a row
// because the LTE was dead in the canyon. The third tap landed once the
// radio came back, and without the idempotency key + offline queue we
// would have appended the same stop three times to her trip. This file
// is built so that can never happen again:
//
//   1. ONE Idempotency-Key per user action. Auto-retries (409 → forceNew,
//      403 → override) reuse it; only a brand-new submit mints a fresh one.
//   2. fetch() failure → enqueue() to lib/offline-queue. The queue itself
//      carries the same key, and the server's idempotency cache dedupes
//      the eventual replay against any submit that somehow already landed.
//   3. Optimistic chip the instant Go is tapped. The passenger never sits
//      staring at an unresponsive input wondering if it took.
//
// No native confirms. No "are you sure?" The whole design premise is
// that the user genuinely cannot mess this up — drag-reorder + remove
// live on the trip list, not here.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { enqueue, onQueueChange, startDrainLoop } from "@/lib/offline-queue";

export interface DestinationInputProps {
  /** Session token — Mark's or the passenger's link token. */
  token: string;
  /** Called after a successful add so the parent can refresh its trip view. */
  onTripChanged?: () => void;
  /**
   * Parent opens its map's pin-drop UI and resolves to coords (or null if
   * the user cancelled). If not provided, the "Drop pin" button is hidden.
   */
  onPinDropRequest?: () => Promise<{ lat: number; lng: number } | null>;
  /**
   * Phone GPS from the parent's geolocation watcher. We forward it as the
   * X-Phone-GPS header so the server can run the bootstrap proximity
   * check ("is she actually in the van?") without us having to ask
   * geolocation again ourselves.
   */
  myGps?: { lat: number; lng: number; ageMs: number } | null;
  className?: string;
}

// Per-action submit envelope. Carries the idempotency key across automatic
// retries so the server-side dedupe in lib/idempotency.ts can do its job.
interface SubmitEnvelope {
  idempotencyKey: string;
  displayLabel: string; // shown in the optimistic chip
  body: {
    lat?: number;
    lng?: number;
    address?: string;
    forceNew?: boolean;
    override?: "in_van";
  };
}

// Chip shown below the input. Drives both the "Adding…" optimistic state
// AND the post-submit success / error / offline messages — keeping it one
// state value means we never have two chips fighting for the same slot.
type Chip =
  | { kind: "pending"; label: string }
  | { kind: "offline"; label: string }
  | { kind: "error"; message: string; retry?: SubmitEnvelope }
  | null;

// 4xx error chip auto-dismisses after this long. Mark watches the screen
// in a moving van — a persistent red banner steals attention from the road.
const ERROR_CHIP_TTL_MS = 6_000;

// X-Phone-GPS is meaningless past about a minute. The server enforces a
// 60s limit too; we mirror it here so we don't ship a header that's
// guaranteed to be rejected.
const GPS_HEADER_MAX_AGE_MS = 60_000;

export default function DestinationInput({
  token,
  onTripChanged,
  onPinDropRequest,
  myGps,
  className,
}: DestinationInputProps) {
  const [value, setValue] = useState("");
  const [chip, setChip] = useState<Chip>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [pinDropBusy, setPinDropBusy] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  // Stash the auto-dismiss timer so a fast follow-up doesn't leave a
  // stale handle firing setChip(null) on top of a new chip.
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Kick the offline drain loop exactly once. It's internally idempotent
  // (loopStarted guard), but we still want a single source of truth: this
  // component is mounted whenever the passenger can be typing destinations,
  // so it's the right place to ensure the queue is alive.
  useEffect(() => {
    startDrainLoop();
  }, []);

  // Pending-count badge: a tiny dot with a number when any writes are
  // still parked in IndexedDB. Reassures Mark that the typed-but-offline
  // request is in flight, not lost. onQueueChange fires immediately with
  // the current count so we render correctly on first paint.
  useEffect(() => {
    const off = onQueueChange((n) => setPendingCount(n));
    return off;
  }, []);

  // Belt-and-suspenders: if a destinations POST gets parked in the queue
  // and the server eventually rejects it as a terminal 4xx, the offline
  // queue fires a 'queue-rejected' CustomEvent. Surface that as an error
  // chip so the user knows the offline-saved write didn't actually land.
  useEffect(() => {
    function onRejected(ev: Event) {
      const detail = (ev as CustomEvent<{ entry: { url: string }; body: string }>).detail;
      if (!detail?.entry?.url?.includes("/api/destinations")) return;
      let message = "That didn't go through.";
      try {
        const parsed = JSON.parse(detail.body) as { message?: string };
        if (parsed?.message) message = parsed.message;
      } catch {
        /* body wasn't JSON — keep the generic message */
      }
      showError(message);
    }
    window.addEventListener("queue-rejected", onRejected);
    return () => window.removeEventListener("queue-rejected", onRejected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clean up the auto-dismiss timer on unmount so we don't poke a state
  // setter on a torn-down component.
  useEffect(() => {
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, []);

  const showError = useCallback((message: string, retry?: SubmitEnvelope) => {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    setChip({ kind: "error", message, retry });
    errorTimerRef.current = setTimeout(() => {
      setChip(null);
      errorTimerRef.current = null;
    }, ERROR_CHIP_TTL_MS);
  }, []);

  const clearChip = useCallback(() => {
    if (errorTimerRef.current) {
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = null;
    }
    setChip(null);
  }, []);

  /**
   * Send a single submit envelope. Recursive in two narrow cases:
   *  - 409 TRIP_FINAL  → resubmit with forceNew=true, SAME idempotency key.
   *  - 403 NOT_IN_VAN  → DO NOT auto-resubmit. Show the "I'm in the van"
   *    button and let the user tap it; we then call submit() again with
   *    override="in_van", SAME key.
   *
   * Network failure or 5xx → enqueue + show "saved offline" chip and resolve.
   * The server's idempotency cache makes the eventual replay safe even if
   * the original POST landed on the wire and we just never saw the 2xx.
   */
  const submit = useCallback(
    async (envelope: SubmitEnvelope): Promise<void> => {
      setSubmitting(true);
      setChip({ kind: "pending", label: envelope.displayLabel });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "Idempotency-Key": envelope.idempotencyKey,
      };
      // Phone GPS is only useful (and only accepted) while fresh.
      if (myGps && myGps.ageMs < GPS_HEADER_MAX_AGE_MS) {
        const ageSec = Math.round(myGps.ageMs / 1000);
        headers["X-Phone-GPS"] = `${myGps.lat},${myGps.lng},${ageSec}`;
      }

      const requestBody = JSON.stringify({
        ...envelope.body,
        idempotencyKey: envelope.idempotencyKey,
      });

      let res: Response;
      try {
        res = await fetch("/api/destinations", {
          method: "POST",
          headers,
          body: requestBody,
          cache: "no-store",
        });
      } catch {
        // Network died. Park the write and let the drain loop replay it
        // when the radio recovers. The server-side idempotency cache
        // makes this safe even if our original POST somehow reached the
        // server before the radio dropped.
        await enqueue({
          url: "/api/destinations",
          method: "POST",
          headers,
          body: requestBody,
          idempotencyKey: envelope.idempotencyKey,
        });
        setSubmitting(false);
        setChip({ kind: "offline", label: envelope.displayLabel });
        setValue("");
        return;
      }

      // 5xx — treat as transient. Same offline-queue path as a network
      // failure. The user sees "saving..." rather than a scary red error.
      if (res.status >= 500) {
        await enqueue({
          url: "/api/destinations",
          method: "POST",
          headers,
          body: requestBody,
          idempotencyKey: envelope.idempotencyKey,
        });
        setSubmitting(false);
        setChip({ kind: "offline", label: envelope.displayLabel });
        setValue("");
        return;
      }

      // 409: a completed/cancelled trip is sitting in the slot. Auto-retry
      // with forceNew=true, reusing the same idempotency key — the server
      // treats the retry as the same user action, and the previous 409 was
      // never cached as a success.
      if (res.status === 409) {
        const data = (await safeJson(res)) as { error?: string } | null;
        if (data?.error === "TRIP_FINAL") {
          setSubmitting(false);
          await submit({
            ...envelope,
            body: { ...envelope.body, forceNew: true },
          });
          return;
        }
        // Any other 409 is unexpected — surface it.
        showError("Conflict — try again.");
        setSubmitting(false);
        return;
      }

      // 403: server couldn't prove she's in the van. Don't auto-retry —
      // we need her to tap "I'm in the van" first. Stash the envelope on
      // the chip so the button can resubmit with override="in_van" and
      // the same idempotency key.
      if (res.status === 403) {
        const data = (await safeJson(res)) as { error?: string; message?: string } | null;
        if (data?.error === "NOT_IN_VAN") {
          const message = data.message ?? "We can't confirm you're in the van.";
          showError(message, {
            ...envelope,
            body: { ...envelope.body, override: "in_van" },
          });
          setSubmitting(false);
          return;
        }
        showError(data?.message ?? "Not allowed.");
        setSubmitting(false);
        return;
      }

      // 400: OUT_OF_AREA / NOT_FOUND / UNCLEAR / bad_body — all "the
      // input was wrong" cases. Show the server's message verbatim;
      // it's already user-readable ("That address is outside our
      // service area.", etc.).
      if (res.status === 400) {
        const data = (await safeJson(res)) as { message?: string } | null;
        showError(data?.message ?? "Couldn't add that destination.");
        setSubmitting(false);
        return;
      }

      // Any other non-2xx — generic surface.
      if (!res.ok) {
        showError(`Couldn't add that destination (${res.status}).`);
        setSubmitting(false);
        return;
      }

      // Success. Clear everything, refresh the parent.
      setSubmitting(false);
      clearChip();
      setValue("");
      onTripChanged?.();
    },
    [token, myGps, onTripChanged, showError, clearChip],
  );

  /**
   * Brand-new user action → mint a fresh idempotency key.
   *
   * Mints happen exactly here (typed submit) and in the pin-drop handler.
   * Auto-retries inside submit() reuse the key.
   */
  const handleTextSubmit = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      const raw = value.trim();
      if (!raw) return;
      if (submitting) return;
      await submit({
        idempotencyKey: crypto.randomUUID(),
        displayLabel: raw,
        body: { address: raw },
      });
    },
    [value, submitting, submit],
  );

  const handlePinDrop = useCallback(async () => {
    if (!onPinDropRequest || pinDropBusy || submitting) return;
    setPinDropBusy(true);
    try {
      const coords = await onPinDropRequest();
      if (!coords) return; // user cancelled the pin-drop overlay
      await submit({
        idempotencyKey: crypto.randomUUID(),
        displayLabel: "pinned location",
        body: { lat: coords.lat, lng: coords.lng },
      });
    } finally {
      setPinDropBusy(false);
    }
  }, [onPinDropRequest, pinDropBusy, submitting, submit]);

  // Enter on the input fires submit. Explicit handler (rather than relying
  // purely on the <form>) because some mobile keyboards swallow the
  // synthetic submit event in iOS PWAs.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleTextSubmit();
      }
    },
    [handleTextSubmit],
  );

  const handleInVanRetry = useCallback(
    async (retry: SubmitEnvelope) => {
      await submit(retry);
    },
    [submit],
  );

  return (
    <div className={className}>
      <form onSubmit={handleTextSubmit} className="flex items-stretch gap-2">
        <div className="relative flex-1">
          <input
            ref={inputRef}
            type="text"
            inputMode="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-label="Destination"
            placeholder="Where to?"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={submitting}
            className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-3 text-base text-zinc-100 placeholder:text-zinc-500 focus:border-violet-600 focus:outline-none focus:ring-1 focus:ring-violet-600 disabled:opacity-50"
          />
          {pendingCount > 0 && (
            // Small reassurance dot. Sits inside the input on the right.
            // The count is the queue depth — usually 1, occasionally 2 if
            // the user fires off two writes during a tunnel.
            <span
              aria-label={`${pendingCount} pending writes`}
              className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-bold text-zinc-950 shadow"
            >
              {pendingCount}
            </span>
          )}
        </div>
        <button
          type="submit"
          disabled={submitting || value.trim().length === 0}
          className="rounded-xl bg-gradient-to-br from-violet-600 to-fuchsia-700 px-4 py-2 text-sm font-semibold text-white shadow active:scale-95 hover:from-violet-500 hover:to-fuchsia-600 disabled:opacity-50"
        >
          Go
        </button>
        {onPinDropRequest && (
          <button
            type="button"
            onClick={handlePinDrop}
            disabled={submitting || pinDropBusy}
            className="rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-100 active:scale-95 hover:bg-zinc-800 disabled:opacity-50"
            aria-label="Drop pin on map"
          >
            {pinDropBusy ? "…" : "Drop pin"}
          </button>
        )}
      </form>

      {chip && (
        <div className="mt-2">
          {chip.kind === "pending" && (
            // Optimistic chip — the moment Go is tapped, before we even
            // know the server got the request. Reassures the user that
            // their action registered.
            <div className="rounded-lg border border-violet-700/60 bg-violet-950/40 px-3 py-2 text-xs font-medium text-violet-200">
              Adding {chip.label}…
            </div>
          )}
          {chip.kind === "offline" && (
            // Saved-offline chip. The drain loop will retry on its own
            // schedule; we don't need a manual "retry" button here. The
            // pendingCount badge above doubles as a heartbeat.
            <div className="rounded-lg border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-xs font-medium text-amber-200">
              Saved offline — will retry when you&rsquo;re back online.
            </div>
          )}
          {chip.kind === "error" && (
            <div
              role="alert"
              onClick={clearChip}
              className="flex cursor-pointer items-center justify-between gap-2 rounded-lg border border-red-700/60 bg-red-950/50 px-3 py-2 text-xs font-medium text-red-200"
            >
              <span>{chip.message}</span>
              {chip.retry && (
                // The NOT_IN_VAN escape hatch. Honor-system override —
                // the server treats this as "I trust the user that she's
                // in the van; skip the proximity check." Same idempotency
                // key as the original attempt.
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleInVanRetry(chip.retry as SubmitEnvelope);
                  }}
                  className="shrink-0 rounded-md bg-gradient-to-br from-violet-600 to-fuchsia-700 px-2 py-1 text-[11px] font-semibold text-white shadow active:scale-95 hover:from-violet-500 hover:to-fuchsia-600"
                >
                  I&rsquo;m in the van
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Parsing the body of a non-2xx is best-effort: a 400 from a CDN edge or
// an empty 5xx body would otherwise throw and turn an already-bad case
// into an even-worse one.
async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
