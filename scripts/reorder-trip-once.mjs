// One-shot: respect Mark's explicit ordering. He said "De La Nonna
// should come AFTER 2640 Magnolia." Pure haversine puts Magnolia
// farther from Newport (the LA freeway geometry doesn't match crow-
// flies distance), so any heuristic would fight him. Just do exactly
// what he said: De La Nonna becomes dropoff, current dropoff
// (2640 Magnolia) becomes an intermediate stop slotted before it.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

const { data: trip, error } = await sb
  .from("trips")
  .select(
    "id, status, dropoff_lat, dropoff_lng, dropoff_address, stops",
  )
  .in("status", ["scheduled", "dispatched", "at_pickup", "onboard", "at_dropoff"])
  .order("scheduled_at", { ascending: false })
  .limit(1)
  .maybeSingle();

if (error || !trip) {
  console.error("No active trip");
  process.exit(1);
}

console.log("Trip:", trip.id, trip.status);

const arrived = trip.stops.filter((s) => s.arrived_at != null);
const pending = trip.stops.filter((s) => s.arrived_at == null && s.lat != null);

// Find De La Nonna in pending stops
const nonnaIdx = pending.findIndex((s) =>
  s.address?.toLowerCase().includes("de la nonna"),
);
if (nonnaIdx < 0) {
  console.error("Couldn't find a 'De La Nonna' stop to promote.");
  console.error("Pending stops:", pending.map((s) => s.address));
  process.exit(1);
}
const nonna = pending[nonnaIdx];
const otherPending = pending.filter((_, i) => i !== nonnaIdx);

// Demote current dropoff to a stop. Insert it BEFORE De La Nonna in
// the intermediate stops list (after any other pending stops).
const demotedDropoffAsStop = {
  id: crypto.randomUUID(),
  kind: "stop",
  address: trip.dropoff_address,
  lat: trip.dropoff_lat,
  lng: trip.dropoff_lng,
  passenger: null,
  passenger_link_token: null,
  created_by_token: null,
  arrived_at: null,
  added_at: new Date().toISOString(),
};

const nextStops = [...arrived, ...otherPending, demotedDropoffAsStop];

console.log("\nNew layout:");
console.log("  Dropoff →", nonna.address);
console.log("  Stops:");
for (const [i, s] of nextStops.entries()) {
  console.log(`    [${i}] ${s.arrived_at ? "✓" : "·"} ${s.address}`);
}

const { error: updErr } = await sb
  .from("trips")
  .update({
    stops: nextStops,
    dropoff_lat: nonna.lat,
    dropoff_lng: nonna.lng,
    dropoff_address: nonna.address,
    route_polyline: null, // force ETA recompute
  })
  .eq("id", trip.id);
if (updErr) {
  console.error("Update failed:", updErr);
  process.exit(1);
}
console.log("\n✓ Trip rewritten. Map refreshes on next /api/eta poll (~20s).");
