-- Persistent storage for Bouncie's per-trip telemetry. Each Bouncie
-- "drive" (ignition-on → ignition-off) becomes one row. The cron
-- task in /api/cron/cleanup keeps this fresh by upserting the last
-- 7 days every run; a one-shot script in /tmp/backfill_bouncie.py
-- did the historical backfill at table-creation time.
--
-- Why keep this locally when Bouncie has an API?
--   1. Consumer-tier retention is short (~6 weeks at time of writing).
--      Storing locally preserves the full history forever.
--   2. Query latency: DB joins on trip_id beat API round-trips.
--   3. Future analytics: aggregate over arbitrarily long windows
--      without burning Bouncie API quota or hitting their 7-day-
--      span cap.
--   4. GPS LineString per trip survives even if Bouncie ever changes
--      their API or expires retention further — enables "reconstruct
--      any past trip's route" forever.

create table if not exists bouncie_trips (
  transaction_id          text primary key,
  imei                    text not null,
  start_time              timestamptz not null,
  end_time                timestamptz,
  start_odometer          numeric(10,3),
  end_odometer            numeric(10,3),
  distance                numeric(10,3),       -- miles
  fuel_consumed           numeric(10,3),       -- gallons (ECU)
  average_speed           numeric(6,2),        -- mph
  max_speed               numeric(6,2),        -- mph
  total_idle_duration     integer,             -- seconds
  hard_braking_count      integer,
  hard_acceleration_count integer,
  time_zone               text,
  gps                     jsonb,               -- GeoJSON LineString of the drive's path
  raw                     jsonb,               -- everything else from the API for forward-compat
  fetched_at              timestamptz not null default now()
);

create index if not exists bouncie_trips_start_idx on bouncie_trips (start_time desc);
create index if not exists bouncie_trips_imei_idx  on bouncie_trips (imei);
