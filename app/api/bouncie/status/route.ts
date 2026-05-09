import { NextResponse } from "next/server";
import { loadSession } from "@/lib/auth";
import { bouncieStatus } from "@/lib/bouncie";

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const token = auth?.replace(/^Bearer\s+/i, "") ?? "";
  const ctx = await loadSession(token);
  if (!ctx) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (ctx.role !== "mark") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const status = await bouncieStatus();
  return NextResponse.json(status);
}
