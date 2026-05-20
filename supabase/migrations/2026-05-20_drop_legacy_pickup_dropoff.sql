-- Drop the legacy single-pickup / single-dropoff columns. After the
-- 2026-05-20 destinations rewrite, trip.stops[] is the single source of
-- truth for the destination chain (stops[0] = pickup, stops[last] =
-- final destination, middle = intermediate stops). No reader or writer
-- in the app touches the legacy columns anymore.
--
-- BEFORE RUNNING THIS:
--   1. The 2026-05-20_destinations_backfill.sql migration must have run
--      successfully — it ensures every existing row has stops[]
--      populated from its pickup_* / dropoff_* values.
--   2. The deploy containing the destinations rewrite (commit subject
--      "Destinations rewrite: one input, bulletproof, server-as-truth"
--      and the Phase 3 cleanup that followed) must be live in production.
--      Otherwise running this drops data fields the deployed code still
--      reads.
--
-- HOW TO APPLY:
--   Open the Supabase SQL Editor → paste this whole file → run. Takes
--   under a second; no downtime; no data loss (stops[] already has the
--   information).
--
-- ROLLBACK is non-trivial: the data lives in stops[] only after this
-- runs. To recover the columns you'd need to re-add them and backfill
-- from stops[0]/stops[last]. Defensible because the new model has run
-- in production through at least one real ride before this point.

alter table trips drop column if exists pickup_address;
alter table trips drop column if exists pickup_lat;
alter table trips drop column if exists pickup_lng;
alter table trips drop column if exists dropoff_address;
alter table trips drop column if exists dropoff_lat;
alter table trips drop column if exists dropoff_lng;
alter table trips drop column if exists arrived_at_pickup_at;
alter table trips drop column if exists arrived_at_dropoff_at;
