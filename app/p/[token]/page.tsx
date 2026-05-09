import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import PassengerApp from "@/components/apps/PassengerApp";

export const dynamic = "force-dynamic";

export default async function PassengerPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ctx = await requireRole(token, "passenger");
  if (!ctx) notFound();
  return <PassengerApp token={ctx.token} name={ctx.name} />;
}
