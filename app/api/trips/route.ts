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
    // Dio sees today's + active + upcoming, but never money fields
    const since = new Date(Date.now() - 12 * 3600_000).toISOString();
    const { data, error } = await sb
      .from("trips")
      .select(
        "id,passenger_name,pickup_address,pickup_lat,pickup_lng,dropoff_address,dropoff_lat,dropoff_lng,scheduled_at,dispatched_at,arrived_at_pickup_at,onboard_at,arrived_at_dropoff_at,completed_at,status,notes,estimated_minutes",
      )
      .gte("scheduled_at", since)
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
