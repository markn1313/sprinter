import { NextResponse } from "next/server";
import { requireTripActor } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { geocode } from "@/lib/geocode";
import { optimizeStops } from "@/lib/routing";
import { logTripEvent } from "@/lib/log";
import { notifyDriverPlanChange } from "@/lib/push";

interface Stop {
  id: string;
  kind: "pickup" | "dropoff" | "stop";
  category?: string;
  address: string;
  lat: number | null;
  lng: number | null;
  passenger?: string | null;
  // Per-stop passenger-link token. Minted by
  // POST /api/trips/[id]/stops/[stopId]/passenger when Mark sets a name
  // on a stop. Stored here so the stop popup can deep-link into the
  // passenger view (and revoke the old one if Mark renames the passenger).
  passenger_link_token?: string | null;
  // Whose Pickup-button action created this stop. Maps to a link's
  // token (Mark's, or a passenger's). Used to find "MY stop" so
  // tapping Pickup again becomes a modify rather than another add.
  created_by_token?: string | null;
  arrived_at?: string | null;
  added_at: string;
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  // Trip-actor (Mark OR THIS trip's passenger) may add stops.
  const ctx = await requireTripActor(token, id);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | {
        address?: string;
        lat?: number;
        lng?: number;
        kind?: "stop" | "pickup" | "dropoff";
        category?: string;
        passenger?: string;
        created_by_token?: string; // who's Pickup-button created this stop
        index?: number; // position to insert at (0 = first stop). Defaults to end.
      }
    | null;
  if (!body || (!body.address && (body.lat == null || body.lng == null))) {
    return NextResponse.json({ error: "missing address or coords" }, { status: 400 });
  }

  let lat = body.lat ?? null;
  let lng = body.lng ?? null;
  let display = body.address ?? `${lat},${lng}`;
  if ((lat == null || lng == null) && body.address) {
    const g = await geocode(body.address);
    if (g) {
      lat = g.lat;
      lng = g.lng;
      display = g.display;
    }
  }

  const sb = supabaseAdmin();
  const { data: trip } = await sb
    .from("trips")
    .select("stops")
    .eq("id", id)
    .single();
  const stops: Stop[] = (trip?.stops as Stop[] | undefined) ?? [];
  const newStop: Stop = {
    id: crypto.randomUUID(),
    kind: body.kind ?? "stop",
    category: body.category,
    address: display,
    lat,
    lng,
    passenger: body.passenger ?? null,
    // Default to the requester's token so the next time they hit
    // Pickup we can find this stop as "theirs" and modify-in-place.
    created_by_token: body.created_by_token ?? ctx.token,
    added_at: new Date().toISOString(),
  };
  // Explicit index → respect caller's chosen position. No explicit
  // index → append, then auto-optimize the pending stops via Mapbox
  // Optimized Trips. Mark's UI just adds a stop; he doesn't think
  // about visit order — the server figures it out so Newport →
  // Magnolia → De La Nonna stays in the order that minimizes total
  // drive distance.
  const explicitIndex = typeof body.index === "number";
  const idx = explicitIndex ? Math.max(0, Math.min(stops.length, body.index!)) : stops.length;
  stops.splice(idx, 0, newStop);

  let finalStops: Stop[] = stops;
  if (!explicitIndex && newStop.kind === "stop") {
    const arrivedStops = stops.filter((s) => s.arrived_at != null);
    const pendingStops = stops.filter(
      (s) => s.arrived_at == null && s.lat != null && s.lng != null,
    );
    // Need at least 3 pending (start anchor + ≥1 middle + end anchor) for
    // the optimizer to have any reordering work to do. Anchor start = last
    // arrived stop if any else the first pending (which IS the pickup);
    // anchor end = last pending (the final destination). Everything in
    // between is what gets re-ranked.
    if (pendingStops.length >= 3) {
      const startPoint =
        arrivedStops.length > 0
          ? {
              lat: arrivedStops[arrivedStops.length - 1].lat as number,
              lng: arrivedStops[arrivedStops.length - 1].lng as number,
            }
          : { lat: pendingStops[0].lat as number, lng: pendingStops[0].lng as number };
      const endPoint = {
        lat: pendingStops[pendingStops.length - 1].lat as number,
        lng: pendingStops[pendingStops.length - 1].lng as number,
      };
      const optimized = await optimizeStops(
        startPoint,
        endPoint,
        pendingStops.map((s) => ({ lat: s.lat as number, lng: s.lng as number })),
      );
      if (optimized) {
        const remaining = pendingStops.slice();
        const reordered: Stop[] = [];
        for (const wp of optimized) {
          const i = remaining.findIndex(
            (s) =>
              Math.abs((s.lat as number) - wp.lat) < 1e-6 &&
              Math.abs((s.lng as number) - wp.lng) < 1e-6,
          );
          if (i >= 0) {
            reordered.push(remaining[i]);
            remaining.splice(i, 1);
          }
        }
        finalStops = [...arrivedStops, ...reordered, ...remaining];
      }
    }
  }

