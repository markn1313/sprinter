-- Diesel retail price cache. Singleton row (id=1) updated by
-- lib/fuel-price.ts when the EIA fetcher succeeds, or manually via
-- SQL when we want to pin a specific price.
--
-- We track California statewide RETAIL DIESEL ULSD (No 2 Distillate
-- Low Sulfur, EIA series EMD_EPD2DXL0_PTE_SCA_DPG). EIA doesn't
-- publish ZIP-level retail prices; CA statewide is within a few
-- cents of the 92663 / Costa Mesa pump price at any moment.
create table if not exists fuel_price (
  id integer primary key check (id = 1),
  region text not null default 'CA',
  price_per_gal numeric(6,3) not null,
  source text not null,        -- 'eia' | 'manual' | 'fallback'
  effective_date date,           -- the EIA week the price is from
  fetched_at timestamptz not null default now()
);

-- Seed with a sensible CA diesel value so first-run code has
-- something to read even before the EIA refresh has run.
insert into fuel_price (id, region, price_per_gal, source)
values (1, 'CA', 7.000, 'fallback')
on conflict (id) do nothing;
