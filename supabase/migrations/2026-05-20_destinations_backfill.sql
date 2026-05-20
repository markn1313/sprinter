-- Destinations-as-chain migration: ensure every existing trip's stops[]
-- contains the pickup as stops[0] and the dropoff as stops[last], so the
-- new chain-only readers (DestinationInput, /api/destinations) don't lose
-- legacy data.
--
-- IDEMPOTENT — re-run safe. Only fills in missing entries.
--
-- We do NOT drop pickup_*/dropoff_* columns here. They stay as a
-- dual-write source for the trip-state machine and any reader not yet
-- migrated. Phase 3 of the destinations rewrite cuts those readers over
-- and drops the columns.
--
-- Algorithm per trip (executed in PL/pgSQL):
--   1. If pickup_lat is non-null AND no element of stops[] is "close" to
--      the pickup, prepend a pickup stop with arrived_at = onboard_at
--      (or arrived_at_pickup_at, whichever is non-null; null otherwise).
--   2. If dropoff_lat is non-null AND no element of stops[] is "close" to
--      the dropoff, append a dropoff stop with arrived_at =
--      arrived_at_dropoff_at (null if the trip never completed).
--   "Close" = same lat/lng to 4 decimal places (~11m), to avoid duplicate
--   entries when a previous backfill or live-trip code already wrote
--   them.

create or replace function _destinations_close(
  s jsonb, target_lat double precision, target_lng double precision
) returns boolean
language sql immutable as $$
  select round((s->>'lat')::numeric, 4) = round(target_lat::numeric, 4)
     and round((s->>'lng')::numeric, 4) = round(target_lng::numeric, 4);
$$;

do $$
declare
  t record;
  s_arr jsonb;
  has_pickup boolean;
  has_dropoff boolean;
  pickup_stop jsonb;
  dropoff_stop jsonb;
begin
  for t in select * from trips loop
    s_arr := coalesce(t.stops, '[]'::jsonb);

    -- Step 1: pickup
    if t.pickup_lat is not null and t.pickup_lng is not null then
      has_pickup := exists (
        select 1 from jsonb_array_elements(s_arr) e
        where _destinations_close(e, t.pickup_lat, t.pickup_lng)
      );
      if not has_pickup then
        pickup_stop := jsonb_build_object(
          'id',           gen_random_uuid()::text,
          'kind',         'stop',
          'address',      t.pickup_address,
          'lat',          t.pickup_lat,
          'lng',          t.pickup_lng,
          'passenger',    t.passenger_name,
          'created_by_token', t.created_by,
          'arrived_at',   coalesce(t.onboard_at::text, t.arrived_at_pickup_at::text),
          'added_at',     t.created_at::text
        );
        s_arr := pickup_stop || s_arr;  -- prepend
      end if;
    end if;

    -- Step 2: dropoff
    if t.dropoff_lat is not null and t.dropoff_lng is not null then
      has_dropoff := exists (
        select 1 from jsonb_array_elements(s_arr) e
        where _destinations_close(e, t.dropoff_lat, t.dropoff_lng)
      );
      if not has_dropoff then
        dropoff_stop := jsonb_build_object(
          'id',           gen_random_uuid()::text,
          'kind',         'stop',
          'address',      t.dropoff_address,
          'lat',          t.dropoff_lat,
          'lng',          t.dropoff_lng,
          'passenger',    null,
          'created_by_token', t.created_by,
          'arrived_at',   t.arrived_at_dropoff_at::text,
          'added_at',     t.created_at::text
        );
        s_arr := s_arr || dropoff_stop;  -- append
      end if;
    end if;

    if s_arr is distinct from coalesce(t.stops, '[]'::jsonb) then
      update trips set stops = s_arr where id = t.id;
    end if;
  end loop;
end $$;

drop function _destinations_close(jsonb, double precision, double precision);
