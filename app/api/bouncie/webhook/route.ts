import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { createHmac, timingSafeEqual } from "node:crypto";
import { advanceTripStateForBatch } from "@/lib/trip-state-machine";

export const dynamic = "force-dynamic";

// Bouncie webhook receiver. Configure the webhook URL in the Bouncie dev
// console pointing at:
//   https://sprinter-tau.vercel.app/api/bouncie/webhook
// And paste the secret it shows you into the BOUNCIE_WEBHOOK_SECRET env var.
//
// Bouncie pushes telemetry as the OBD dongle reports — typically ~5-15s
// faster than our prior /api/position polling cycle, and without the cold
// /api/position function spin-up tax. The webhook writes straight into
// `vehicle_positions` (timeseries) and upserts `van_position` (latest-row
// cache). All clients subscribed to those tables via Supabase realtime
// see the update within ~50ms.
//
// Event shapes Bouncie sends:
//   - tripData: { vehicleId, vin, type:'tripData', data: { gps:[ {lat,lon,timestamp,heading,speed,fuelLevel,odometer} ] } }
//   - tripStart / tripEnd / disconnect / connect: similar shape, often
//     without a full GPS array — we only act on samples we can parse.
//
// We accept any payload shape and pluck GPS samples wherever they appear.

interface MaybeGpsSample {
  lat?: number | string;
  lon?: number | string;
  lng?: number | string;
  longitude?: number | string;
  latitude?: number | string;
  heading?: number | string;
  speed?: number | string;
  speedMph?: number | string;
  timestamp?: string;
  time?: string;
  date?: string;
  fuelLevel?: number | string;
  odometer?: number | string;
  isRunning?: boolean;
}

interface ExtractedSample {
  lat: number;
  lng: number;
  heading: number | null;
  speed_mph: number | null;
  fuel_pct: number | null;
  mileage: number | null;
  ignition: boolean | null;
  recorded_at: string;
}

function num(x: unknown): number | null {
  if (x == null) return null;
  const n = typeof x === "string" ? parseFloat(x) : (x as number);
  return Number.isFinite(n) ? n : null;
}

