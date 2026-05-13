-- Drop the dio_status table. The auto state-machine in /api/position
-- replaced manual driver-status pills; nothing reads dio_status anymore.
-- Removing avoids a stale source of truth and keeps the realtime
-- publication smaller.
alter publication supabase_realtime drop table if exists dio_status;
drop table if exists dio_status;
