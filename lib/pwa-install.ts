"use client";

// Module-level capture of Chromium's `beforeinstallprompt` event.
//
// The event fires once, early — often before any React component has
// mounted. If we only listened from inside a component's effect we'd
// routinely miss it. So we register the listener at module-eval time
// (the first time anything imports this file on the client) and stash
// the event. The InstallPrompt component then reads it and subscribes
// to changes.

interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let installedThisSession = false;
const subscribers = new Set<() => void>();

function notify(): void {
  for (const cb of subscribers) cb();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    // Prevent Chrome's default mini-infobar — we render our own prompt.
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    installedThisSession = true;
    notify();
  });
}

// The captured prompt, or null if Chromium hasn't offered one (iOS,
// already installed, criteria not met, etc.).
export function getDeferredPrompt(): boolean {
  return deferred !== null;
}

// True once the app has been installed during this page's lifetime
// (the `appinstalled` event fired). Lets the prompt hide itself
// immediately on a successful install without waiting for a reload.
export function wasInstalledThisSession(): boolean {
  return installedThisSession;
}

// Subscribe to install-state changes (a prompt becoming available, or
// the app being installed). Returns an unsubscribe fn.
export function subscribeInstallState(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

// Fire the native Chromium install prompt. Resolves with the user's
// choice, or "unavailable" if there was no captured prompt to fire.
export async function triggerInstall(): Promise<
  "accepted" | "dismissed" | "unavailable"
> {
  if (!deferred) return "unavailable";
  try {
    await deferred.prompt();
    const choice = await deferred.userChoice;
    deferred = null;
    notify();
    return choice.outcome;
  } catch {
    return "unavailable";
  }
}
