import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireMark } from "@/lib/auth";
import { SESSION_COOKIE } from "@/app/api/login/route";
import LoginForm from "@/components/LoginForm";

export const dynamic = "force-dynamic";

export default async function Home() {
  // Already signed in? Bounce straight to the dashboard.
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (token) {
    const ctx = await requireMark(token);
    if (ctx) redirect(`/m/${ctx.token}`);
  }
  return <LoginForm />;
}
