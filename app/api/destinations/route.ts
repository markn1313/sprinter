// /api/destinations — the ONE endpoint behind the passenger's
// "Where to?" box. Designed so the user genuinely cannot mess it up:
//
//  1. Bootstrap-or-append decided server-side. No active trip + the
//     requester is in the van? → create one with status="onboard",
//     pickup = van's current GPS, this destination as the first
//     element. Active trip exists? → append, server runs the Mapbox
//     optimizer, returns the canonical ordering.
//
//  2. Three failure modes, all distinct + handled by the client:
//        409 TRIP_FINAL    — completed trip; client auto-resubmits with
//                            forceNew=true to start a fresh trip.
//        403 NOT_IN_VAN    — bootstrap denied (phone GPS too far from
//                            van OR GPS denied with no override). Client
//                            shows "I'm in the van" button → resubmits
//                            with override="in_van".
//        400 OUT_OF_AREA   — geocode resolved outside the SoCal bbox.
//                            Client shows "address looks wrong" toast.
//
//  3. Idempotency: every POST carries an Idempotency-Key. Replays return
//     the cached response — double-tap + offline-queue replay are safe.
//
//  4. Always dual-writes pickup_*/dropoff_* on the trip row so the
//     legacy state machine / readers keep working during the cutover.
//     Phase 3 of the destinations rewrite removes the dual-write.
//
// Auth: trip-actor (Mark or trip's passenger) for append; passenger-link
// with GPS-in-van proof for bootstrap. Mark can always bootstrap.

import { NextResponse } from "next/server";
import { loadSession, requireTripActor } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { geocode, reverseGeocode } from "@/lib/geocode";
import { getVanPosition } from "@/lib/bouncie";
import { optimizeStops } from "@/lib/routing";
import { logTripEvent } from "@/lib/log";
import { notifyDriverPlanChange } from "@/lib/push";
import { cancelOpenTrips } from "@/lib/single-trip";
import { getCached, setCached, readIdempotencyKey } from "@/lib/idempotency";
import { isInServiceArea, distanceMeters } from "@/lib/geo-bounds";
import { classifyEntry } from "@/lib/classify-destination-entry";

interface Stop {
  id: string;
  kind: "pickup" | "dropoff" | "stop";
  category?: string;
  address: string;
  lat: number | null;
  lng: number | null;
  passenger?: string | null;
  passenger_link_token?: string | null;
  created_by_token?: string | null;
  arrived_at?: string | null;
  added_at: string;
}

interface DestinationsBody {
  // Either lat+lng (pin drop) OR address (typed). At least one required.
  lat?: number;
  lng?: number;
  address?: string;
  // Required for idempotency. Client generates a fresh UUID per user
  // action; replays of the same action carry the same key.
  idempotencyKey?: string;
  // Set true when the client is auto-resubmitting after a 409
  // TRIP_FINAL. Forces creation of a new trip even if an active one
  // exists (it doesn't, in practice — but defensive).
  forceNew?: boolean;
  // Bootstrap override when phone GPS is denied/stale. Client only
  // sends this after explicitly asking the user "are you in the van?".
  override?: "in_van";
  // Optional passenger name for the bootstrap case (the new trip's
  // passenger_name field). Falls back to the link's stored name.
  passengerName?: string;
}

// How far a phone GPS can be from the van's last GPS for the bootstrap
// proximity check to succeed. 150m is generous — covers GPS jitter and
// the typical "I just got in but my phone is still settling" case while
// still rejecting "I'm at home and tapped the link by accident."
const BOOTSTRAP_PROXIMITY_M = 150;

// How old the van's last GPS ping can be and still count as "live."
// Beyond this we degrade to the override path so a stale Bouncie feed
// doesn't block a real passenger in the van.
const VAN_GPS_FRESH_MS = 5 * 60 * 1000;

