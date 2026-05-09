-- 2026-05-09: enable realtime on chat / cabin_requests; add push_subscriptions

-- The trips, van_position, and dio_status tables were added to the realtime
-- publication in schema.sql. messages and cabin_requests existed but were
-- never published — that's why chat and cabin requests still felt stale.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    execute 'alter publication supabase_realtime add table messages';
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cabin_requests'
  ) then
    execute 'alter publication supabase_realtime add table cabin_requests';
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'driver_location'
  ) then
    execute 'alter publication supabase_realtime add table driver_location';
  end if;
end$$;

-- Web Push subscriptions. One row per device that opted in. We key by the
-- magic-link token rather than a stable user id because each role uses its
-- own token and that's what we already authenticate with.
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
