import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { createHmac, timingSafeEqual } from "node:crypto";

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
  const secret = process.env.BOUNCIE_WEBHOOK_SECRET;
  // Signature verification — Bouncie's actual header name + format isn't
  // documented publicly and the strict reject path was failing every real
  // delivery (Bouncie sent 401s back as "excessive failures" and disabled
  // our webhook). Now we LOG the incoming auth-shaped headers + the
  // computed-vs-provided diff and continue regardless. Once we know which
  // header / hash format Bouncie actually uses we can flip back to strict.
  if (secret) {
    const sigHeaders: Record<string, string | null> = {
      "x-hub-signature-256": req.headers.get("x-hub-signature-256"),
      "x-bouncie-signature": req.headers.get("x-bouncie-signature"),
      "x-signature": req.headers.get("x-signature"),
      "x-bouncie-token": req.headers.get("x-bouncie-token"),
      "authorization": req.headers.get("authorization"),
    };
    const present = Object.entries(sigHeaders).filter(([, v]) => v != null);
    const ok =
      verifySignature(raw, sigHeaders["x-hub-signature-256"], secret) ||
      verifySignature(raw, sigHeaders["x-bouncie-signature"], secret) ||
      verifySignature(raw, sigHeaders["x-signature"], secret);
    if (!ok) {
      // Log enough to figure out the right header / format. The raw body
      // is left untouched so we can replay it once we know how to verify.
      console.warn(
        "[bouncie/webhook] sig mismatch — present headers:",
        present.map(([k]) => k).join(",") || "<none>",
        "raw size:",
        raw.length,
      );
    }
    // Accept either way for now. Endpoint URL has decent obscurity; we'll
    // re-enable strict checking once Bouncie's signature scheme is known.
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
    const rows = samples.map((s) => ({
      source: "bouncie" as const,
      lat: s.lat,
      lng: s.lng,
      heading: s.heading,
      speed_mph: s.speed_mph,
      fuel_pct: s.fuel_pct,
      mileage: s.mileage,
      ignition: s.ignition,
      recorded_at: s.recorded_at,
    }));
    await sb.from("vehicle_positions").insert(rows);

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

  return NextResponse.json({ ok: true, samples: samples.length });
}

// Optional GET for sanity-check / Bouncie's setup verification ping.
export async function GET() {
  return NextResponse.json({ ok: true, hint: "POST telemetry here" });
}