export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  if (!token) return jsonErr(401, "unauthorized", "Missing token.");

  // Idempotency dedupe — return the cached response immediately if we
  // saw this (token, key) recently. Cache is keyed inside the helper.
  const idemKey = readIdempotencyKey(req);
  if (idemKey) {
    const cached = getCached<{ status: number; body: unknown }>(token, idemKey);
    if (cached) return NextResponse.json(cached.body, { status: cached.status });
  }

  const body = (await req.json().catch(() => null)) as DestinationsBody | null;
  if (!body) return jsonErr(400, "bad_body", "Body missing or not JSON.");
  if (body.lat == null && body.lng == null && !body.address?.trim()) {
    return jsonErr(400, "bad_body", "Need lat+lng or an address.");
  }

  // Phone GPS — sent separately via a header so it isn't conflated with
  // the destination's lat/lng. Format: "lat,lng,age_seconds". Optional.
  const phoneGps = parsePhoneGps(req.headers.get("X-Phone-GPS"));

  // Auth resolution:
  //   1. Mark token → always allowed (driver/owner).
  //   2. Passenger token bound to an active trip → trip-actor path.
  //   3. Passenger token NOT yet bound (generic "Van tracker" link) →
  //      bootstrap path; we verify she's in the van below.
  const session = await loadSession(token);
  if (!session) return jsonErr(401, "unauthorized", "Link expired or revoked.");

  const sb = supabaseAdmin();

  // Locate the active trip. Either via the session's bound trip_id, or
  // (for Mark) by finding any non-terminal trip. forceNew skips this.
  const activeTrip = body.forceNew ? null : await findActiveTrip(sb, session);

  // -------- APPEND PATH ---------------------------------------------
  if (activeTrip) {
    // The trip exists but is in a terminal state? Send 409 so the client
    // can auto-resubmit with forceNew=true.
    if (activeTrip.status === "complete" || activeTrip.status === "cancelled") {
      return jsonErr(409, "TRIP_FINAL", "Trip already ended.");
    }
    // Authorize the actor against this specific trip.
    const actor = await requireTripActor(token, activeTrip.id);
    if (!actor) return jsonErr(403, "forbidden", "Not your trip.");

    const resolved = await resolveDestination(body);
    if (resolved.kind === "error") return jsonErr(resolved.status, resolved.code, resolved.message);

    const result = await appendDestination(sb, activeTrip, resolved, token);
    if (idemKey) setCached(token, idemKey, { status: 200, body: result });
    return NextResponse.json(result);
  }

  // -------- BOOTSTRAP PATH ------------------------------------------
  // Only proceed if we can prove the requester is physically in the
  // van. Mark is always allowed (he can dispatch from anywhere).
  if (session.role !== "mark") {
    const proof = await proveInVan(phoneGps, body.override);
    if (!proof.ok) {
      return jsonErr(403, "NOT_IN_VAN", proof.reason);
    }
  }

  const resolved = await resolveDestination(body);
  if (resolved.kind === "error") return jsonErr(resolved.status, resolved.code, resolved.message);

  const result = await bootstrapTrip(sb, session, resolved, token, body.passengerName ?? null);
  if (idemKey) setCached(token, idemKey, { status: 200, body: result });
  return NextResponse.json(result);
}

// ===================================================================
// Helpers
// ===================================================================

interface ActiveTrip {
  id: string;
  status: string;
  pickup_lat: number | null;
  pickup_lng: number | null;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  stops: Stop[] | null;
  passenger_link_token: string | null;
}

