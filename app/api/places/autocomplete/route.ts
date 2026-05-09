import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";
import { shortenAddress } from "@/lib/address-format";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim() ?? "";
  if (q.length < 3) return NextResponse.json({ results: [] });

  // SoCal + Las Vegas valley viewbox.
  const SOCAL_VIEWBOX = "-120.0,36.5,-114.5,32.5";
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&namedetails=1&limit=5&countrycodes=us&viewbox=${SOCAL_VIEWBOX}&bounded=1&q=${encodeURIComponent(q)}`,
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
      name?: string;
      address?: Record<string, string>;
    }>;
    return NextResponse.json({
      results: data.map((d) => ({
        lat: parseFloat(d.lat),
        lng: parseFloat(d.lon),
        display: shortenAddress(d) || d.display_name,
        category: d.class,
      })),
    });
  } catch {
    return NextResponse.json({ results: [] });
  }
}
