// One-shot migration runner. Reads every .sql file in supabase/migrations/
// and applies it inside a single transaction. Gated by the service-role key
// so only the operator can call it. Delete this route once migrations are
// done — having a SQL-execution endpoint deployed is a footgun.
import { NextResponse } from "next/server";
import { Client } from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  // Accept the service-role key via Authorization header OR ?key=… —
  // Vercel's deployment-protection rewrite tends to strip Bearer headers
  // before our handler sees them.
  const auth = req.headers.get("authorization") ?? "";
  const headerKey = auth.replace(/^Bearer\s+/i, "");
  const url = new URL(req.url);
  const queryKey = url.searchParams.get("key") ?? "";
  const provided = headerKey || queryKey;
  if (!provided || provided !== process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json(
      {
        error: "unauthorized",
        hint: `header=${auth ? "yes" : "no"}, query=${queryKey ? "yes" : "no"}, env=${process.env.SUPABASE_SERVICE_ROLE_KEY ? "yes" : "no"}`,
      },
      { status: 401 },
    );
  }

  const rawConn = process.env.POSTGRES_URL_NON_POOLING ?? process.env.POSTGRES_URL;
  if (!rawConn) return NextResponse.json({ error: "no POSTGRES_URL" }, { status: 500 });
  // Strip any sslmode= from the URL so our explicit ssl: { rejectUnauthorized:
  // false } actually sticks. Supabase's intermediate cert isn't in Vercel's
  // Node trust store, so verify-full fails with SELF_SIGNED_CERT_IN_CHAIN.
  const conn = rawConn.replace(/[?&]sslmode=[^&]*/g, "").replace(/\?$/, "");

  const dir = join(process.cwd(), "supabase", "migrations");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    return NextResponse.json({ error: "no migrations dir" }, { status: 500 });
  }

  const client = new Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
  } catch (e) {
    return NextResponse.json(
      { error: "connect_failed", message: (e as Error).message, conn_preview: conn.replace(/(:\/\/[^:]+):[^@]+@/, "$1:***@") },
      { status: 500 },
    );
  }
  const applied: Array<{ file: string; ok: boolean; error?: string }> = [];
  try {
    for (const f of files) {
      const sql = await readFile(join(dir, f), "utf8");
      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("commit");
        applied.push({ file: f, ok: true });
      } catch (e) {
        await client.query("rollback").catch(() => {});
        applied.push({ file: f, ok: false, error: (e as Error).message });
        // Stop on first failure — migrations are sequential
        break;
      }
    }
  } finally {
    await client.end().catch(() => {});
  }
  return NextResponse.json({ applied });
}
