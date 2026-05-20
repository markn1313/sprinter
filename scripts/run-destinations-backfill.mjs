#!/usr/bin/env node
// One-shot runner for supabase/migrations/2026-05-20_destinations_backfill.sql,
// reimplemented in JS so we can execute it via the Supabase REST API
// without needing a direct Postgres connection. Idempotent — re-running
// it skips trips whose stops[] already contains entries close to the
// pickup/dropoff coords.
//
// Usage: node scripts/run-destinations-backfill.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Load .env.local (no dotenv dep — parse it ourselves)
const here = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(here, "..", ".env.local");
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
    }),
);

const SUPABASE_URL = env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
};

function close4(s, lat, lng) {
  const round4 = (n) => Math.round(Number(n) * 1e4) / 1e4;
  return round4(s.lat) === round4(lat) && round4(s.lng) === round4(lng);
}

async function fetchAllTrips() {
  // Paginate via Range header — Supabase REST defaults cap at 1000.
  const all = [];
  let from = 0;
  const page = 500;
  while (true) {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/trips?select=*&order=created_at.asc`, {
      headers: { ...headers, Range: `${from}-${from + page - 1}` },
    });
    if (!r.ok) throw new Error(`fetch trips ${r.status}: ${await r.text()}`);
    const batch = await r.json();
    all.push(...batch);
    if (batch.length < page) break;
    from += page;
  }
  return all;
}

function buildBackfilledStops(t) {
  const stops = Array.isArray(t.stops) ? [...t.stops] : [];
  let changed = false;

  // Pickup
  if (t.pickup_lat != null && t.pickup_lng != null) {
    const hasPickup = stops.some((s) => s.lat != null && s.lng != null && close4(s, t.pickup_lat, t.pickup_lng));
    if (!hasPickup) {
      stops.unshift({
        id: crypto.randomUUID(),
        kind: "stop",
        address: t.pickup_address,
        lat: t.pickup_lat,
        lng: t.pickup_lng,
        passenger: t.passenger_name ?? null,
        created_by_token: t.created_by ?? null,
        arrived_at: t.onboard_at ?? t.arrived_at_pickup_at ?? null,
        added_at: t.created_at ?? new Date().toISOString(),
      });
      changed = true;
    }
  }

  // Dropoff
  if (t.dropoff_lat != null && t.dropoff_lng != null) {
    const hasDropoff = stops.some((s) => s.lat != null && s.lng != null && close4(s, t.dropoff_lat, t.dropoff_lng));
    if (!hasDropoff) {
      stops.push({
        id: crypto.randomUUID(),
        kind: "stop",
        address: t.dropoff_address,
        lat: t.dropoff_lat,
        lng: t.dropoff_lng,
        passenger: null,
        created_by_token: t.created_by ?? null,
        arrived_at: t.arrived_at_dropoff_at ?? null,
        added_at: t.created_at ?? new Date().toISOString(),
      });
      changed = true;
    }
  }

  return { stops, changed };
}

async function patchStops(id, stops) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/trips?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify({ stops }),
  });
  if (!r.ok) throw new Error(`patch ${id} ${r.status}: ${await r.text()}`);
}

const trips = await fetchAllTrips();
console.log(`Loaded ${trips.length} trips`);

let updated = 0;
let unchanged = 0;
let skipped = 0;
for (const t of trips) {
  if (t.pickup_lat == null && t.dropoff_lat == null) {
    skipped++;
    continue;
  }
  const { stops, changed } = buildBackfilledStops(t);
  if (!changed) {
    unchanged++;
    continue;
  }
  await patchStops(t.id, stops);
  updated++;
  if (updated % 25 === 0) console.log(`  updated ${updated}…`);
}

console.log(`\nDone. updated=${updated} unchanged=${unchanged} skipped(no coords)=${skipped}`);
