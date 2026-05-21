// Server-side idempotency cache. POSTs to /api/destinations carry a
// client-generated UUID in the `Idempotency-Key` header; if we've seen
// the same (token, key) pair within the TTL we return the cached
// response instead of inserting a second time. Defeats:
//   - Double-tap on the action button
//   - Optimistic-UI retry after a 200 that the client didn't see (network
//     drop on the response leg)
//   - Offline-queue replays that fire AFTER an earlier replay succeeded
//
// In-process Map is fine because Vercel functions can be either single-
// instance (Fluid Compute warm) or multi-instance. The worst-case miss
// produces a duplicate insert — exactly what we get today without the
// cache — so it's a strict improvement, not a correctness boundary. For
// stricter dedupe move this to a shared store (e.g. Upstash Redis via
// the Marketplace) when traffic warrants it.

const TTL_MS = 5 * 60 * 1000; // 5 min
const MAX_ENTRIES = 5000; // soft cap, evict oldest first if exceeded

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const store = new Map<string, CacheEntry<unknown>>();

function evictExpired(now: number) {
  for (const [k, v] of store) {
    if (v.expiresAt <= now) store.delete(k);
  }
  if (store.size > MAX_ENTRIES) {
    // Oldest-first eviction. Map iteration order is insertion order.
    const drop = store.size - MAX_ENTRIES;
    let i = 0;
    for (const k of store.keys()) {
      if (i++ >= drop) break;
      store.delete(k);
    }
  }
}

function compositeKey(token: string, idemKey: string): string {
  return `${token}::${idemKey}`;
}

export function getCached<T>(token: string, idemKey: string): T | null {
  if (!token || !idemKey) return null;
  const now = Date.now();
  const e = store.get(compositeKey(token, idemKey));
  if (!e) return null;
  if (e.expiresAt <= now) {
    store.delete(compositeKey(token, idemKey));
    return null;
  }
  return e.value as T;
}

export function setCached<T>(token: string, idemKey: string, value: T): void {
  if (!token || !idemKey) return;
  const now = Date.now();
  evictExpired(now);
  store.set(compositeKey(token, idemKey), { value, expiresAt: now + TTL_MS });
}

// In-flight dedupe. Concurrent requests with the same (token, key) share
// the SAME pending Promise — instead of each running the factory and
// racing on the underlying DB read-modify-write. Original getCached/
// setCached pattern only dedupes if call N finishes before call N+1's
// cache lookup; with three near-simultaneous double-taps, all three
// lookups returned empty and all three ran the factory, three writes
// hit /api/trips.update, last write wins, two ghost stops surfaced to
// the optimistic UI then vanished on the next refetch. Caught in QA
// 2026-05-20.
//
// Stores the Promise itself in the cache during the in-flight window,
// then replaces with the resolved value once it lands so subsequent
// (later) cache hits are synchronous and don't await a settled Promise.
// On factory rejection, the entry is evicted so a retry can re-run.
export function getOrRunWithIdempotency<T>(
  token: string,
  idemKey: string,
  factory: () => Promise<T>,
): Promise<T> {
  if (!token || !idemKey) return factory();
  const key = compositeKey(token, idemKey);
  const now = Date.now();
  const existing = store.get(key);
  if (existing && existing.expiresAt > now) {
    return Promise.resolve(existing.value as T);
  }
  evictExpired(now);
  const p = factory();
  // Park the in-flight Promise so concurrent callers find it. TTL is
  // the same as the post-resolution cache — a hung factory still
  // expires within TTL_MS.
  store.set(key, { value: p, expiresAt: now + TTL_MS });
  p.then(
    (v) => store.set(key, { value: v, expiresAt: Date.now() + TTL_MS }),
    () => store.delete(key), // failed → let retries run fresh
  );
  return p;
}

// Pull the idempotency key out of a Request's headers in a forgiving way
// (capitalization varies by client). Returns null when missing — callers
// can still proceed without dedupe, just losing replay protection.
export function readIdempotencyKey(req: Request): string | null {
  const k =
    req.headers.get("Idempotency-Key") ||
    req.headers.get("idempotency-key") ||
    req.headers.get("X-Idempotency-Key");
  if (!k) return null;
  // Defensive: reject pathologically long keys (a UUID is 36 chars).
  if (k.length > 128) return null;
  return k;
}
