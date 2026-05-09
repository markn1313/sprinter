"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { postJson } from "@/lib/api-client";

/**
 * Convert a base64url-encoded VAPID public key to an ArrayBuffer
 * suitable for PushManager.subscribe()'s `applicationServerKey`.
 *
 * Returning ArrayBuffer (not Uint8Array) sidesteps a TS lib.dom.d.ts
 * narrowing where Uint8Array<ArrayBufferLike> is not assignable to BufferSource.
 */
function urlBase64ToBuffer(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const buf = new ArrayBuffer(rawData.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < rawData.length; i += 1) {
    view[i] = rawData.charCodeAt(i);
  }
  return buf;
}

type IOSNavigator = Navigator & { standalone?: boolean };

function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  // iPad on iOS 13+ reports as Macintosh — also check touch points
  const isIpadOS =
    /Macintosh/.test(ua) &&
    typeof navigator.maxTouchPoints === "number" &&
    navigator.maxTouchPoints > 1;
  return /iPad|iPhone|iPod/.test(ua) || isIpadOS;
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as IOSNavigator;
  if (nav.standalone === true) return true;
  try {
    return window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
}

async function getVapidPublicKey(token: string): Promise<string> {
  const env = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (env && env.length > 0) return env;
  const res = await fetch("/api/push/vapid-public-key", {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`vapid key fetch failed: ${res.status}`);
  const json = (await res.json()) as { key: string };
  return json.key;
}

export function usePush(token: string): {
  supported: boolean;
  enabled: boolean;
  busy: boolean;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
} {
  const [supported, setSupported] = useState<boolean>(false);
  const [enabled, setEnabled] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (typeof window === "undefined") return;

      // Basic capability checks
      const hasSW = "serviceWorker" in navigator;
      const hasPush = "PushManager" in window;
      const hasNotif = "Notification" in window;
      if (!hasSW || !hasPush || !hasNotif) {
        if (!cancelled) setSupported(false);
        return;
      }

      // iOS Safari requires PWA-installed (standalone) for Push to work
      if (isIosSafari() && !isStandalone()) {
        if (!cancelled) setSupported(false);
        return;
      }

      // Permission denied = effectively unsupported (can't ask again)
      if (Notification.permission === "denied") {
        if (!cancelled) setSupported(false);
        return;
      }

      try {
        const reg =
          (await navigator.serviceWorker.getRegistration("/sw.js")) ||
          (await navigator.serviceWorker.register("/sw.js"));
        if (cancelled) return;
        registrationRef.current = reg;
        const existing = await reg.pushManager.getSubscription();
        if (cancelled) return;
        setEnabled(!!existing);
        setSupported(true);
      } catch {
        if (!cancelled) setSupported(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const subscribe = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const reg =
        registrationRef.current ||
        (await navigator.serviceWorker.register("/sw.js"));
      registrationRef.current = reg;

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setSupported(Notification.permission !== "denied");
        return;
      }

      const existing = await reg.pushManager.getSubscription();
      const sub =
        existing ||
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToBuffer(
            await getVapidPublicKey(token),
          ),
        }));

      const json = sub.toJSON();
      const endpoint = json.endpoint;
      const p256dh = json.keys?.p256dh;
      const auth = json.keys?.auth;
      if (!endpoint || !p256dh || !auth) {
        throw new Error("subscription missing endpoint or keys");
      }

      await postJson(token, "/api/push/subscribe", {
        endpoint,
        p256dh,
        auth,
        user_agent: navigator.userAgent,
      });
      setEnabled(true);
    } finally {
      setBusy(false);
    }
  }, [token, busy]);

  const unsubscribe = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const reg =
        registrationRef.current ||
        (await navigator.serviceWorker.getRegistration("/sw.js"));
      if (!reg) {
        setEnabled(false);
        return;
      }
      const sub = await reg.pushManager.getSubscription();
      if (!sub) {
        setEnabled(false);
        return;
      }
      const endpoint = sub.endpoint;
      try {
        await sub.unsubscribe();
      } catch {
        /* even if browser-side unsubscribe fails, still tell server to forget us */
      }
      try {
        await postJson(token, "/api/push/unsubscribe", { endpoint });
      } catch {
        /* server may already not have it; ignore */
      }
      setEnabled(false);
    } finally {
      setBusy(false);
    }
  }, [token, busy]);

  return { supported, enabled, busy, subscribe, unsubscribe };
}
