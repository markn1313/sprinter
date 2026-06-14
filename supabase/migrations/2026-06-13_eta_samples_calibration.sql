-- ETA calibration data. One row per Mapbox prediction sampled while a trip is
-- in motion (throttled ~30s, written from the Bouncie webhook at the same
-- cadence we collect positions). Pairs the navigation prediction with the van's
-- position + time so we can later compute the TRUE Sprinter slowdown factor:
--   actual_remaining = trips.completed_at (or arrived_at_dropoff_at) - recorded_at
--   real_factor      = actual_remaining / mapbox_raw_duration_s
-- Filter to n_pending_stops = 0 for pure drive-speed (no boarding dwell) when
-- calibrating SPRINTER_TIME_FACTOR (currently 1.15, in lib/routing.ts).
create table if not exists eta_samples (
  id bigint generated always as identity primary key,
  trip_id uuid references trips(id) on delete cascade,
  recorded_at timestamptz not null default now(),
  van_lat double precision not null,
  van_lng double precision not null,
  speed_mph double precision,
  status text,
  n_pending_stops integer,
  dest_lat double precision,
  dest_lng double precision,
  mapbox_distance_m integer,
  mapbox_raw_duration_s integer,
  padded_duration_s integer,
  time_factor double precision,
  next_mapbox_distance_m integer,
  next_mapbox_raw_duration_s integer,
  -- Per Mapbox congestion class for the remaining route:
  --   { low|moderate|heavy|severe|unknown: { dist_m, dur_s, segments } }
  -- dur_s/dist_m per class = Mapbox's ASSUMED speed in that class. Calibrate a
  -- per-class slowdown factor (jam ~1.0, free-flow ~1.25 since the van does ~60
  -- where Mapbox assumes ~75) by regressing each trip's actual remaining time on
  -- these per-class predicted times, then build a segmented ETA that applies the
  -- right factor to each section instead of a single flat 1.15.
  congestion_breakdown jsonb
);
create index if not exists eta_samples_trip_idx on eta_samples(trip_id, recorded_at);

-- Idempotent add for DBs where the table was created before this column existed.
alter table eta_samples add column if not exists congestion_breakdown jsonb;
