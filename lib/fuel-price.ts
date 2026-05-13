import { supabaseAdmin } from "@/lib/supabase";

// Diesel retail price source of truth. Historical CA-statewide retail
// diesel prices (No 2 Distillate Low Sulfur, EIA series
// EMD_EPD2DXL0_PTE_SCA_DPG) live in the fuel_price table — one row
// per EIA weekly datapoint. Lets us compute window averages (last 7
// days, last 30 days, etc.) so cost stats reflect the average rate
// during the window rather than just the most recent price.
//
// IMPORTANT: this is DIESEL, not gasoline. Product code `EPD2DXL0`
// is No 2 Diesel Low Sulfur (the on-highway ULSD sold at retail).
// Every API response carries product-name "No 2 Diesel Low Sulfur
// (0-15 ppm)" — verified at fetch time.
//
// Cadence: EIA publishes weekly (Mondays). Cron refresh hits the
// API once a day and upserts the last ~6 weeks so any late-week
// revisions get picked up.

const REFRESH_TTL_HOURS = 24;
const REFRESH_WEEKS = 6; // weeks of history to upsert per refresh
const FALLBACK_PRICE = 7.0; // CA diesel ballpark when EIA + cache both fail

interface PriceRow {
  price_per_gal: number;
  source: string;
  effective_date: string;
  fetched_at: string;
}

export interface FuelPrice {
  price: number;
  source: "eia" | "fallback" | "cache_stale" | "manual" | "avg";
  effective_date: string | null;
  fetched_at: string | null;
  // For window averages: how many EIA datapoints contributed.
  // null for single-point lookups.
  samples?: number | null;
}

async function loadRecentRows(daysBack: number): Promise<PriceRow[]> {
  try {
    const since = new Date(Date.now() - daysBack * 86_400_000).toISOString().slice(0, 10);
    const { data } = await supabaseAdmin()
      .from("fuel_price")
      .select("price_per_gal, source, effective_date, fetched_at")
      .eq("region", "CA")
      .gte("effective_date", since)
      .order("effective_date", { ascending: false });
    return ((data ?? []) as Array<{
      price_per_gal: string | number;
      source: string;
      effective_date: string;
      fetched_at: string;
    }>).map((r) => ({
      price_per_gal: Number(r.price_per_gal),
      source: r.source,
      effective_date: r.effective_date,
      fetched_at: r.fetched_at,
    }));
  } catch {
    return [];
  }
}

async function loadLatestRow(): Promise<PriceRow | null> {
  try {
    const { data } = await supabaseAdmin()
      .from("fuel_price")
      .select("price_per_gal, source, effective_date, fetched_at")
      .eq("region", "CA")
      .order("effective_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!data) return null;
    return {
      price_per_gal: Number(data.price_per_gal),
      source: data.source as string,
      effective_date: data.effective_date as string,
      fetched_at: data.fetched_at as string,
    };
  } catch {
    return null;
  }
}

// Fetch the most recent N weekly CA diesel retail prices from EIA's
// v2 API. Returns null if the API key is missing or the request fails.
async function fetchEIADieselPrices(
  weeks: number,
): Promise<Array<{ price: number; effective_date: string }> | null> {
  const apiKey = process.env.EIA_API_KEY;
  if (!apiKey) return null;
  const url = new URL("https://api.eia.gov/v2/petroleum/pri/gnd/data/");
  url.searchParams.set("frequency", "weekly");
  url.searchParams.append("data[0]", "value");
  url.searchParams.append("facets[duoarea][]", "SCA"); // California
  url.searchParams.append("facets[product][]", "EPD2DXL0"); // No 2 Diesel Low Sulfur
  url.searchParams.append("sort[0][column]", "period");
  url.searchParams.append("sort[0][direction]", "desc");
  url.searchParams.set("offset", "0");
  url.searchParams.set("length", String(weeks));
  url.searchParams.set("api_key", apiKey);
  try {
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      response?: { data?: Array<{ period: string; value: string; product: string }> };
    };
    const rows = data?.response?.data ?? [];
    const out: Array<{ price: number; effective_date: string }> = [];
    for (const r of rows) {
      if (r.product !== "EPD2DXL0") continue; // defensive — should be filtered already
      const price = Number(r.value);
      if (!Number.isFinite(price) || price <= 0) continue;
      out.push({ price, effective_date: r.period });
    }
    return out;
  } catch {
    return null;
  }
}