async function findActiveTrip(
  sb: ReturnType<typeof supabaseAdmin>,
  session: { token: string; role: string; trip_id: string | null },
): Promise<ActiveTrip | null> {
  // Passenger session: ALWAYS look up by the session's bound trip_id —
  // never by status. If that trip is terminal we want to surface the
  // 409 (so the client knows to start a new one) rather than silently
  // creating one without telling them.
  if (session.role === "passenger" && session.trip_id) {
    const { data } = await sb
      .from("trips")
      .select(
        "id,status,pickup_lat,pickup_lng,dropoff_lat,dropoff_lng,stops,passenger_link_token",
      )
      .eq("id", session.trip_id)
      .maybeSingle();
    return (data as ActiveTrip | null) ?? null;
  }
  // Mark / generic-passenger session with no trip_id: look for any
  // non-terminal trip (single-trip mode says there's at most one).
  const { data } = await sb
    .from("trips")
    .select("id,status,pickup_lat,pickup_lng,dropoff_lat,dropoff_lng,stops,passenger_link_token")
    .not("status", "in", "(complete,cancelled)")
    .order("created_at", { ascending: false })
    .limit(1);
  const row = (data?.[0] as ActiveTrip | undefined) ?? null;
  return row;
}

interface ResolvedDestination {
  kind: "ok";
  lat: number;
  lng: number;
  address: string;
  category: string | null;
}
interface ResolveError {
  kind: "error";
  status: number;
  code: string;
  message: string;
}

async function resolveDestination(
  body: DestinationsBody,
): Promise<ResolvedDestination | ResolveError> {
  // Pin-drop path: lat/lng provided directly. Skip the classifier
  // entirely. Reverse-geocode for a display string.
  if (typeof body.lat === "number" && typeof body.lng === "number") {
    if (!isInServiceArea(body.lat, body.lng)) {
      return {
        kind: "error",
        status: 400,
        code: "OUT_OF_AREA",
        message: "That spot is outside our service area.",
      };
    }
    let address = body.address?.trim();
    if (!address) {
      address = (await reverseGeocode(body.lat, body.lng)) ?? `${body.lat.toFixed(5)}, ${body.lng.toFixed(5)}`;
    }
    return { kind: "ok", lat: body.lat, lng: body.lng, address, category: null };
  }

  // Address-only path: classify (default to address, fall back to LLM
  // for natural language), then geocode.
  const raw = (body.address ?? "").trim();
  if (!raw) {
    return { kind: "error", status: 400, code: "bad_body", message: "Need an address." };
  }
  const classified = await classifyEntry(raw);
  if (classified.kind === "unclear") {
    return {
      kind: "error",
      status: 400,
      code: "UNCLEAR",
      message: "Couldn't understand that — try a street address.",
    };
  }
  const addressToGeocode =
    classified.kind === "address"
      ? classified.address
      : (classified.address ?? classified.category ?? raw);
  const geo = await geocode(addressToGeocode);
  if (!geo) {
    return {
      kind: "error",
      status: 400,
      code: "NOT_FOUND",
      message: "Couldn't find that place. Try a more specific address.",
    };
  }
  if (!isInServiceArea(geo.lat, geo.lng)) {
    return {
      kind: "error",
      status: 400,
      code: "OUT_OF_AREA",
      message: "That address is outside our service area.",
    };
  }
  return {
    kind: "ok",
    lat: geo.lat,
    lng: geo.lng,
    address: geo.display,
    category: classified.kind === "stop_request" ? classified.category : null,
  };
}

