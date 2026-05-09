import { NextResponse } from "next/server";
import { requireMark } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { geocode } from "@/lib/geocode";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | {
        passenger_name?: string;
        pickup_address?: string | null;
        pickup_lat?: number | null;
        pickup_lng?: number | null;
        dropoff_address?: string | null;
        dropoff_lat?: number | null;
        dropoff_lng?: number | null;
        scheduled_at?: string;
        notes?: string;
      }
    | null;
  if (!body) return NextResponse.json({ error: "missing body" }, { status: 400 });

  const update: Record<string, unknown> = {};
  if (typeof body.passenger_name === "string" && body.passenger_name.trim()) {
    update.passenger_name = body.passenger_name.trim();
  }
  if (typeof body.scheduled_at === "string") update.scheduled_at = body.scheduled_at;
  if (typeof body.notes === "string") update.notes = body.notes;

  // Pickup: if lat/lng explicitly provided, trust them (skip geocoding); else
  // if address is provided alone, geocode it.
  if (body.pickup_address !== undefined || body.pickup_lat !== undefined || body.pickup_lng !== undefined) {
    if (body.pickup_address) update.pickup_address = body.pickup_address;
    if (body.pickup_lat !== undefined && body.pickup_lng !== undefined) {
      update.pickup_lat = body.pickup_lat;
      update.pickup_lng = body.pickup_lng;
    } else if (body.pickup_address) {
      const g = await geocode(body.pickup_address);
      if (g) {
        update.pickup_address = g.display;
        update.pickup_lat = g.lat;
        update.pickup_lng = g.lng;
      } else {
        update.pickup_lat = null;
        update.pickup_lng = null;
      }
    } else if (body.pickup_address === null) {
      update.pickup_address = null;
      update.pickup_lat = null;
      update.pickup_lng = null;
    }
  }
  if (body.dropoff_address !== undefined || body.dropoff_lat !== undefined || body.dropoff_lng !== undefined) {
    if (body.dropoff_address) update.dropoff_address = body.dropoff_address;
    if (body.dropoff_lat !== undefined && body.dropoff_lng !== undefined) {
      update.dropoff_lat = body.dropoff_lat;
      update.dropoff_lng = body.dropoff_lng;
    } else if (body.dropoff_address) {
      const g = await geocode(body.dropoff_address);
      if (g) {
        update.dropoff_address = g.display;
        update.dropoff_lat = g.lat;
        update.dropoff_lng = g.lng;
      } else {
        update.dropoff_lat = null;
        update.dropoff_lng = null;
      }
    } else if (body.dropoff_address === null) {
      update.dropoff_address = null;
      update.dropoff_lat = null;
      update.dropoff_lng = null;
    }
  }

  const { data, error } = await supabaseAdmin()
    .from("trips")
    .update(update)
    .eq("id", id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ trip: data });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const sb = supabaseAdmin();
  // Revoke any guest links pointing at this trip first
  await sb.from("links").update({ revoked_at: new Date().toISOString() }).eq("trip_id", id);
  const { error } = await sb.from("trips").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
