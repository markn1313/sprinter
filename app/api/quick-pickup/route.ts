import { NextResponse } from "next/server";
import { requireMark } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";

// One-tap "pick me up" — uses Mark's current GPS as pickup
export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | {
        lat?: number;
        lng?: number;
        address?: string;
        scheduled_at?: string;
        notes?: string;
        dropoff_address?: string;
        dropoff_lat?: number;
        dropoff_lng?: number;
      }
    | null;

  if (!body) return NextResponse.json({ error: "missing body" }, { status: 400 });

  const sb = supabaseAdmin();

  // Default scheduled time: now (immediate dispatch)
  const scheduledAt = body.scheduled_at ?? new Date().toISOString();

  const { data: trip, error } = await sb
    .from("trips")
    .insert({
      passenger_name: "Mark",
      pickup_address: body.address ?? "Mark's location",
      pickup_lat: body.lat ?? null,
      pickup_lng: body.lng ?? null,
      dropoff_address: body.dropoff_address ?? null,
      dropoff_lat: body.dropoff_lat ?? null,
      dropoff_lng: body.dropoff_lng ?? null,
      scheduled_at: scheduledAt,
      status: "scheduled",
      notes: body.notes ?? "Pick me up",
      created_by: ctx.token,
    })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Update Mark's live location too
  if (typeof body.lat === "number" && typeof body.lng === "number") {
    await sb
      .from("mark_location")
      .update({
        lat: body.lat,
        lng: body.lng,
        reported_at: new Date().toISOString(),
      })
      .eq("id", 1);
  }

  return NextResponse.json({ trip });
}
