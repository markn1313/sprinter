import { notFound } from "next/navigation";
import { requireMark } from "@/lib/auth";
import MarkApp from "@/components/apps/MarkApp";

export const dynamic = "force-dynamic";

export default async function MarkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await requireMark(token);
  if (!ctx) notFound();
  return <MarkApp token={ctx.token} name={ctx.name} />;
}
