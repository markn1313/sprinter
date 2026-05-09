import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (q.length < 3) return NextResponse.json({ results: [] });

  // Bias toward Southern California (LA/OC/IE/San Diego). viewbox = lon_left,lat_top,lon_right,lat_bottom.
  // `bounded=1` restricts results to that box. Anywhere outside SoCal would need to be typed
  // as a more specific query (city + state). This dramatically cuts down candidate results.
  const SOCAL_VIEWBOX = "-120.0,34.7,-115.5,32.5";
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=us&viewbox=${SOCAL_VIEWBOX}&bounded=1&q=${encodeURIComponent(q)}`,
      {
        headers: { "User-Agent": "SprinterOps/1.0 (mark@mnafinancial.com)" },
        cache: "no-store",
      },
    );
    if (!res.ok) return NextResponse.json({ results: [] });
    const data = (await res.json()) as Array<{
      lat: string;
      lon: string;
      display_name: string;
      class: string;
      type: string;
    }>;
    return NextResponse.json({
      results: data.map((d) => ({
        lat: parseFloat(d.lat),
        lng: parseFloat(d.lon),
        display: d.display_name,
        category: d.class,
      })),
    });
  } catch {
    return NextResponse.json({ results: [] });
  }
}
