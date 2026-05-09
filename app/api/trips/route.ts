import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = supabaseAdmin();

  if (ctx.role === "mark") {
    const { data, error } = await sb
      .from("trips")
      .select("*")
      .order("scheduled_at", { ascending: false })
      .limit(50);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ trips: data });
  }

  if (ctx.role === "dio") {
    // Dio sees every non-finished trip, ordered by scheduled_at. Money fields
    // never returned. We deliberately don't filter by time — a trip Mark
    // scheduled for last night that didn't run is still relevant until Dio (or
    // Mark) marks it complete or cancelled.
    const { data, error } = await sb
      .from("trips")
      .select(
        "id,passenger_name,pickup_address,pickup_lat,pickup_lng,dropoff_address,dropoff_lat,dropoff_lng,scheduled_at,dispatched_at,arrived_at_pickup_at,onboard_at,arrived_at_dropoff_at,completed_at,status,notes,estimated_minutes,stops",
      )
      .not("status", "in", "(complete,cancelled)")
      .order("scheduled_at", { ascending: true })
      .limit(20);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ trips: data });
  }

  if (ctx.role === "passenger") {
    if (!ctx.trip_id) return NextResponse.json({ trips: [] });
    const { data, error } = await sb
      .from("trips")
      .select(
        "id,passenger_name,pickup_address,dropoff_address,scheduled_at,dispatched_at,arrived_at_pickup_at,onboard_at,arrived_at_dropoff_at,completed_at,status,estimated_minutes",
      )
      .eq("id", ctx.trip_id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ trips: data });
  }

  return NextResponse.json({ trips: [] });
}
