import { notFound } from "next/navigation";
import { loadSession } from "@/lib/auth";
import TvApp from "@/components/apps/TvApp";

export const dynamic = "force-dynamic";

export default async function TvPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await loadSession(token);
  if (!ctx) notFound();
  // Allow Mark or a dedicated TV link
  if (ctx.role !== "tv" && ctx.role !== "mark") notFound();
  return <TvApp token={ctx.token} />;
}
