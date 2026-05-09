import { notFound, redirect } from "next/navigation";
import { lookupLink } from "@/lib/auth";
import PassengerApp from "@/components/apps/PassengerApp";

export const dynamic = "force-dynamic";

export default async function PassengerPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { status, link } = await lookupLink(token);
  if (status === "missing") notFound();
  if (status === "expired" || status === "revoked") redirect("/expired");
  if (!link || link.role !== "passenger") notFound();
  return <PassengerApp token={link.token} name={link.name} />;
}
