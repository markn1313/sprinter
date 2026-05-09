// Per-token PWA manifest. iOS captures the manifest at Add-to-Home-Screen
// time and uses its start_url. Without this, every install would launch to
// "/" (the unauth landing page) instead of the owner's authed view.
import { NextResponse } from "next/server";
import { requireMark } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const ctx = await requireMark(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(
    {
      name: "Sprinter — Owner",
      short_name: "Sprinter",
      start_url: `/m/${token}`,
      scope: `/m/${token}`,
      display: "standalone",
      background_color: "#0a0a0a",
      theme_color: "#0a0a0a",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    },
    { headers: { "Content-Type": "application/manifest+json" } },
  );
}