async function appendDestination(
  sb: ReturnType<typeof supabaseAdmin>,
  trip: ActiveTrip,
  d: ResolvedDestination,
  actorToken: string,
) {
  const stops: Stop[] = trip.stops ?? [];
  const newStop: Stop = {
    id: crypto.randomUUID(),
    kind: "stop",
    category: d.category ?? undefined,
    address: d.address,
    lat: d.lat,
    lng: d.lng,
    passenger: null,
    created_by_token: actorToken,
    arrived_at: null,
    added_at: new Date().toISOString(),
  };

  // Append + auto-optimize the PENDING (un-arrived) stops via Mapbox.
  // Arrived stops stay pinned in their historical order.
  const arrived = stops.filter((s) => s.arrived_at != null);
  const pending = stops.filter((s) => s.arrived_at == null);
  pending.push(newStop);

  let finalStops: Stop[] = [...arrived, ...pending];
  if (
    pending.length >= 2 &&
    trip.pickup_lat != null &&
    trip.pickup_lng != null &&
    trip.dropoff_lat != null &&
    trip.dropoff_lng != null
  ) {
    // Optimize from current progress point: last arrived stop if any,
    // else trip's pickup. Destination anchor for optimizer = current
    // dropoff. After optimization, last pending becomes the new dropoff
    // (see dual-write below).
    const startPoint =
      arrived.length > 0
        ? { lat: arrived[arrived.length - 1].lat as number, lng: arrived[arrived.length - 1].lng as number }
        : { lat: trip.pickup_lat, lng: trip.pickup_lng };
    const optimized = await optimizeStops(
      startPoint,
      { lat: trip.dropoff_lat, lng: trip.dropoff_lng },
      pending.map((s) => ({ lat: s.lat as number, lng: s.lng as number })),
    );
    if (optimized) {
      const remaining = pending.slice();
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
      finalStops = [...arrived, ...reordered, ...remaining];
    }
  }

  // Dual-write: legacy pickup_*/dropoff_* derived from chain ends so
  // the existing state machine, TV view, and any unmigrated reader keep
  // working. First non-arrived = pickup (or first overall if all
  // arrived); last = dropoff. Phase 3 removes the dual-write.
  const first = finalStops[0];
  const last = finalStops[finalStops.length - 1];
  const updates: Record<string, unknown> = {
    stops: finalStops,
    pickup_address: first?.address ?? null,
    pickup_lat: first?.lat ?? null,
    pickup_lng: first?.lng ?? null,
    dropoff_address: last?.address ?? null,
    dropoff_lat: last?.lat ?? null,
    dropoff_lng: last?.lng ?? null,
  };

  const { error } = await sb.from("trips").update(updates).eq("id", trip.id);
  if (error) throw new Error(`trip update failed: ${error.message}`);

  logTripEvent({
    trip_id: trip.id,
    kind: "destination_added",
    actor_token: actorToken,
    payload: { stop: newStop, optimized: finalStops.length > 0 },
  });
  void notifyDriverPlanChange({
    title: "New destination",
    body: d.address,
  });

  return { trip_id: trip.id, stops: finalStops, stop: newStop, bootstrapped: false };
}

