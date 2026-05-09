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
  const lat = url.searchParams.get("lat");
  const lng = url.searchParams.get("lng");
  if (!lat || !lng) return NextResponse.json({ error: "missing lat/lng" }, { status: 400 });

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&namedetails=1&lat=${lat}&lon=${lng}`,
      {
        headers: { "User-Agent": "SprinterOps/1.0 (mark@mnafinancial.com)" },
        cache: "no-store",
      },
    );
    if (!res.ok) return NextResponse.json({ display: `${lat},${lng}` });
    const data = (await res.json()) as {
      display_name?: string;
      name?: string;
      address?: Record<string, string>;
      class?: string;
    };
    return NextResponse.json({
      display: shortenAddress(data) || data.display_name || `${lat},${lng}`,
      lat: parseFloat(lat),
      lng: parseFloat(lng),
    });
  } catch {
    return NextResponse.json({ display: `${lat},${lng}` });
  }
}
