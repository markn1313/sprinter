import { VanPosition } from "./types";
import { supabaseAdmin } from "./supabase";

const HOME_LAT = 33.6189;
const HOME_LNG = -117.9298;

const BOUNCIE_API = "https://api.bouncie.dev/v1";
const BOUNCIE_TOKEN_URL = "https://auth.bouncie.com/oauth/token";

interface BouncieVehicle {
  vin: string;
  nickName?: string;
  model?: { make: string; name: string; year: number };
  stats?: {
    location?: { lat: number; lon: number };
    heading?: number;
    speed?: number;
    fuelLevel?: number;
    odometer?: number;
    isRunning?: boolean;
    lastUpdated?: string;
  };
}

interface BouncieCreds {
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  vehicle_vin: string | null;
  imei: string | null;
}

async function loadCreds(): Promise<BouncieCreds | null> {
  try {
    const { data } = await supabaseAdmin()
      .from("bouncie_credentials")
      .select("access_token,refresh_token,expires_at,vehicle_vin,imei")
      .eq("id", 1)
      .maybeSingle();
    return (data as BouncieCreds) ?? null;
  } catch {
    return null;
  }
}

async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
} | null> {
  const clientId = process.env.BOUNCIE_CLIENT_ID;
  const clientSecret = process.env.BOUNCIE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(BOUNCIE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    console.warn(`[bouncie] refresh failed status=${res.status} body=${text.slice(0, 300)}`);
    return null;
  }
  try {
    return JSON.parse(text) as { access_token: string; refresh_token?: string; expires_in?: number };
  } catch {
    console.warn(`[bouncie] refresh 200 but non-JSON: ${text.slice(0, 300)}`);
    return null;
  }
}

// Refresh proactively 10 minutes before expiry, not 1 minute, so the token
// is renewed when it's still valid. With short-lived Vercel functions this
// also means callers within that 10-min window all hit the warm cached token.
const PROACTIVE_REFRESH_SKEW_MS = 10 * 60_000;
// Only one instance refreshes at a time — if another just claimed the slot
// in the last 30s, we wait briefly and re-read instead of double-refreshing
// (which Bouncie rejects because the rotated refresh_token is consumed).
const CLAIM_WINDOW_MS = 30_000;