async function bootstrapTrip(
  sb: ReturnType<typeof supabaseAdmin>,
  session: { token: string; role: string; name: string; trip_id: string | null },
  d: ResolvedDestination,
  actorToken: string,
  passengerNameOverride: string | null,
) {
  // Single-trip-mode invariant — cancel anything still open from a
  // prior session (shouldn't be any in the bootstrap path, defensive).
  await cancelOpenTrips(actorToken);

  // Pickup = van's current GPS, since the requester just got in.
  const van = await getVanPosition();
  const pickupAddress =
    (await reverseGeocode(van.lat, van.lng)) ?? `${van.lat.toFixed(5)}, ${van.lng.toFixed(5)}`;
  const nowIso = new Date().toISOString();

  const passengerName =
    passengerNameOverride?.trim() ||
    (session.name && session.name !== "Van tracker" ? session.name : null) ||
    "Passenger";

  const pickupStop: Stop = {
    id: crypto.randomUUID(),
    kind: "stop",
    address: pickupAddress,
    lat: van.lat,
    lng: van.lng,
    passenger: passengerName,
    created_by_token: actorToken,
    arrived_at: nowIso, // she's IN the van, so pickup already happened
    added_at: nowIso,
  };
  const destStop: Stop = {
    id: crypto.randomUUID(),
    kind: "stop",
    category: d.category ?? undefined,
    address: d.address,
    lat: d.lat,
    lng: d.lng,
    passenger: null,
    created_by_token: actorToken,
    arrived_at: null,
    added_at: nowIso,
  };
  const stops: Stop[] = [pickupStop, destStop];

  // Bind the requester's link as the trip's passenger_link_token so
  // the link continues to work and trip-actor auth resolves on future
  // requests. Mark's session has no link to bind (he's bootstrapping
  // for someone else? — rare; leave null in that case).
  const linkToken = session.role === "passenger" ? session.token : null;

  const { data: trip, error } = await sb
    .from("trips")
    .insert({
      passenger_name: passengerName,
      passenger_link_token: linkToken,
      pickup_address: pickupAddress,
      pickup_lat: van.lat,
      pickup_lng: van.lng,
      dropoff_address: d.address,
      dropoff_lat: d.lat,
      dropoff_lng: d.lng,
      scheduled_at: nowIso,
      dispatched_at: nowIso,
      arrived_at_pickup_at: nowIso,
      onboard_at: nowIso,
      status: "onboard",
      notes: "Self-dispatched via /api/destinations",
      created_by: actorToken,
      stops,
    })
    .select()
    .single();
  if (error) throw new Error(`trip insert failed: ${error.message}`);

  // Attach the link to the new trip so subsequent posts resolve as
  // trip-actor and don't have to re-do the proximity check.
  if (linkToken) {
    await sb.from("links").update({ trip_id: trip.id }).eq("token", linkToken);
  }

  logTripEvent({
    trip_id: trip.id,
    kind: "created",
    actor_token: actorToken,
    payload: { bootstrap: true, destination: d.address, pickup: pickupAddress },
  });
  void notifyDriverPlanChange({
    title: "Pickup in progress",
    body: `${passengerName} → ${d.address}`,
  });

  return { trip_id: trip.id, stops, stop: destStop, bootstrapped: true };
}

// =============================================================
// Proximity proof: is the requester actually in the van?
// =============================================================
interface PhoneGps {
  lat: number;
  lng: number;
  ageMs: number;
}
function parsePhoneGps(header: string | null): PhoneGps | null {
  if (!header) return null;
  const parts = header.split(",").map((s) => s.trim());
  if (parts.length < 2) return null;
  const lat = Number(parts[0]);
  const lng = Number(parts[1]);
  const ageSec = parts[2] != null ? Number(parts[2]) : 0;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, ageMs: Math.max(0, ageSec * 1000) };
}

async function proveInVan(
  phone: PhoneGps | null,
  override: string | undefined,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Explicit user override after we asked "are you in the van?".
  // Trusted on the honor system — far better than blocking forever
  // when phone GPS is denied or the van's Bouncie feed is lagging.
  if (override === "in_van") return { ok: true };

  if (!phone) {
    return { ok: false, reason: "Need phone GPS to confirm you're in the van. Try again or tap 'I'm in the van'." };
  }
  // Stale phone GPS is meaningless for proximity.
  if (phone.ageMs > 60 * 1000) {
    return { ok: false, reason: "Phone GPS is stale. Try again or tap 'I'm in the van'." };
  }

  let van;
  try {
    van = await getVanPosition();
  } catch {
    return { ok: false, reason: "Van GPS unavailable. Tap 'I'm in the van' to continue." };
  }
  // Van position could itself be cached/stale. We treat >5 min as stale
  // and fall through to the override path.
  const vanAgeMs = van.updated_at ? Date.now() - new Date(van.updated_at).getTime() : Infinity;
  if (vanAgeMs > VAN_GPS_FRESH_MS) {
    return { ok: false, reason: "Van hasn't pinged recently. Tap 'I'm in the van' to continue." };
  }

  const dist = distanceMeters(phone, { lat: van.lat, lng: van.lng });
  if (dist <= BOOTSTRAP_PROXIMITY_M) return { ok: true };
  return {
    ok: false,
    reason: `You're ~${Math.round(dist)}m from the van. Get in first, or tap 'I'm in the van'.`,
  };
}

function jsonErr(status: number, code: string, message: string) {
  return NextResponse.json({ error: code, message }, { status });
}
