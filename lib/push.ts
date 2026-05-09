import webpush, { WebPushError } from "web-push";
import { supabaseAdmin } from "@/lib/supabase";

let configured = false;

function configure() {
  if (configured) return;
  const subj = process.env.VAPID_SUBJECT;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (subj && pub && priv) {
    webpush.setVapidDetails(subj, pub, priv);
    configured = true;
  }
}

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export async function sendPushToToken(token: string, payload: PushPayload): Promise<void> {
  configure();
  if (!configured) return;
  const sb = supabaseAdmin();
  const { data: subs } = await sb
    .from("push_subscriptions")
    .select("endpoint,p256dh,auth")
    .eq("token", token);
  if (!subs?.length) return;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(payload),
        );
        await sb
          .from("push_subscriptions")
          .update({ last_seen_at: new Date().toISOString() })
          .eq("endpoint", s.endpoint);
      } catch (e) {
        const err = e as WebPushError;
        if (err.statusCode === 410 || err.statusCode === 404) {
          await sb.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
        }
      }
    }),
  );
}

export async function sendPushToRole(
  role: "mark" | "dio",
  payload: PushPayload,
): Promise<void> {
  const sb = supabaseAdmin();
  const { data: linkRows } = await sb
    .from("links")
    .select("token")
    .eq("role", role)
    .is("revoked_at", null);
  if (!linkRows?.length) return;
  await Promise.all(linkRows.map((l) => sendPushToToken(l.token, payload)));
}

export async function sendPushToTripPassenger(
  tripId: string,
  payload: PushPayload,
): Promise<void> {
  const sb = supabaseAdmin();
  const { data: trip } = await sb
    .from("trips")
    .select("passenger_link_token")
    .eq("id", tripId)
    .maybeSingle();
  if (trip?.passenger_link_token) await sendPushToToken(trip.passenger_link_token, payload);
}