async function ensureFreshToken(): Promise<string | null> {
  const creds = await loadCreds();
  if (!creds?.access_token) return null;
  const expiresAt = creds.expires_at ? new Date(creds.expires_at).getTime() : null;
  if (!expiresAt || expiresAt - Date.now() > PROACTIVE_REFRESH_SKEW_MS) {
    return creds.access_token;
  }
  if (!creds.refresh_token) return creds.access_token;

  const sb = supabaseAdmin();
  const claimCutoff = new Date(Date.now() - CLAIM_WINDOW_MS).toISOString();
  const claimedAt = new Date().toISOString();

  // Atomic claim: bump last_refreshed_at to now ONLY if no one else just did
  // it within the claim window. Update affects 0 rows when we lose the race.
  const { data: claimRows, error: claimErr } = await sb
    .from("bouncie_credentials")
    .update({ last_refreshed_at: claimedAt })
    .eq("id", 1)
    .or(`last_refreshed_at.lt.${claimCutoff},last_refreshed_at.is.null`)
    .select("id");

  if (claimErr) {
    console.warn(`[bouncie] claim failed: ${claimErr.message}`);
    return creds.access_token;
  }

  if (!claimRows || claimRows.length === 0) {
    // Another invocation is refreshing — wait briefly and use whatever
    // they save. Better than racing them to invalid_grant.
    await new Promise((r) => setTimeout(r, 1200));
    const latest = await loadCreds();
    return latest?.access_token ?? creds.access_token;
  }

  // We won the claim. Re-read so we use the freshest refresh_token possible
  // (in case it was rotated in a hand-off we missed).
  const latest = (await loadCreds()) ?? creds;
  const rt = latest.refresh_token ?? creds.refresh_token;
  if (!rt) return creds.access_token;

  const refreshed = await refreshAccessToken(rt);
  if (!refreshed) {
    // Refresh actually failed (Bouncie 4xx/5xx). Don't blow away the existing
    // token — the cached-position fallback will keep the UI honest until the
    // next successful refresh attempt.
    console.warn("[bouncie] refresh failed, keeping existing token");
    return latest.access_token ?? creds.access_token;
  }
  const newExpires = refreshed.expires_in
    ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
    : null;
  await sb
    .from("bouncie_credentials")
    .update({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token ?? rt,
      expires_at: newExpires,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
  return refreshed.access_token;
}

export async function fetchBouncieVehicle(): Promise<(VanPosition & { vin?: string; nickname?: string }) | null> {
  const token = await ensureFreshToken();
  if (!token) return null;
  const creds = await loadCreds();

  try {
    const url = creds?.vehicle_vin
      ? `${BOUNCIE_API}/vehicles?vin=${encodeURIComponent(creds.vehicle_vin)}`
      : `${BOUNCIE_API}/vehicles`;
    const res = await fetch(url, {
      headers: { Authorization: token },
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn("Bouncie API error", res.status, await res.text());
      return null;
    }
    const data = (await res.json()) as BouncieVehicle[];
    const vehicle = creds?.vehicle_vin
      ? data.find((v) => v.vin === creds.vehicle_vin) ?? data[0]
      : data[0];
    if (!vehicle?.stats?.location) return null;
    return {
      lat: vehicle.stats.location.lat,
      lng: vehicle.stats.location.lon,
      heading: vehicle.stats.heading ?? 0,
      speed_mph: vehicle.stats.speed ?? 0,
      fuel_pct: vehicle.stats.fuelLevel != null ? vehicle.stats.fuelLevel / 100 : null,
      battery_v: null,
      mileage: vehicle.stats.odometer ?? null,
      ignition: vehicle.stats.isRunning ?? false,
      updated_at: vehicle.stats.lastUpdated ?? new Date().toISOString(),
      vin: vehicle.vin,
      nickname: vehicle.nickName,
    };
  } catch (err) {
    console.warn("Bouncie fetch threw", err);
    return null;
  }
}

function mockPosition(): VanPosition {
  const t = Date.now() / 1000;
  const radius = 0.005;
  const orbit = (t / 120) % (Math.PI * 2);
  return {
    lat: HOME_LAT + Math.cos(orbit) * radius,
    lng: HOME_LNG + Math.sin(orbit) * radius,
    heading: ((orbit * 180) / Math.PI) % 360,
    speed_mph: 0,
    fuel_pct: 0.78,
    battery_v: 12.6,
    mileage: 18420,
    ignition: false,
    updated_at: new Date().toISOString(),
  };
}

// Fall back ladder: live Bouncie → last-known good Bouncie ping (logged to
// vehicle_positions) → orbiting mock. The last-known-good path matters most
// when the OAuth token has expired — better to show stale-but-real data
// than to put the van back at home with 78% fuel.
export async function getVanPosition(): Promise<VanPosition & { source: "bouncie" | "bouncie_cached" | "mock" }> {
  const live = await fetchBouncieVehicle();
  if (live) return { ...live, source: "bouncie" };

  try {
    const { data } = await supabaseAdmin()
      .from("vehicle_positions")
      .select("lat,lng,heading,speed_mph,fuel_pct,ignition,mileage,recorded_at")
      .eq("source", "bouncie")
      .order("recorded_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data && data.lat != null && data.lng != null) {
      return {
        lat: data.lat as number,
        lng: data.lng as number,
        heading: (data.heading as number) ?? 0,
        speed_mph: 0, // last-known ping isn't "current" speed
        fuel_pct: (data.fuel_pct as number) ?? null,
        battery_v: null,
        mileage: (data.mileage as number) ?? null,
        ignition: (data.ignition as boolean) ?? false,
        updated_at: (data.recorded_at as string) ?? new Date().toISOString(),
        source: "bouncie_cached",
      };
    }
  } catch {
    // ignore — fall through to mock
  }

  return { ...mockPosition(), source: "mock" };
}

export interface BouncieStatus {
  connected: boolean;
  stale: boolean;
  vehicle_vin: string | null;
  vehicle_nickname: string | null;
  expires_at: string | null;
  source: "bouncie" | "bouncie_cached" | "mock";
}

export async function bouncieStatus(): Promise<BouncieStatus> {
  const creds = await loadCreds();
  const hasToken = !!creds?.access_token;
  const expiresAt = creds?.expires_at ? new Date(creds.expires_at).getTime() : null;
  // Stale = token exists but expired more than 2 minutes ago (gives the
  // auto-refresh a chance before flagging as broken).
  const stale = hasToken && expiresAt != null && expiresAt < Date.now() - 2 * 60_000;
  return {
    connected: hasToken && !stale,
    stale,
    vehicle_vin: creds?.vehicle_vin ?? null,
    vehicle_nickname: null,
    expires_at: creds?.expires_at ?? null,
    source: hasToken ? "bouncie" : "mock",
  };
}

export function bouncieAuthUrl(redirectUri: string, state: string): string {
  const clientId = process.env.BOUNCIE_CLIENT_ID;
  if (!clientId) throw new Error("BOUNCIE_CLIENT_ID not set");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });
  return `https://auth.bouncie.com/dialog/authorize?${params.toString()}`;
}

export interface ExchangeResult {
  ok: true;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export interface ExchangeError {
  ok: false;
  reason: string;
}

export async function exchangeAuthCode(
  code: string,
  redirectUri: string,
): Promise<ExchangeResult | ExchangeError> {
  const clientId = process.env.BOUNCIE_CLIENT_ID;
  const clientSecret = process.env.BOUNCIE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return { ok: false, reason: "BOUNCIE_CLIENT_ID/SECRET not set" };
  }

  // Try multiple body shapes — different OAuth providers expect different things
  const attempts: { label: string; init: RequestInit }[] = [
    {
      label: "form-with-creds",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }).toString(),
      },
    },
    {
      label: "json-with-creds",
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }),
      },
    },
    {
      label: "form-with-basic-auth",
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }).toString(),
      },
    },
  ];

  const errors: string[] = [];
  for (const a of attempts) {
    try {
      const res = await fetch(BOUNCIE_TOKEN_URL, a.init);
      const text = await res.text();
      if (res.ok) {
        try {
          const json = JSON.parse(text) as {
            access_token: string;
            refresh_token?: string;
            expires_in?: number;
            token_type?: string;
          };
          if (json.access_token) return { ok: true, ...json };
          errors.push(`${a.label}: 200 but no access_token: ${text.slice(0, 200)}`);
        } catch {
          errors.push(`${a.label}: 200 non-JSON: ${text.slice(0, 200)}`);
        }
      } else {
        errors.push(`${a.label}: ${res.status} ${text.slice(0, 300)}`);
      }
    } catch (err) {
      errors.push(`${a.label}: threw ${(err as Error).message}`);
    }
  }
  return { ok: false, reason: errors.join(" || ") };
}

