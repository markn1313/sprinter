import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { lookupLink } from "@/lib/auth";
import DioApp from "@/components/apps/DioApp";

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  return {
    manifest: `/d/${token}/manifest.webmanifest`,
    appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Driver" },
  };
}

export default async function DioPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { status, link } = await lookupLink(token);
  if (status === "missing") notFound();
  if (status === "expired" || status === "revoked") redirect("/expired");
  if (!link || link.role !== "dio") notFound();
  return <DioApp token={link.token} name={link.name} />;
}
