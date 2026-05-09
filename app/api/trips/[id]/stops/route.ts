import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase";
import { geocode } from "@/lib/geocode";

interface Stop {
  id: string;
  kind: "pickup" | "dropoff" | "stop";
  category?: string;
  address: string;
  lat: number | null;
  lng: number | null;
  passenger?: string | null;
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
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role === "passenger") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as
    | {
        address?: string;
        lat?: number;
        lng?: number;
        kind?: "stop" | "pickup" | "dropoff";
        category?: string;
        passenger?: string;
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
  const { data: trip } = await sb.from("trips").select("stops").eq("id", id).single();
  const stops: Stop[] = (trip?.stops as Stop[] | undefined) ?? [];
  const newStop: Stop = {
    id: crypto.randomUUID(),
    kind: body.kind ?? "stop",
    category: body.category,
    address: display,
    lat,
    lng,
    passenger: body.passenger ?? null,
    added_at: new Date().toISOString(),
  };
  // Insert at requested index, or append if not specified / out of range
  const idx = typeof body.index === "number" ? Math.max(0, Math.min(stops.length, body.index)) : stops.length;
  stops.splice(idx, 0, newStop);
  const { error } = await sb.from("trips").update({ stops }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ stop: newStop });
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role === "passenger") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const stopId = url.searchParams.get("stop");
  if (!stopId) return NextResponse.json({ error: "missing stop id" }, { status: 400 });

  const sb = supabaseAdmin();
  const { data: trip } = await sb.from("trips").select("stops").eq("id", id).single();
  const stops: Stop[] = ((trip?.stops as Stop[] | undefined) ?? []).filter((s) => s.id !== stopId);
  const { error } = await sb.from("trips").update({ stops }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