export async function saveCredentials(token: {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}): Promise<void> {
  const expires_at = token.expires_in
    ? new Date(Date.now() + token.expires_in * 1000).toISOString()
    : null;
  await supabaseAdmin()
    .from("bouncie_credentials")
    .update({
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? null,
      token_type: token.token_type ?? "Bearer",
      expires_at,
      connected_at: new Date().toISOString(),
      last_refreshed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
}

// A single completed trip from Bouncie's /v1/trips endpoint. We use the
// distance + fuelConsumed pair to compute actual rolling MPG.
export interface BouncieTrip {
  transactionId: string;
  startTime: string;
  endTime: string;
  startOdometer: number;
  endOdometer: number;
  distance: number; // miles
  fuelConsumed: number | null; // gallons; null when ECU didn't report
  averageSpeed: number;
  maxSpeed: number;
  totalIdleDuration: number;
  imei: string;
}

// Fetch trips between two dates (inclusive). Bouncie caps the window at
// one week per request — callers wanting more history should iterate in
// 7-day chunks. Date strings are YYYY-MM-DD.
export async function fetchBouncieTrips(opts: {
  startsAfter: string;
  endsBefore: string;
}): Promise<BouncieTrip[] | null> {
  const token = await ensureFreshToken();
  if (!token) return null;
  const creds = await loadCreds();
  // Bouncie's trips endpoint takes imei, not vin. We cache it on the
  // credentials row so the MPG refresh path doesn't waste a /vehicles
  // call on every hit; if it's missing we derive it once and persist.
  let imei: string | null = creds?.imei ?? null;
  if (!imei) {
    try {
      const res = await fetch(`${BOUNCIE_API}/vehicles`, {
        headers: { Authorization: token },
        cache: "no-store",
      });
      if (res.ok) {
        const data = (await res.json()) as Array<{ vin: string; imei?: string }>;
        const v = creds?.vehicle_vin
          ? data.find((x) => x.vin === creds.vehicle_vin) ?? data[0]
          : data[0];
        imei = v?.imei ?? null;
      }
    } catch {}
  }
  if (!imei) return null;
  const qs = new URLSearchParams({
    imei,
    "starts-after": opts.startsAfter,
    "ends-before": opts.endsBefore,
    "gps-format": "geojson",
  });
  try {
    const res = await fetch(`${BOUNCIE_API}/trips?${qs.toString()}`, {
      headers: { Authorization: token },
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn("[bouncie] trips fetch failed", res.status, (await res.text()).slice(0, 160));
      return null;
    }
    const data = (await res.json()) as BouncieTrip[];
    return Array.isArray(data) ? data : null;
  } catch (err) {
    console.warn("[bouncie] trips threw", (err as Error).message);
    return null;
  }
}

export async function attachVehicle(): Promise<{ vin: string; nickname: string | null } | null> {
  const token = await ensureFreshToken();
  if (!token) return null;
  try {
    const res = await fetch(`${BOUNCIE_API}/vehicles`, {
      headers: { Authorization: token },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as BouncieVehicle[];
    const v = data[0];
    if (!v) return null;
    await supabaseAdmin()
      .from("bouncie_credentials")
      .update({
        vehicle_vin: v.vin,
        vehicle_nickname: v.nickName ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);
    return { vin: v.vin, nickname: v.nickName ?? null };
  } catch {
    return null;
  }
}
