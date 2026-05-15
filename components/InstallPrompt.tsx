"use client";

import { useCallback, useEffect, useState } from "react";
import { X, Download, Compass } from "lucide-react";
import {
  getDeferredPrompt,
  subscribeInstallState,
  triggerInstall,
  wasInstalledThisSession,
} from "@/lib/pwa-install";

type Role = "mark" | "dio" | "passenger" | "tv";

// What we can actually do on this device/browser right now.
//   installed   — already running as a home-screen PWA. Never prompt.
//   android     — Chromium offered a native install prompt. One tap.
//   ios-safari  — real iOS Safari, not installed. Guide Add-to-Home-Screen.
//   ios-inapp   — iOS in-app browser (iMessage / Chrome iOS / SFSafariVC).
//                 Can't install here at all — must open in Safari first.
//   none        — desktop Safari, unsupported browser, etc. Don't prompt.
type Capability = "pending" | "installed" | "android" | "ios-safari" | "ios-inapp" | "none";

// Per-role behavior. Dio + Mark are daily users who genuinely benefit
// from the installed app (push alerts, one-tap launch) so they get a
// firm-but-fair nudge that re-appears the next day if ignored.
// Passengers are mostly one-ride guests — the iMessage link IS their
// access model — so their prompt is soft, slower to appear, and once
// dismissed it stays gone for a month.
const ROLE_CONFIG: Record<
  Exclude<Role, "tv">,
  { delayMs: number; redismissMs: number; soft: boolean }
> = {
  dio: { delayMs: 8_000, redismissMs: 24 * 3_600_000, soft: false },
  mark: { delayMs: 12_000, redismissMs: 24 * 3_600_000, soft: false },
  passenger: { delayMs: 22_000, redismissMs: 30 * 24 * 3_600_000, soft: true },
};

function detectCapability(): Capability {
  if (typeof window === "undefined") return "pending";

  const nav = window.navigator as Navigator & { standalone?: boolean };
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    nav.standalone === true;
  if (standalone || wasInstalledThisSession()) return "installed";

  const ua = nav.userAgent || "";
  const isIOS =
    /iphone|ipad|ipod/i.test(ua) ||
    // iPadOS 13+ reports as "Macintosh"; disambiguate via touch points.
    (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);

  if (isIOS) {
    // `navigator.standalone` is a real boolean only in mobile Safari
    // proper. In-app browsers (iMessage, Chrome iOS, SFSafariViewController)
    // leave it `undefined` — and none of them can add to the home screen.
    return typeof nav.standalone === "boolean" ? "ios-safari" : "ios-inapp";
  }

  // Android / desktop Chromium — depends on whether a native prompt was
  // captured. Resolved dynamically below (it may arrive after mount).
  return getDeferredPrompt() ? "android" : "none";
}

function isIPhone(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipod/i.test(navigator.userAgent);
}

// The iOS system Share glyph — a box open at the top with an up-arrow.
// Drawn inline so the instruction is unambiguous (lucide's Share icon
// is a different, three-dot shape iOS users won't recognize).
function IOSShareGlyph({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3v13" />
      <path d="M8 7l4-4 4 4" />
      <path d="M6 12v6a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-6" />
    </svg>
  );
}