async function upsertWeeks(rows: Array<{ price: number; effective_date: string }>): Promise<void> {
  if (rows.length === 0) return;
  try {
    await supabaseAdmin()
      .from("fuel_price")
      .upsert(
        rows.map((r) => ({
          region: "CA",
          price_per_gal: r.price,
          source: "eia",
          effective_date: r.effective_date,
          fetched_at: new Date().toISOString(),
        })),
        { onConflict: "region,effective_date" },
      );
  } catch {
    // ignore — caller still gets cached data
  }
}

async function isCacheFresh(): Promise<boolean> {
  const latest = await loadLatestRow();
  if (!latest?.fetched_at) return false;
  return Date.now() - new Date(latest.fetched_at).getTime() < REFRESH_TTL_HOURS * 3600_000;
}

// Public accessor — read-through cache for the LATEST price. Used by
// callers that want a single current rate (e.g. "current $/gal" UI
// chip, the Last 24h window in insights).
export async function getDieselPrice(): Promise<FuelPrice> {
  if (await isCacheFresh()) {
    const r = await loadLatestRow();
    if (r) {
      return {
        price: r.price_per_gal,
        source: r.source === "manual" ? "manual" : "eia",
        effective_date: r.effective_date,
        fetched_at: r.fetched_at,
      };
    }
  }
  // Stale or missing — try to refresh from EIA.
  const fresh = await fetchEIADieselPrices(REFRESH_WEEKS);
  if (fresh && fresh.length > 0) {
    await upsertWeeks(fresh);
    return {
      price: fresh[0].price,
      source: "eia",
      effective_date: fresh[0].effective_date,
      fetched_at: new Date().toISOString(),
    };
  }
  // EIA unreachable — last cached row, even stale, beats the hard fallback.
  const stale = await loadLatestRow();
  if (stale) {
    return {
      price: stale.price_per_gal,
      source: "cache_stale",
      effective_date: stale.effective_date,
      fetched_at: stale.fetched_at,
    };
  }
  return { price: FALLBACK_PRICE, source: "fallback", effective_date: null, fetched_at: null };
}

// Average diesel price over a rolling window (e.g. last 30 days).
// All weekly EIA datapoints whose effective_date falls in the window
// contribute equally to the mean. Falls back to the latest known
// price if no datapoints land in the window (e.g. cache is empty).
export async function getAvgDieselPrice(daysBack: number): Promise<FuelPrice> {
  // Trigger a refresh if cache is stale — the average is only useful
  // when historical weeks are populated.
  if (!(await isCacheFresh())) {
    const fresh = await fetchEIADieselPrices(REFRESH_WEEKS);
    if (fresh) await upsertWeeks(fresh);
  }
  const rows = await loadRecentRows(daysBack);
  if (rows.length > 0) {
    const sum = rows.reduce((acc, r) => acc + r.price_per_gal, 0);
    return {
      price: sum / rows.length,
      source: rows.length === 1 ? "eia" : "avg",
      effective_date: rows[0].effective_date, // newest contributing week
      fetched_at: rows[0].fetched_at,
      samples: rows.length,
    };
  }
  return getDieselPrice();
}

// Cron-friendly: force-refresh from EIA. Returns the latest row's
// price after the upsert. Used by /api/cron/cleanup.
export async function refreshDieselPrice(): Promise<FuelPrice> {
  const fresh = await fetchEIADieselPrices(REFRESH_WEEKS);
  if (fresh && fresh.length > 0) {
    await upsertWeeks(fresh);
    return {
      price: fresh[0].price,
      source: "eia",
      effective_date: fresh[0].effective_date,
      fetched_at: new Date().toISOString(),
    };
  }
  return getDieselPrice();
}
