// Browser-side offline write queue. Mark dispatches from a moving van;
// his phone drops in and out of LTE constantly. Mutations the UI fires
// (status changes, stop edits, chat messages) get parked here and
// replayed once the network returns, so the app feels instant even when
// the radio is dead.
//
// IndexedDB-backed so the queue survives tab crash / OS sleep / PWA
// cold-start. Each entry carries an Idempotency-Key — the server-side
// cache in lib/idempotency.ts dedupes replays, so it's safe to retry
// after a 2xx whose response we never saw (the classic "did that POST
// actually land?" case after the radio dies on the return leg).
//
// Tradeoffs: serial drain (not parallel) preserves the order Mark
// performed actions in — a status update can depend on the previous
// one. 4xx removes the entry and surfaces a toast via a CustomEvent
// rather than retrying forever; 5xx / network errors back off
// exponentially to 60s so a flaky tower doesn't hammer the server.
// Private-browsing windows can refuse to open IDB at all — we fall
// back to an in-memory queue there, which loses data on reload but at
// least lets the current session work.

"use client";

const DB_NAME = "sprinter-offline";
const DB_VERSION = 1;
const STORE = "sprinter-offline-queue";
const TICK_MS = 5_000; // periodic re-drain while queue is non-empty
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;

// 4xx codes that mean "don't bother retrying" — the request is malformed,
// unauthorized, missing, conflicting, or semantically invalid. Anything
// else (408, 429, etc.) we treat as transient and keep retrying.
const TERMINAL_4XX = new Set([400, 401, 403, 404, 409, 422]);

export interface QueuedRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  idempotencyKey: string;
}

export interface QueueEntry {
  id?: number; // auto-increment, assigned on put
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
  idempotencyKey: string;
  attempts: number;
  lastError: string | null;
  enqueuedAt: number;
}

// ----- module-level state ---------------------------------------------------

// In-memory fallback for private-browsing windows where IDB throws on open.
// Same shape as a store cursor would yield; ids are assigned by a counter.
const memQueue: QueueEntry[] = [];
let memIdSeq = 1;
let useMemoryFallback = false;

let dbPromise: Promise<IDBDatabase | null> | null = null;

// Drain coordination. `draining` is the mutex; `drainScheduled` debounces
// repeated kick() calls into one upcoming pass.
let draining = false;
let drainScheduled = false;
let loopStarted = false;
let tickTimer: ReturnType<typeof setInterval> | null = null;

const listeners = new Set<(count: number) => void>();

// ----- environment guards ---------------------------------------------------

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

// ----- IDB plumbing ---------------------------------------------------------

function openDb(): Promise<IDBDatabase | null> {
  if (!isBrowser()) return Promise.resolve(null);
  if (useMemoryFallback) return Promise.resolve(null);
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      // iOS Safari private mode throws synchronously here.
      console.warn("[offline-queue] IDB open threw, falling back to memory:", err);
      useMemoryFallback = true;
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn("[offline-queue] IDB open failed, falling back to memory:", req.error);
      useMemoryFallback = true;
      resolve(null);
    };
    req.onblocked = () => {
      // Another tab holds an older version open. Rare for us (one version),
      // but bail to memory rather than hang.
      console.warn("[offline-queue] IDB open blocked, falling back to memory");
      useMemoryFallback = true;
      resolve(null);
    };
  });
  return dbPromise;
}

