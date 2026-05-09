import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";
import { searchPlaces, categoryFromText, PlaceCategory } from "@/lib/places";
import { getVanPosition } from "@/lib/bouncie";

// Smart-stop suggestion endpoint.
// Given category + offset minutes, projects where the van will be in N minutes
// (using current heading + speed if no active route) and returns top 3 candidates.
export async function POST(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role === "passenger") return NextResponse.json({ error: "forbidden" }, { status: 403 });

  const body = (await req.json().catch(() => null)) as
    | { text?: string; category?: PlaceCategory; offset_minutes?: number }
    | null;
  if (!body) return NextResponse.json({ error: "missing body" }, { status: 400 });

  let category: PlaceCategory | null = body.category ?? null;
  if (!category && body.text) category = categoryFromText(body.text);
  if (!category) category = "coffee";

  const offsetMin = Math.max(1, Math.min(120, body.offset_minutes ?? 15));

  const pos = await getVanPosition();
  // Project ahead linearly using current heading + speed
  // If van is parked (speed_mph 0), search around the current position
  let anchorLat = pos.lat;
  let anchorLng = pos.lng;
  const speedMph = pos.speed_mph || 0;
  if (speedMph > 1) {
    const speedMps = speedMph * 0.44704;
    const distM = speedMps * offsetMin * 60;
    const headingRad = ((pos.heading || 0) * Math.PI) / 180;
    // Project: 1 deg lat ~= 111000 m
    const dLat = (distM * Math.cos(headingRad)) / 111000;
    const dLng = (distM * Math.sin(headingRad)) / (111000 * Math.cos((pos.lat * Math.PI) / 180));
    anchorLat = pos.lat + dLat;
    anchorLng = pos.lng + dLng;
  }

  const radius = Math.max(1500, Math.min(15000, 3000 + speedMph * 60)); // wider net at higher speed
  const places = await searchPlaces(category, { lat: anchorLat, lng: anchorLng }, radius, 12);

  // Scoring: prefer named places, prefer closer to projection
  const ranked = places
    .filter((p) => p.name && p.name !== "(unnamed)")
    .slice(0, 3)
    .map((p) => ({
      ...p,
      eta_to_stop_minutes: Math.round(
        (p.distance_m_from_anchor / 1000) / Math.max(15, speedMph) * 60,
      ),
    }));

  return NextResponse.json({
    category,
    offset_minutes: offsetMin,
    projected_anchor: { lat: anchorLat, lng: anchorLng },
    van_speed_mph: speedMph,
    suggestions: ranked,
  });
}