export default function InstallPrompt({ role }: { role: Role }) {
  const [capability, setCapability] = useState<Capability>("pending");
  const [visible, setVisible] = useState(false);
  // Drives the slide-up: starts off-screen, flips on after mount.
  const [entered, setEntered] = useState(false);

  // Register the service worker on mount (not just when push is
  // enabled). Android won't fire `beforeinstallprompt` without a
  // registered SW. Idempotent — re-registering is a no-op.
  useEffect(() => {
    if (role === "tv") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // SW registration can fail in private mode / unsupported browsers.
      // The iOS Add-to-Home-Screen path doesn't need it; only Android
      // installability does, and there's nothing to recover here.
    });
  }, [role]);

  // Decide whether (and when) to show the prompt.
  useEffect(() => {
    if (role === "tv") return;
    const cfg = ROLE_CONFIG[role];

    const evaluate = () => {
      const cap = detectCapability();
      setCapability(cap);

      if (cap === "installed" || cap === "pending") {
        setVisible(false);
        return;
      }
      // A one-ride passenger stuck in the iMessage in-app browser
      // genuinely can't install and shouldn't be told to jump through
      // hoops for a single ride — the link is their access model.
      if (cap === "ios-inapp" && cfg.soft) {
        setVisible(false);
        return;
      }
      if (cap === "none") {
        setVisible(false);
        return;
      }

      // Respect a recent dismissal.
      try {
        const raw = window.localStorage.getItem(`sprinter:install_dismissed:${role}`);
        if (raw) {
          const dismissedAt = Number(raw);
          if (Number.isFinite(dismissedAt) && Date.now() - dismissedAt < cfg.redismissMs) {
            setVisible(false);
            return;
          }
        }
      } catch {
        // localStorage unavailable — fine, just proceed to show.
      }
      setVisible(true);
    };

    // Initial deferred evaluation — gives the user time to see the app
    // work before we ask anything of them.
    const timer = window.setTimeout(evaluate, cfg.delayMs);
    // Also re-evaluate if the install state changes later (e.g. Android
    // fires `beforeinstallprompt` after our delay, or the app gets
    // installed and we should hide).
    const unsub = subscribeInstallState(evaluate);
    return () => {
      window.clearTimeout(timer);
      unsub();
    };
  }, [role]);

  // Trigger the slide-up once we've decided to show.
  useEffect(() => {
    if (visible) {
      const id = window.requestAnimationFrame(() => setEntered(true));
      return () => window.cancelAnimationFrame(id);
    }
    setEntered(false);
  }, [visible]);

  const dismiss = useCallback(() => {
    setEntered(false);
    // Let the slide-down animation finish before unmounting.
    window.setTimeout(() => setVisible(false), 260);
    try {
      window.localStorage.setItem(
        `sprinter:install_dismissed:${role}`,
        String(Date.now()),
      );
    } catch {
      // private mode — the in-memory `visible=false` still suppresses it.
    }
  }, [role]);

  const onAndroidInstall = useCallback(async () => {
    const outcome = await triggerInstall();
    // Whether accepted or dismissed, take the card down. `appinstalled`
    // (if accepted) will also flip capability to "installed".
    if (outcome !== "unavailable") dismiss();
  }, [dismiss]);

  if (role === "tv" || !visible) return null;

  const cfg = ROLE_CONFIG[role];
  const soft = cfg.soft;

  // ---- Copy, role-aware -------------------------------------------------
  const headline =
    capability === "ios-inapp"
      ? "Open in Safari to install"
      : "Add Sprinter to your Home Screen";
  const body =
    capability === "ios-inapp"
      ? "Tap the ••• menu (top right), choose “Open in Safari,” then add Sprinter to your Home Screen."
      : role === "dio"
        ? "Get an alert the second Mark sends a new trip — even with the app closed."
        : role === "mark"
          ? "One-tap access to the van, plus instant trip alerts."
          : "Keep it one tap away to track the van on your next ride.";

  const showIPhoneArrow = capability === "ios-safari" && isIPhone();

  return (
    <>
      <style>{`
        @keyframes sprinter-install-arrow {
          0%, 100% { transform: translateY(0); opacity: 1; }
          50%      { transform: translateY(7px); opacity: 0.55; }
        }
      `}</style>
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-3"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        <div
          className="pointer-events-auto w-full max-w-md rounded-2xl border border-zinc-700 bg-zinc-900 shadow-2xl shadow-black/60 transition-transform duration-300 ease-out"
          style={{ transform: entered ? "translateY(0)" : "translateY(140%)" }}
        >
          <div className="flex items-start gap-3 p-4">
            <div
              className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
                soft ? "bg-zinc-800 text-zinc-300" : "bg-emerald-600 text-white"
              }`}
            >
              {capability === "ios-inapp" ? (
                <Compass size={22} />
              ) : (
                <Download size={22} />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-zinc-100">{headline}</div>
              <div className="mt-0.5 text-xs leading-snug text-zinc-400">{body}</div>
            </div>
            <button
              onClick={dismiss}
              aria-label="Dismiss"
              className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <X size={16} />
            </button>
          </div>

          {/* Android — one-tap native install. */}
          {capability === "android" && (
            <div className="px-4 pb-4">
              <button
                onClick={onAndroidInstall}
                className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-emerald-600 text-sm font-semibold text-white hover:bg-emerald-500 active:scale-[0.99]"
              >
                <Download size={16} /> Install
              </button>
            </div>
          )}

          {/* iOS Safari — guided Add-to-Home-Screen, two steps. */}
          {capability === "ios-safari" && (
            <div className="px-4 pb-4">
              <ol className="space-y-2">
                <li className="flex items-center gap-2.5 text-xs text-zinc-300">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[11px] font-bold text-zinc-300">
                    1
                  </span>
                  <span className="flex items-center gap-1.5">
                    Tap the
                    <span className="inline-flex items-center rounded-md bg-zinc-800 px-1.5 py-1 text-blue-400">
                      <IOSShareGlyph size={16} />
                    </span>
                    Share button
                  </span>
                </li>
                <li className="flex items-center gap-2.5 text-xs text-zinc-300">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[11px] font-bold text-zinc-300">
                    2
                  </span>
                  <span>
                    Choose{" "}
                    <span className="font-semibold text-zinc-100">
                      “Add to Home Screen”
                    </span>
                  </span>
                </li>
              </ol>
            </div>
          )}
        </div>
      </div>

      {/* iPhone-only: a bouncing arrow at the very bottom of the
          viewport, pointing down at Safari's toolbar where the Share
          button lives. Turns the hidden flow into an obvious one. */}
      {showIPhoneArrow && entered && (
        <div
          className="pointer-events-none fixed inset-x-0 z-40 flex justify-center"
          style={{ bottom: "max(0.25rem, env(safe-area-inset-bottom))" }}
        >
          <div
            className="text-blue-400"
            style={{ animation: "sprinter-install-arrow 1.1s ease-in-out infinite" }}
          >
            <svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={3}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M12 5v14" />
              <path d="M5 12l7 7 7-7" />
            </svg>
          </div>
        </div>
      )}
    </>
  );
}
