import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";
import { getVanPosition } from "@/lib/bouncie";
import { supabaseAdmin } from "@/lib/supabase";
import { deriveHeading } from "@/lib/bearing";
import { fuseFromPhone } from "@/lib/fuse-position";
import { advanceTripState } from "@/lib/trip-state-machine";

export const dynamic = "force-dynamic";

function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const pos = await getVanPosition();

  // Bouncie's consumer tier reports every ~15–30s — at 55 mph that's a
  // third of a mile of position lag. When Mark's or Dio's phone is in
  // the van and reporting fresh GPS via /api/mark-location or
  // /api/driver-location, we use that for lat/lng (still keeping
  // Bouncie's vehicle-side speed/fuel/odometer).
  //
  // ONLY fuses on a live `bouncie` source — `bouncie_cached` means the
  // dongle hasn't pinged recently and the proximity baseline is stale.
  // fuseFromPhone() also self-gates on speed + tight proximity so a
  // parked van + Mark stepping out can't drag the van icon to his coords.
  if (pos.source === "bouncie") {
    const fused = await fuseFromPhone({
      lat: pos.lat,
      lng: pos.lng,
      speed_mph: pos.speed_mph,
      source: pos.source,
    });
    if (fused) {
      pos.lat = fused.lat;
      pos.lng = fused.lng;
      pos.updated_at = fused.reported_at;
    }
  }

  // Bouncie reports heading=0 on our tier. Compute a real bearing from the
  // last ~50m of vehicle_positions so the on-screen van icon points the
  // direction the van is actually going. Runs AFTER fusion so the bearing
  // reflects the (possibly phone-overridden) current point.
  if (pos.source === "bouncie" || pos.source === "bouncie_cached") {
    const derived = await deriveHeading(pos.lat, pos.lng);
    if (derived != null) pos.heading = derived;
  }

  // Persist latest to van_position ONLY when something actually changed.
  // Writing on every GET (when nothing changed) creates a realtime feedback
  // loop: CDC fires → subscriber refetches → /api/position writes again →
  // CDC fires again. Suppress when lat/lng/speed are essentially the same
  // AND updated_at hasn't advanced. Subscribers (TV map, Mark home) now
  // only get pushed events when there's a real change worth re-rendering.
  try {
    const sb = supabaseAdmin();
    const { data: prev } = await sb
      .from("van_position")
      .select("lat,lng,speed_mph,fuel_pct,updated_at")
      .eq("id", 1)
      .maybeSingle();
    const prevLat = (prev?.lat as number | null) ?? null;
    const prevLng = (prev?.lng as number | null) ?? null;
    const prevSpeed = (prev?.speed_mph as number | null) ?? null;
    const prevFuel = (prev?.fuel_pct as number | null) ?? null;
    const movedM =
      prevLat != null && prevLng != null
        ? Math.hypot((pos.lat - prevLat) * 111_111, (pos.lng - prevLng) * 111_111 * Math.cos((pos.lat * Math.PI) / 180))
        : Infinity;
    const speedDelta = Math.abs((pos.speed_mph ?? 0) - (prevSpeed ?? 0));
    const fuelDelta = Math.abs((pos.fuel_pct ?? 0) - (prevFuel ?? 0));
    const noPrev = !prev || prevLat == null;
    if (noPrev || movedM > 3 || speedDelta >= 1 || fuelDelta >= 0.005) {
      await sb
        .from("van_position")
        .update({
          lat: pos.lat,
          lng: pos.lng,
          heading: pos.heading,
          speed_mph: pos.speed_mph,
          fuel_pct: pos.fuel_pct,
          battery_v: pos.battery_v,
          mileage: pos.mileage,
          ignition: pos.ignition,
          source: pos.source,
          updated_at: pos.updated_at,
        })
        .eq("id", 1);
    }
  } catch {
    // non-fatal
  }

  // Trip state machine — extracted to lib/trip-state-machine.ts so the
  // same code runs from /api/bouncie/webhook (Bouncie's server pushing
  // dongle reports) AND here (app polls). Awaited because Vercel tears
  // down serverless functions the moment the HTTP response returns —
  // the old void-IIFE pattern silently dropped writes mid-flight, which
  // was the root cause of pickups not registering.
  if (pos.source === "bouncie") {
    try {
      await advanceTripState({
        lat: pos.lat,
        lng: pos.lng,
        speed_mph: pos.speed_mph,
      });
    } catch (err) {
      console.warn("[position] state machine failed:", (err as Error).message);
    }
  }

  // Strip owner-identifying fields for non-Mark / non-Dio sessions —
  // passengers + TV don't need (and shouldn't see) the VIN, raw odometer,
  // or battery voltage. 2026-05-20 QA caught the full VIN leaking into a
  // passenger's /api/position response.
  if (ctx.role !== "mark" && ctx.role !== "dio") {
    const { vin: _vin, nickname: _nickname, mileage: _mileage, battery_v: _battery, ...safe } =
      pos as unknown as Record<string, unknown>;
    void _vin; void _nickname; void _mileage; void _battery;
    return NextResponse.json(safe);
  }
  return NextResponse.json(pos);
}
