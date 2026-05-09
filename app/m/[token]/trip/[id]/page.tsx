import { notFound } from "next/navigation";
import { requireMark } from "@/lib/auth";
import TripDetailApp from "@/components/apps/TripDetailApp";

export const dynamic = "force-dynamic";

export default async function TripDetailPage({
  params,
}: {
  params: Promise<{ token: string; id: string }>;
}) {
  const { token, id } = await params;
  const ctx = await requireMark(token);
  if (!ctx) notFound();
  return <TripDetailApp token={ctx.token} tripId={id} />;
}