function extractSamples(payload: unknown): ExtractedSample[] {
  const out: ExtractedSample[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as MaybeGpsSample & Record<string, unknown>;
    const lat = num(obj.lat ?? obj.latitude);
    const lng = num(obj.lon ?? obj.lng ?? obj.longitude);
    if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      const fuelRaw = num(obj.fuelLevel);
      out.push({
        lat,
        lng,
        heading: num(obj.heading),
        speed_mph: num(obj.speed ?? obj.speedMph),
        fuel_pct: fuelRaw != null ? (fuelRaw > 1 ? fuelRaw / 100 : fuelRaw) : null,
        mileage: num(obj.odometer),
        ignition: typeof obj.isRunning === "boolean" ? obj.isRunning : null,
        recorded_at: (obj.timestamp as string | undefined) ?? (obj.time as string | undefined) ?? (obj.date as string | undefined) ?? new Date().toISOString(),
      });
    }
    // Recurse into nested objects (gps array, stats, etc.)
    for (const v of Object.values(obj)) visit(v);
  };
  visit(payload);
  // De-dup by recorded_at (Bouncie sometimes resends the same instant).
  const seen = new Set<string>();
  return out.filter((s) => {
    const key = `${s.recorded_at}|${s.lat.toFixed(6)}|${s.lng.toFixed(6)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Constant-time signature compare. Bouncie sends the HMAC in X-Hub-Signature-256
// or X-Bouncie-Signature depending on the account; we accept either.
function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const provided = header.replace(/^sha256=/, "");
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

export async function POST(req: Request) {
  const raw = await req.text();
  // Belt-and-suspenders: strip any stray whitespace/newline that snuck into
  // the env value (Vercel's UI accepts pastes with trailing \n and we lost
  // a day to that — see commit ec1fa07). HMAC against extra bytes makes
  // every real delivery 401.
  const secret = process.env.BOUNCIE_WEBHOOK_SECRET?.trim();
  if (secret) {
    const sigHeaders: Record<string, string | null> = {
      "x-hub-signature-256": req.headers.get("x-hub-signature-256"),
      "x-bouncie-signature": req.headers.get("x-bouncie-signature"),
      "x-signature": req.headers.get("x-signature"),
    };
    const ok =
      verifySignature(raw, sigHeaders["x-hub-signature-256"], secret) ||
      verifySignature(raw, sigHeaders["x-bouncie-signature"], secret) ||
      verifySignature(raw, sigHeaders["x-signature"], secret);
    if (!ok) {
      const present = Object.entries(sigHeaders)
        .filter(([, v]) => v != null)
        .map(([k]) => k);
      console.warn(
        "[bouncie/webhook] sig mismatch — present:",
        present.join(",") || "<none>",
        "size:",
        raw.length,
      );
      // Accept anyway. The endpoint URL is opaque + we still want the
      // telemetry to flow even if Bouncie ever ships a sig header rename
      // or format change. If spurious POSTs become a problem we can flip
      // back to a 401 reject here.
    }
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const samples = extractSamples(payload);
  if (samples.length === 0) {
    // Heartbeats / non-GPS events still 200 so Bouncie doesn't retry.
    return NextResponse.json({ ok: true, samples: 0 });
  }

  // Wrap DB writes — a transient Supabase blip shouldn't 500 Bouncie and
  // count toward their "excessive failures" deactivation threshold. If
  // we can't write, log it and still return 200 so Bouncie keeps sending.
  try {
    const sb = supabaseAdmin();

    // Throttle the bulk insert — Bouncie often sends ~10s blocks of
    // sub-second-spaced samples. Storing every one of them blows up
    // vehicle_positions with redundant data that has no reconstruction
    // value. Walk the batch in time order and keep a sample only when
    // it meaningfully differs from the previous KEPT sample (5m move
    // OR 1mph speed change OR 0.5pp fuel change OR 3s gap).
    const ordered = samples.slice().sort(
      (a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime(),
    );
    // Anchor the throttle against the latest Bouncie row already in
    // the DB so back-to-back webhook deliveries don't sneak duplicates
    // across batch boundaries.
    const { data: lastStored } = await sb
      .from("vehicle_positions")
      .select("lat,lng,speed_mph,fuel_pct,recorded_at")
      .eq("source", "bouncie")
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const haversineM = (lat1: number, lng1: number, lat2: number, lng2: number) => {
      const R = 6_371_000;
      const toRad = (d: number) => (d * Math.PI) / 180;
      const dLat = toRad(lat2 - lat1);
      const dLng = toRad(lng2 - lng1);
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };
    type PrevShape = { lat: number; lng: number; speed_mph: number | null; fuel_pct: number | null; recorded_at: string } | null;
    let prev: PrevShape = lastStored
      ? {
          lat: lastStored.lat as number,
          lng: lastStored.lng as number,
          speed_mph: lastStored.speed_mph as number | null,
          fuel_pct: lastStored.fuel_pct as number | null,
          recorded_at: lastStored.recorded_at as string,
        }
      : null;
    const kept: typeof ordered = [];
    for (const s of ordered) {
      if (s.lat == null || s.lng == null) continue;
      if (!prev) {
        kept.push(s);
        prev = { lat: s.lat, lng: s.lng, speed_mph: s.speed_mph, fuel_pct: s.fuel_pct, recorded_at: s.recorded_at };
        continue;
      }
      const ageMs = new Date(s.recorded_at).getTime() - new Date(prev.recorded_at).getTime();
      const movedM = haversineM(prev.lat, prev.lng, s.lat, s.lng);
      const dSpeed = Math.abs((s.speed_mph ?? 0) - (prev.speed_mph ?? 0));
      const dFuel = Math.abs((s.fuel_pct ?? 0) - (prev.fuel_pct ?? 0));
      // Time-gap floor: keeps the timeseries from going minute-long
      // void when the van is moving. 3s during ignition-on (so we get
      // 1 sample per 3 seconds of driving even in a straight line),
      // 5 min when parked + ignition-off (so an overnight parking
      // session adds 12 rows/hour, not 1200). Bouncie sends heartbeat
      // pings even when off, and without this gate they all pass the
      // OR predicate because the 3s clock ticks.
      const parkedAndOff = s.ignition === false && (s.speed_mph ?? 0) < 1;
      const timeFloor = parkedAndOff ? 5 * 60_000 : 3000;
      if (ageMs >= timeFloor || movedM >= 5 || dSpeed >= 1 || dFuel >= 0.005) {
        kept.push(s);
        prev = { lat: s.lat, lng: s.lng, speed_mph: s.speed_mph, fuel_pct: s.fuel_pct, recorded_at: s.recorded_at };
      }
    }

    // Look up the active trip once and tag every kept row so per-trip
    // reconstruction queries can filter without time-window guessing.
    const { data: activeTrip } = await sb
      .from("trips")
      .select("id")
      .in("status", ["scheduled", "dispatched", "at_pickup", "onboard", "at_dropoff"])
      .order("scheduled_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const tripId = (activeTrip?.id as string | null) ?? null;

    const rows = kept.map((s) => ({
      source: "bouncie" as const,
      lat: s.lat,
      lng: s.lng,
      heading: s.heading,
      speed_mph: s.speed_mph,
      fuel_pct: s.fuel_pct,
      mileage: s.mileage,
      ignition: s.ignition,
      recorded_at: s.recorded_at,
      trip_id: tripId,
    }));
    if (rows.length > 0) {
      await sb.from("vehicle_positions").insert(rows);
    }

    const latest = samples.reduce((a, b) => (a.recorded_at > b.recorded_at ? a : b));
    await sb
      .from("van_position")
      .update({
        lat: latest.lat,
        lng: latest.lng,
        heading: latest.heading,
        speed_mph: latest.speed_mph,
        fuel_pct: latest.fuel_pct,
        mileage: latest.mileage,
        ignition: latest.ignition,
        source: "bouncie",
        updated_at: latest.recorded_at,
      })
      .eq("id", 1);
  } catch (err) {
    console.warn("[bouncie/webhook] db write failed:", (err as Error).message);
  }

  // Run the trip state machine against the full batch. This is the
  // canonical entry point — fires on every Bouncie dongle report
  // regardless of whether any app is open or polling. Awaited so the
  // writes land before the serverless function tears down. Uses MIN
  // distance to each pending waypoint across the whole batch (not
  // just the latest sample), catching brief sub-30m pass-throughs.
  try {
    await advanceTripStateForBatch(
      samples.map((s) => ({
        lat: s.lat,
        lng: s.lng,
        speed_mph: s.speed_mph,
      })),
    );
  } catch (err) {
    console.warn("[bouncie/webhook] state machine failed:", (err as Error).message);
  }

  return NextResponse.json({ ok: true, samples: samples.length });
}

// Optional GET for sanity-check / Bouncie's setup verification ping.
export async function GET() {
  return NextResponse.json({ ok: true, hint: "POST telemetry here" });
}
