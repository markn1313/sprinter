import { supabaseAdmin } from "@/lib/supabase";

// Diesel retail price source of truth. Cached on a singleton row in
// the fuel_price table; refreshed from EIA's Weekly Retail Gasoline
// and Diesel Prices API when the cached value is older than
// REFRESH_TTL_HOURS.
//
// We track California statewide RETAIL DIESEL ULSD (No 2 Distillate
// Low Sulfur 0-15 ppm, EIA series EMD_EPD2DXL0_PTE_SCA_DPG). EIA
// doesn't publish ZIP-level retail prices and no free public API
// does at the ZIP level; CA statewide is within a few cents of the
// 92663 / Costa Mesa pump price at any moment. EIA updates weekly
// (Monday); a 24h cache makes sure we don't hammer the API.
//
// IMPORTANT: this is DIESEL, not gasoline. Product code `EPD2DXL0`
// is No 2 Diesel Low Sulfur (the on-highway fuel sold at the pump
// since EPA's 2010 ULSD mandate). Regular unleaded would be `EPMR`.
// Confirm with the API response — every row carries `product-name`
// "No 2 Diesel Low Sulfur (0-15 ppm)".

const REFRESH_TTL_HOURS = 24;
const FALLBACK_PRICE = 7.0; // CA diesel ballpark when EIA + cache both fail

interface CachedPrice {
  price_per_gal: number;
  source: string;
  effective_date: string | null;
  fetched_at: string;
}

export interface FuelPrice {
  price: number;
  source: "eia" | "fallback" | "cache_stale" | "manual";
  effective_date: string | null;
  fetched_at: string | null;
}

async function loadCached(): Promise<CachedPrice | null> {
  try {
    const { data } = await supabaseAdmin()
      .from("fuel_price")
      .select("price_per_gal, source, effective_date, fetched_at")
      .eq("id", 1)
      .maybeSingle();
    if (!data) return null;
    return {
      price_per_gal: Number(data.price_per_gal),
      source: data.source as string,
      effective_date: (data.effective_date as string | null) ?? null,
      fetched_at: data.fetched_at as string,
    };
  } catch {
    return null;
  }
}

async function saveCached(price: number, effective_date: string | null): Promise<void> {
  try {
    await supabaseAdmin()
      .from("fuel_price")
      .upsert(
        {
          id: 1,
          region: "CA",
          price_per_gal: price,
          source: "eia",
          effective_date,
          fetched_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );
  } catch {
    // ignore — next call will retry the fetch
  }
}

// Fetch the most recent weekly CA diesel retail price from EIA's v2
// API. Returns null if the API key is missing or the request fails.
export async function fetchEIADieselPrice(): Promise<{ price: number; effective_date: string } | null> {
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
  url.searchParams.set("length", "1");
  url.searchParams.set("api_key", apiKey);
  try {
    const res = await fetch(url.toString(), { cache: "no-store" });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      response?: { data?: Array<{ period: string; value: string; product: string }> };
    };
    const row = data?.response?.data?.[0];
    if (!row?.value) return null;
    // Belt-and-suspenders — the API should only return EPD2DXL0 given
    // our facet filter, but verify so a future API regression can't
    // silently swap gasoline pricing in.
    if (row.product !== "EPD2DXL0") return null;
    const price = Number(row.value);
    if (!Number.isFinite(price) || price <= 0) return null;
    return { price, effective_date: row.period };
  } catch {
    return null;
  }
}

// Public accessor — read-through cache. Returns the current best
// estimate for CA retail diesel. Order of preference:
//   1. Cached row younger than REFRESH_TTL_HOURS (fresh)
//   2. Fresh EIA fetch (writes new cache row)
//   3. Any cached row, even if stale (better stale than wrong)
//   4. Hard-coded fallback
export async function getDieselPrice(): Promise<FuelPrice> {
  const cached = await loadCached();
  const cachedFresh =
    cached &&
    cached.fetched_at &&
    Date.now() - new Date(cached.fetched_at).getTime() < REFRESH_TTL_HOURS * 3600_000;
  if (cachedFresh && cached) {
    return {
      price: cached.price_per_gal,
      source: cached.source === "manual" ? "manual" : cached.source === "eia" ? "eia" : "cache_stale",
      effective_date: cached.effective_date,
      fetched_at: cached.fetched_at,
    };
  }
  const fresh = await fetchEIADieselPrice();
  if (fresh) {
    await saveCached(fresh.price, fresh.effective_date);
    return {
      price: fresh.price,
      source: "eia",
      effective_date: fresh.effective_date,
      fetched_at: new Date().toISOString(),
    };
  }
  if (cached) {
    return {
      price: cached.price_per_gal,
      source: "cache_stale",
      effective_date: cached.effective_date,
      fetched_at: cached.fetched_at,
    };
  }
  return { price: FALLBACK_PRICE, source: "fallback", effective_date: null, fetched_at: null };
}

// Cron-friendly helper: force-refresh from EIA. Used by the daily
// cleanup task so insights doesn't have to do the EIA round-trip on
// the user-facing request path.
export async function refreshDieselPrice(): Promise<FuelPrice> {
  const fresh = await fetchEIADieselPrice();
  if (fresh) {
    await saveCached(fresh.price, fresh.effective_date);
    return {
      price: fresh.price,
      source: "eia",
      effective_date: fresh.effective_date,
      fetched_at: new Date().toISOString(),
    };
  }
  // EIA fetch failed — fall through to whatever cache holds.
  return getDieselPrice();
}
