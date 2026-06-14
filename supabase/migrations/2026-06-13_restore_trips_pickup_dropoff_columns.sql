-- 2026-06-13: Restore the 8 trip location/arrival fields the app code still
-- depends on. They had been dropped from the live DB during an incomplete
-- migration toward the stops[] JSON model, but the state machine
-- (loadActiveTrip), the trip PATCH route, quick-pickup, and the Dio/TV trip
-- selects all still read/write them. Their absence silently broke:
--   * GPS auto-advancement — loadActiveTrip's select errored, was swallowed by
--     its try/catch, returned null, so trips never progressed past pickup; and
--   * destination saves — PATCH /api/trips/:id wrote dropoff_* columns that
--     didn't exist and 500'd.
-- Additive only (add column if not exists) — removes nothing, fully reversible.
-- Matches the canonical definitions in supabase/schema.sql.
alter table trips add column if not exists pickup_address text;
alter table trips add column if not exists pickup_lat double precision;
alter table trips add column if not exists pickup_lng double precision;
alter table trips add column if not exists dropoff_address text;
alter table trips add column if not exists dropoff_lat double precision;
alter table trips add column if not exists dropoff_lng double precision;
alter table trips add column if not exists arrived_at_pickup_at timestamptz;
alter table trips add column if not exists arrived_at_dropoff_at timestamptz;
