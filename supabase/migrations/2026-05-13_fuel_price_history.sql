-- Convert fuel_price from singleton (id=1 check) to a history table
-- with one row per EIA weekly datapoint. Enables window-average price
-- lookups (last 7 days, last 30 days, etc) instead of always using
-- the most recent price.
--
-- Schema after this migration:
--   id              bigserial primary key
--   region          'CA' (extendable later)
--   price_per_gal   numeric(6,3)
--   effective_date  the EIA week the datapoint represents
--   source          'eia' | 'manual' | 'fallback'
--   fetched_at      when we wrote this row
-- Unique (region, effective_date) so weekly refreshes upsert in place.

alter table fuel_price drop constraint if exists fuel_price_id_check;
alter table fuel_price drop constraint if exists fuel_price_pkey cascade;
alter table fuel_price drop column if exists id;
alter table fuel_price add column id bigserial primary key;
create unique index if not exists fuel_price_region_date_uq
  on fuel_price (region, effective_date);
create index if not exists fuel_price_effective_date_idx
  on fuel_price (effective_date desc);
