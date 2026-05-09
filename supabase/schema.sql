-- Sprinter Ops schema
-- Apply with: psql or via Supabase SQL editor

create extension if not exists "pgcrypto";

create table if not exists links (
  token text primary key,
  role text not null check (role in ('mark','dio','passenger')),
  name text not null,
  created_by text references links(token) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  trip_id uuid,
  revoked_at timestamptz
);

create index if not exists links_role_idx on links(role);
create index if not exists links_trip_idx on links(trip_id);

create table if not exists trips (
  id uuid primary key default gen_random_uuid(),
  passenger_name text not null,
  passenger_link_token text references links(token) on delete set null,
  pickup_address text,
  pickup_lat double precision,
  pickup_lng double precision,
  dropoff_address text,
  dropoff_lat double precision,
  dropoff_lng double precision,
  scheduled_at timestamptz not null default now(),
  dispatched_at timestamptz,
  arrived_at_pickup_at timestamptz,
  onboard_at timestamptz,
  arrived_at_dropoff_at timestamptz,
  completed_at timestamptz,
  status text not null default 'scheduled' check (status in (
    'scheduled','dispatched','at_pickup','onboard','at_dropoff','complete','cancelled'
  )),
  notes text,
  driver_pay_cents integer,
  estimated_minutes integer,
  actual_minutes integer,
  created_at timestamptz not null default now(),
  created_by text references links(token) on delete set null
);

create index if not exists trips_status_idx on trips(status);
create index if not exists trips_scheduled_idx on trips(scheduled_at desc);

alter table links
  add constraint links_trip_fk
  foreign key (trip_id) references trips(id) on delete set null
  deferrable initially deferred;

create table if not exists van_position (
  id integer primary key check (id = 1),
  lat double precision,
  lng double precision,
  heading double precision,
  speed_mph double precision,
  fuel_pct double precision,
  battery_v double precision,
  mileage double precision,
  ignition boolean,
  source text,
  updated_at timestamptz not null default now()
);

insert into van_position (id) values (1) on conflict (id) do nothing;

create table if not exists dio_status (
  id integer primary key check (id = 1),
  emoji text not null default 'idle',
  label text not null default 'Idle',
  updated_at timestamptz not null default now()
);

insert into dio_status (id) values (1) on conflict (id) do nothing;

create table if not exists dio_settings (
  id integer primary key check (id = 1),
  hourly_rate_cents integer not null default 3500,
  day_rate_cents integer not null default 28000,
  updated_at timestamptz not null default now()
);

insert into dio_settings (id) values (1) on conflict (id) do nothing;

create table if not exists issues (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  note text,
  reported_by text references links(token) on delete set null,
  reported_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid references trips(id) on delete set null,
  category text not null,
  amount_cents integer not null,
  note text,
  recorded_by text references links(token) on delete set null,
  recorded_at timestamptz not null default now()
);

-- Realtime: enable for live dashboards
alter publication supabase_realtime add table van_position;
alter publication supabase_realtime add table dio_status;
alter publication supabase_realtime add table trips;
