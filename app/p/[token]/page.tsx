import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { lookupLink } from "@/lib/auth";
import MarkApp from "@/components/apps/MarkApp";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  return {
    manifest: `/p/${token}/manifest.webmanifest`,
    appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Sprinter" },
  };
}

// Passenger app = MarkApp with role="passenger". Single source of truth
// for the in-trip experience; the role prop gates the settings tab
// (passenger sees only push toggle) and the driver-chat tab (Mark↔Dio
// only). Trip-write endpoints are gated server-side via requireTripActor,
// which lets the passenger of the active trip edit pickup/dropoff/stops
// the same way Mark can — see lib/auth.ts.
export default async function PassengerPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { status, link } = await lookupLink(token);
  if (status === "missing") notFound();
  if (status === "expired" || status === "revoked") redirect("/expired");
  if (!link || link.role !== "passenger") notFound();
  return <MarkApp token={link.token} name={link.name} role="passenger" />;
}
