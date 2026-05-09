-- 2026-05-09: enable realtime on chat / cabin_requests; add push_subscriptions;
-- stand up the timeseries + audit tables we'll need to start logging

-- Realtime publication: ensure every table the UI subscribes to is published.
do $$
declare
  t text;
begin
  foreach t in array array['messages','cabin_requests','driver_location']
  loop
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name=t)
       and not exists (
         select 1 from pg_publication_tables
         where pubname='supabase_realtime' and schemaname='public' and tablename=t
       )
    then
      execute format('alter publication supabase_realtime add table %I', t);
    end if;
  end loop;
end$$;

-- Web Push subscriptions. One row per device that opted in. Keyed by the
-- magic-link token rather than a stable user id because each role uses its
-- own token and that's already what we authenticate with.
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  token text not null references links(token) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (endpoint)
);

create index if not exists push_subscriptions_token_idx on push_subscriptions(token);

-- Vehicle positions timeseries: every Bouncie/driver ping appended here so
-- we can do trip cost, route playback, idle/harsh-event analytics, and a
-- real range model.
create table if not exists vehicle_positions (
  id bigserial primary key,
  trip_id uuid references trips(id) on delete set null,
  source text not null check (source in ('bouncie','driver_phone','mark_phone')),
  lat double precision,
  lng double precision,
  heading double precision,
  speed_mph double precision,
  fuel_pct double precision,
  ignition boolean,
  battery_v double precision,
  mileage double precision,
  recorded_at timestamptz not null default now()
);

create index if not exists vehicle_positions_trip_idx on vehicle_positions(trip_id, recorded_at);
create index if not exists vehicle_positions_recorded_idx on vehicle_positions(recorded_at desc);

-- Trip events audit log: every meaningful state change with optional payload.
create table if not exists trip_events (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  kind text not null,
  actor_token text references links(token) on delete set null,
  payload jsonb,
  at timestamptz not null default now()
);

create index if not exists trip_events_trip_idx on trip_events(trip_id, at desc);

-- Passenger preferences keyed by their magic-link token. Persists across
-- trips so when Greg's link is reused we already know his favorite temp.
create table if not exists passenger_prefs (
  token text primary key references links(token) on delete cascade,
  display_name text,
  preferred_temp_f integer,
  preferred_fan integer,
  music_pref text,
  notes text,
  updated_at timestamptz not null default now()
);
