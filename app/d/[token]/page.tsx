import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import DioApp from "@/components/apps/DioApp";

export const dynamic = "force-dynamic";

export default async function DioPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await requireRole(token, "dio");
  if (!ctx) notFound();
  return <DioApp token={ctx.token} name={ctx.name} />;
}
