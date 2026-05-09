import { customAlphabet } from "nanoid";
import { supabaseAdmin } from "./supabase";
import { Link, Role, SessionContext } from "./types";

const tokenAlphabet = "abcdefghjkmnpqrstuvwxyz23456789";
const generate = customAlphabet(tokenAlphabet, 24);

export function newToken(): string {
  return generate();
}

export type LinkStatus = "missing" | "expired" | "revoked" | "valid";

export interface LinkLookup {
  status: LinkStatus;
  link: Link | null;
}

// Raw lookup that distinguishes between "doesn't exist", "expired", "revoked",
// and "valid". Use this when you want to render an expired-specific page.
export async function lookupLink(token: string): Promise<LinkLookup> {
  if (!token) return { status: "missing", link: null };
  const sb = supabaseAdmin();
  const { data, error } = await sb.from("links").select("*").eq("token", token).maybeSingle();
  if (error || !data) return { status: "missing", link: null };
  const link = data as Link;
  if (link.revoked_at) return { status: "revoked", link };
  if (link.expires_at && new Date(link.expires_at).getTime() < Date.now()) {
    return { status: "expired", link };
  }
  return { status: "valid", link };
}

export async function loadSession(token: string): Promise<SessionContext | null> {
  const { status, link } = await lookupLink(token);
  if (status !== "valid" || !link) return null;
  return {
    token: link.token,
    role: link.role,
    name: link.name,
    trip_id: link.trip_id,
  };
}

export async function requireRole(token: string, role: Role): Promise<SessionContext | null> {
  const ctx = await loadSession(token);
  if (!ctx) return null;
  if (ctx.role !== role) return null;
  return ctx;
}

export async function requireMark(token: string): Promise<SessionContext | null> {
  return requireRole(token, "mark");
}

export async function requireDioOrMark(token: string): Promise<SessionContext | null> {
  const ctx = await loadSession(token);
  if (!ctx) return null;
  if (ctx.role !== "mark" && ctx.role !== "dio") return null;
  return ctx;
}
