-- Cache columns for rolling actual MPG computed from Bouncie trips data.
-- See lib/mpg.ts. Stored on the bouncie_credentials singleton so refresh
-- is keyed off existing Bouncie auth without a new table.

alter table bouncie_credentials
  add column if not exists mpg_recent double precision,
  add column if not exists mpg_window_miles double precision,
  add column if not exists mpg_window_gallons double precision,
  add column if not exists mpg_window_days integer,
  add column if not exists mpg_computed_at timestamptz,
  -- Bouncie's trips endpoint takes IMEI (not VIN). Cache it here so we
  -- don't re-call /vehicles every MPG refresh.
  add column if not exists imei text;
