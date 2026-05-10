import { supabaseAdmin } from "@/lib/supabase";
import { logTripEvent } from "@/lib/log";

// Cancel every non-complete / non-cancelled trip so the next INSERT lands as
// the single focal trip. Keeps the data layer aligned with single-trip mode
// in the UI: the focus selector won't pick up zombies anymore.
export async function cancelOpenTrips(actorToken: string): Promise<string[]> {
  const sb = supabaseAdmin();
  const { data } = await sb
    .from("trips")
    .select("id")
    .not("status", "in", "(complete,cancelled)");
  const ids = (data ?? []).map((r) => r.id as string);
  if (ids.length === 0) return [];
  await sb
    .from("trips")
    .update({ status: "cancelled", completed_at: new Date().toISOString() })
    .in("id", ids);
  // Mark associated guest links as revoked so old links stop working.
  await sb
    .from("links")
    .update({ revoked_at: new Date().toISOString() })
    .in("trip_id", ids);
  ids.forEach((id) =>
    logTripEvent({
      trip_id: id,
      kind: "auto_cancelled",
      actor_token: actorToken,
      payload: { reason: "single-trip-mode replaces previous open trip" },
    }),
  );
  return ids;
}
