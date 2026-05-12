-- Destinations Mark long-pressed to remove from the "Take me to…" quick-
-- dispatch chips on his home screen. The `/api/insights` top_destinations
-- aggregation filters these out. The key is the lowercased+trimmed address
-- so all variants (case, leading/trailing whitespace) hide together.
create table if not exists hidden_destinations (
  id uuid primary key default gen_random_uuid(),
  address_key text not null unique,
  address text not null, -- the original-case version for reference
  hidden_at timestamptz not null default now()
);

create index if not exists hidden_destinations_key_idx on hidden_destinations(address_key);