  const { error } = await sb.from("trips").update({ stops: finalStops }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logTripEvent({
    trip_id: id,
    kind: "stop_added",
    actor_token: ctx.token,
    payload: { stop: newStop, optimized: finalStops !== stops },
  });
  void notifyDriverPlanChange({
    title: newStop.passenger ? `Pickup added: ${newStop.passenger}` : "Stop added",
    body: newStop.address,
  });
  return NextResponse.json({ stop: newStop, stops: finalStops });
}

// PUT replaces the entire stops array atomically — used by trip-detail "Update driver"
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireTripActor(token, id);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { stops?: Stop[]; optimize?: boolean }
    | null;
  if (!body || !Array.isArray(body.stops)) {
    return NextResponse.json({ error: "missing stops array" }, { status: 400 });
  }
  // Default: auto-optimize (TripDetailApp's "Update driver" path
  // wants the route minimized). Manual reorder UI (the up/down + Flag
  // buttons in TripSheet) passes optimize=false because Mark just
  // explicitly chose the order and the optimizer would clobber it.
  const shouldOptimize = body.optimize !== false;

  // Geocode any stops missing lat/lng
  const sb = supabaseAdmin();
  const filled: Stop[] = [];
  for (const s of body.stops) {
    let lat = s.lat;
    let lng = s.lng;
    if ((lat == null || lng == null) && s.address) {
      const g = await geocode(s.address);
      if (g) {
        lat = g.lat;
        lng = g.lng;
      }
    }
    filled.push({
      id: s.id ?? crypto.randomUUID(),
      kind: s.kind ?? "stop",
      address: s.address,
      lat,
      lng,
      passenger: s.passenger ?? null,
      passenger_link_token: s.passenger_link_token ?? null,
      created_by_token: s.created_by_token ?? null,
      arrived_at: s.arrived_at ?? null,
      added_at: s.added_at ?? new Date().toISOString(),
    });
  }

  // Auto-optimize the visit order of intermediate stops via Mapbox's
  // Optimized-Trips API. Mark trusts the system to sequence them; he
  // shouldn't have to think about whether Huntington Beach goes before
  // or after a Long Beach stop on a Newport → LA trip. ALREADY-ARRIVED
  // stops are pinned in place (their order is historical, not optional);
  // only pending stops get permuted.
  let next: Stop[] = filled;
  if (shouldOptimize) {
    const arrived = filled.filter((s) => s.arrived_at != null);
    const pending = filled.filter((s) => s.arrived_at == null && s.lat != null && s.lng != null);
    // Need ≥3 pending (start anchor + ≥1 middle + end anchor) for the
    // optimizer to have meaningful reorder work. Start = last arrived
    // stop if any, else the first pending (which IS the pickup); end =
    // last pending (the final destination).
    if (pending.length >= 3) {
      const startPoint =
        arrived.length > 0
          ? {
              lat: arrived[arrived.length - 1].lat as number,
              lng: arrived[arrived.length - 1].lng as number,
            }
          : { lat: pending[0].lat as number, lng: pending[0].lng as number };
      const endPoint = {
        lat: pending[pending.length - 1].lat as number,
        lng: pending[pending.length - 1].lng as number,
      };
      const optimized = await optimizeStops(
        startPoint,
        endPoint,
        pending.map((s) => ({ lat: s.lat as number, lng: s.lng as number })),
      );
      if (optimized) {
        // Rebuild the pending list in optimized order, then concat after
        // arrived stops so history stays intact.
        const remaining = pending.slice();
        const reordered: Stop[] = [];
        for (const wp of optimized) {
          const idx = remaining.findIndex(
            (s) => Math.abs((s.lat as number) - wp.lat) < 1e-6 && Math.abs((s.lng as number) - wp.lng) < 1e-6,
          );
          if (idx >= 0) {
            reordered.push(remaining[idx]);
            remaining.splice(idx, 1);
          }
        }
        // Append any leftovers (shouldn't happen, but defensive)
        next = [...arrived, ...reordered, ...remaining];
      }
    }
  }

  const { error } = await sb.from("trips").update({ stops: next }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logTripEvent({
    trip_id: id,
    kind: "stops_replaced",
    actor_token: ctx.token,
    payload: { stops: next, optimized: next !== filled },
  });
  // Stops replaced wholesale — driver's next destination almost
  // certainly just changed. Title-case the first pending stop so the
  // lock-screen banner is meaningful.
  const firstPending = next.find((s) => !s.arrived_at && s.lat != null && s.lng != null);
  if (firstPending) {
    void notifyDriverPlanChange({
      title: firstPending.passenger ? `Next pickup: ${firstPending.passenger}` : "Stops updated",
      body: firstPending.address,
    });
  }
  return NextResponse.json({ stops: next });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireTripActor(token, id);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const stopId = url.searchParams.get("stop");
  if (!stopId) return NextResponse.json({ error: "missing stop id" }, { status: 400 });

  const sb = supabaseAdmin();
  const { data: trip } = await sb.from("trips").select("stops").eq("id", id).single();
  const prevStops = (trip?.stops as Stop[] | undefined) ?? [];
  const removed = prevStops.find((s) => s.id === stopId);
  const stops: Stop[] = prevStops.filter((s) => s.id !== stopId);
  const { error } = await sb.from("trips").update({ stops }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  logTripEvent({ trip_id: id, kind: "stop_removed", actor_token: ctx.token, payload: { stop_id: stopId } });
  void notifyDriverPlanChange({
    title: removed?.passenger ? `Pickup removed: ${removed.passenger}` : "Stop removed",
    body: removed?.address ?? "Trip route updated",
  });
  return NextResponse.json({ ok: true });
}
