import { notFound } from "next/navigation";
import { requireMark } from "@/lib/auth";
import MarkApp from "@/components/apps/MarkApp";

export const dynamic = "force-dynamic";

export default async function MarkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  console.log(`[MarkPage] token len=${token?.length ?? 0} preview=${token?.slice(0, 6) ?? ""}…`);
  const ctx = await requireMark(token);
  console.log(`[MarkPage] ctx=${ctx ? `role=${ctx.role}, name=${ctx.name}` : "null"}`);
  if (!ctx) notFound();
  return <MarkApp token={ctx.token} name={ctx.name} />;
}
