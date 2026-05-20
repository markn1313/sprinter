import { NextResponse } from "next/server";
import { requireMark } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

interface SamplePoint {
  lat: number;
  lng: number;
  speed: number;
  ts: string;
  ignition: boolean;
}

// Trip replay: returns the GPS timeseries for a completed trip, downsampled
// to ~400 points so it renders smoothly. Every Bouncie sample lives forever
// in vehicle_positions; the trip's dispatched_at→completed_at window is the
// slice we need.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = supabaseAdmin();
  const { data: trip } = await sb
    .from("trips")
    .select("dispatched_at,completed_at,stops")
    .eq("id", id)
    .maybeSingle();
  if (!trip) return NextResponse.json({ error: "not found" }, { status: 404 });

  const since = (trip.dispatched_at as string | null) ?? new Date(0).toISOString();
  const until = (trip.completed_at as string | null) ?? new Date().toISOString();

  // Pull all bouncie rows in the trip window. Cap at 5000 to stay under
  // Supabase's response size cap; for a 30-min trip at 6s cadence that's
  // 300 rows so we have plenty of headroom.
  const { data, error } = await sb
    .from("vehicle_positions")
    .select("lat,lng,speed_mph,ignition,recorded_at")
    .eq("source", "bouncie")
    .gte("recorded_at", since)
    .lte("recorded_at", until)
    .not("lat", "is", null)
    .not("lng", "is", null)
    .order("recorded_at", { ascending: true })
    .limit(5000);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  type Row = { lat: number | null; lng: number | null; speed_mph: number | null; ignition: boolean | null; recorded_at: string };
  const rows = (data ?? []) as Row[];

  // De-duplicate near-identical consecutive samples (multiple polling clients
  // can write the same Bouncie reading within the same second). We keep one
  // sample per second of recorded_at.
  const seen = new Set<string>();
  const dedupe: Row[] = [];
  for (const r of rows) {
    const sec = r.recorded_at.slice(0, 19); // YYYY-MM-DDTHH:MM:SS
    if (seen.has(sec)) continue;
    seen.add(sec);
    dedupe.push(r);
  }

  // Downsample to ~400 points for snappy scrubbing
  const TARGET = 400;
  const stride = Math.max(1, Math.ceil(dedupe.length / TARGET));
  const samples: SamplePoint[] = [];
  for (let i = 0; i < dedupe.length; i += stride) {
    const r = dedupe[i];
    samples.push({
      lat: r.lat ?? 0,
      lng: r.lng ?? 0,
      speed: r.speed_mph ?? 0,
      ts: r.recorded_at,
      ignition: !!r.ignition,
    });
  }
  // Always include the last point so the route ends at the dropoff.
  if (dedupe.length > 0) {
    const last = dedupe[dedupe.length - 1];
    const tail = samples[samples.length - 1];
    if (!tail || tail.ts !== last.recorded_at) {
      samples.push({
        lat: last.lat ?? 0,
        lng: last.lng ?? 0,
        speed: last.speed_mph ?? 0,
        ts: last.recorded_at,
        ignition: !!last.ignition,
      });
    }
  }

  // Build the stop chain for the replay overlay. stops[0] is the pickup,
  // stops[last] is the final dropoff; anything in between is a mid-trip
  // waypoint the replay can render as a numbered marker. arrived_at lets
  // the scrubber show which stop has been reached at each point in time.
  type Stop = {
    address?: string | null;
    lat?: number | null;
    lng?: number | null;
    arrived_at?: string | null;
  };
  const rawStops = (trip as { stops?: Stop[] | null }).stops ?? [];
  const stops = rawStops
    .filter((s) => typeof s.lat === "number" && typeof s.lng === "number")
    .map((s) => ({
      lat: s.lat as number,
      lng: s.lng as number,
      address: s.address ?? null,
      arrived_at: s.arrived_at ?? null,
    }));
  const pickup = stops.length > 0 ? { lat: stops[0].lat, lng: stops[0].lng } : null;
  const dropoff = stops.length > 0 ? { lat: stops[stops.length - 1].lat, lng: stops[stops.length - 1].lng } : null;

  return NextResponse.json({
    samples,
    pickup,
    dropoff,
    stops,
    raw_count: dedupe.length,
    sample_count: samples.length,
  });
}