function tx(db: IDBDatabase, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function reqPromise<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// ----- queue ops (IDB or memory) -------------------------------------------

async function putEntry(entry: QueueEntry): Promise<void> {
  const db = await openDb();
  if (!db) {
    if (entry.id == null) entry.id = memIdSeq++;
    // Replace existing id if present (used by drain to bump attempts).
    const idx = memQueue.findIndex((e) => e.id === entry.id);
    if (idx >= 0) memQueue[idx] = entry;
    else memQueue.push(entry);
    return;
  }
  await reqPromise(tx(db, "readwrite").put(entry));
}

async function deleteEntry(id: number): Promise<void> {
  const db = await openDb();
  if (!db) {
    const idx = memQueue.findIndex((e) => e.id === id);
    if (idx >= 0) memQueue.splice(idx, 1);
    return;
  }
  await reqPromise(tx(db, "readwrite").delete(id));
}

// Returns entries in insertion (FIFO) order. IDB auto-increment keys are
// monotonic, so a default cursor walks oldest-first.
async function listEntries(): Promise<QueueEntry[]> {
  const db = await openDb();
  if (!db) return [...memQueue];
  const store = tx(db, "readonly");
  const result: QueueEntry[] = [];
  return new Promise((resolve, reject) => {
    const req = store.openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(result);
      result.push(cursor.value as QueueEntry);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

async function countEntries(): Promise<number> {
  const db = await openDb();
  if (!db) return memQueue.length;
  return reqPromise(tx(db, "readonly").count());
}

// ----- listener fan-out -----------------------------------------------------

async function notifyChange(): Promise<void> {
  if (listeners.size === 0) return;
  const n = await countEntries().catch(() => 0);
  for (const cb of listeners) {
    try {
      cb(n);
    } catch (err) {
      // A bad subscriber shouldn't poison the rest.
      console.warn("[offline-queue] listener threw:", err);
    }
  }
}

// ----- backoff --------------------------------------------------------------

function backoffMs(attempts: number): number {
  // 1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s, …
  const ms = BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(ms, BACKOFF_CAP_MS);
}

// ----- drain ---------------------------------------------------------------

async function drainOnce(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    // Offline check is best-effort — navigator.onLine lies often (says
    // online when the tower is unreachable), so we still TRY the fetch
    // and let the network error path handle reality.
    const entries = await listEntries();
    if (entries.length === 0) return;

    for (const entry of entries) {
      // Per-entry backoff gate. If this entry is still cooling down,
      // skip it AND the rest — preserving order means we can't leapfrog.
      const cooldown = backoffMs(entry.attempts);
      const age = Date.now() - entry.enqueuedAt;
      if (entry.attempts > 0 && age < cooldown) break;

      const outcome = await sendOne(entry);
      if (outcome === "drop") continue; // already removed from queue
      if (outcome === "retry") break; // 5xx/network: stop, wait for next tick
      // outcome === "done" — fall through to next entry
    }
  } finally {
    draining = false;
    await notifyChange();
  }
}

type SendOutcome = "done" | "drop" | "retry";

async function sendOne(entry: QueueEntry): Promise<SendOutcome> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...entry.headers,
    // Idempotency-Key always wins — server-side dedupe in lib/idempotency.ts
    // relies on it being exactly the value we enqueued, not whatever a
    // caller may have set in entry.headers.
    "Idempotency-Key": entry.idempotencyKey,
  };

  try {
    const res = await fetch(entry.url, {
      method: entry.method,
      headers,
      body: entry.body,
      // We never want a browser/HTTP cache between us and the server when
      // replaying mutations.
      cache: "no-store",
    });

    if (res.ok) {
      if (entry.id != null) await deleteEntry(entry.id);
      return "done";
    }

    if (TERMINAL_4XX.has(res.status)) {
      // Don't retry — but tell the UI so it can show a toast. Reading the
      // body is best-effort; some 4xx responses are empty.
      const errBody = await res.text().catch(() => "");
      console.warn(
        `[offline-queue] dropping ${entry.method} ${entry.url} (${res.status}): ${errBody}`,
      );
      if (entry.id != null) await deleteEntry(entry.id);
      emitRejected(entry, res.status, errBody);
      return "drop";
    }

    // Other non-2xx (5xx, 408, 429, etc.) — bump attempts, leave in queue.
    await bumpAttempts(entry, `HTTP ${res.status}`);
    return "retry";
  } catch (err) {
    // Fetch rejected — offline, DNS fail, TLS error, etc. Treat as transient.
    const msg = err instanceof Error ? err.message : String(err);
    await bumpAttempts(entry, msg);
    return "retry";
  }
}

async function bumpAttempts(entry: QueueEntry, reason: string): Promise<void> {
  const updated: QueueEntry = {
    ...entry,
    attempts: entry.attempts + 1,
    lastError: reason,
    // Reset enqueuedAt so the backoff gate measures from the LAST attempt,
    // not the original enqueue time. Otherwise a long-queued entry would
    // skip every backoff.
    enqueuedAt: Date.now(),
  };
  await putEntry(updated);
}

function emitRejected(entry: QueueEntry, status: number, body: string): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(
      new CustomEvent("queue-rejected", {
        detail: { entry, status, body },
      }),
    );
  } catch (err) {
    console.warn("[offline-queue] failed to dispatch queue-rejected:", err);
  }
}

// Debounce kick: many components may call enqueue() in the same tick;
// coalesce into one drain pass on the next microtask.
function kick(): void {
  if (drainScheduled) return;
  drainScheduled = true;
  queueMicrotask(() => {
    drainScheduled = false;
    void drainOnce();
  });
}

// ----- public API -----------------------------------------------------------

export async function enqueue(req: QueuedRequest): Promise<void> {
  if (!isBrowser()) return; // SSR no-op
  if (!req.idempotencyKey) {
    // Hard requirement — without this, server-side dedupe can't protect
    // against double-applies. Refuse to enqueue rather than silently
    // weakening the contract.
    throw new Error("offline-queue: enqueue() requires idempotencyKey");
  }
  const entry: QueueEntry = {
    url: req.url,
    method: req.method,
    headers: req.headers ?? {},
    body: req.body,
    idempotencyKey: req.idempotencyKey,
    attempts: 0,
    lastError: null,
    enqueuedAt: Date.now(),
  };
  await putEntry(entry);
  await notifyChange();
  kick();
}

export function startDrainLoop(): void {
  if (!isBrowser()) return;
  if (loopStarted) return; // idempotent — safe to call from many useEffects
  loopStarted = true;

  // Drain when the browser reports we're back online. navigator.onLine
  // is noisy but this event is reasonably reliable as a "try now" signal.
  window.addEventListener("online", kick);
  // Drain when the tab becomes visible again — iOS suspends background tabs
  // and the 'online' event may have fired while we were frozen.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") kick();
  });

  // Periodic tick while there's something to do. Cheap when empty (just a
  // count()), and our serial drain self-throttles via per-entry backoff.
  tickTimer = setInterval(() => {
    void (async () => {
      const n = await countEntries().catch(() => 0);
      if (n > 0) kick();
    })();
  }, TICK_MS);

  // Initial kick in case there are entries left over from a prior session
  // (tab crash, hard reload mid-drain).
  kick();
}

export function onQueueChange(cb: (count: number) => void): () => void {
  listeners.add(cb);
  // Fire once with the current count so subscribers can render immediately
  // without a separate getPendingCount() call.
  if (isBrowser()) {
    void countEntries()
      .then((n) => {
        try {
          cb(n);
        } catch {
          /* swallow — same reason as notifyChange */
        }
      })
      .catch(() => {
        /* count failed; subscriber will get the next change event */
      });
  }
  return () => {
    listeners.delete(cb);
  };
}

export async function getPendingCount(): Promise<number> {
  if (!isBrowser()) return 0;
  return countEntries().catch(() => 0);
}
