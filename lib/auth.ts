import { customAlphabet } from "nanoid";
import { supabaseAdmin } from "./supabase";
import { Link, Role, SessionContext } from "./types";

const tokenAlphabet = "abcdefghjkmnpqrstuvwxyz23456789";
const generate = customAlphabet(tokenAlphabet, 24);
// Short 4-char tokens for TV-display URLs that have to be typed by remote control.
// Alphabet excludes ambiguous chars (i/l/1, o/0).
const generateShort = customAlphabet(tokenAlphabet, 4);

export function newToken(): string {
  return generate();
}

export function newShortToken(): string {
  return generateShort();
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

// Authorization predicate for trip-mutation endpoints (edit pickup/dropoff,
// add/remove stops, mint stop-passenger links, invite-guest, etc).
//
// Mark = always allowed.
// Passenger = allowed when their token's trip_id matches the trip being acted on.
// Anyone else (Dio, expired, mismatched-trip passenger) = rejected.
//
// Single-trip-mode means there is at most one active trip at a time. A stale
// passenger token from a completed trip will still resolve here as long as the
// link itself hasn't expired (16h window) AND the requested trip_id matches.
// Callers can layer their own status check on top if they want to forbid
// edits to a completed/cancelled trip.
export async function requireTripActor(
  token: string,
  tripId: string,
): Promise<SessionContext | null> {
  const ctx = await loadSession(token);
  if (!ctx) return null;
  if (ctx.role === "mark") return ctx;
  if (ctx.role === "passenger" && ctx.trip_id === tripId) return ctx;
  return null;
}
