import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireMark } from "@/lib/auth";
import MarkApp from "@/components/apps/MarkApp";

export const dynamic = "force-dynamic";

// Override the root manifest with a per-token one so iOS Add-to-Home-Screen
// captures /m/<token> as the start_url instead of "/" (the unauth landing).
export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  return {
    manifest: `/m/${token}/manifest.webmanifest`,
    appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Sprinter" },
  };
}

export default async function MarkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await requireMark(token);
  if (!ctx) notFound();
  return <MarkApp token={ctx.token} name={ctx.name} />;
}
