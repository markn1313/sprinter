-- Add the position-relevant tables to the supabase_realtime publication so
-- the hooks (usePosition, useEta, useTrips) get CDC events for them. Without
-- this, .on('postgres_changes', ...) subscribes successfully but no events
-- ever fire because Supabase isn't broadcasting changes for those tables.

do $$
declare
  t text;
begin
  foreach t in array array['van_position','mark_location','trips','vehicle_positions']
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
