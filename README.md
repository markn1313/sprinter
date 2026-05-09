# Sprinter Ops

Live operational dashboard for Mark's 2024 Mercedes Sprinter Van.

Three role-aware experiences served from one Next.js app:

- **`/m/<token>`** — Mark (owner): live map, dispatch bar, trip log with cost, link generator, today/week pay totals, full visibility.
- **`/d/<token>`** — Dio (driver): next-pickup card, four big trip-state buttons, status emoji bar, issue logger. **No money fields ever rendered.**
- **`/p/<token>`** — Passenger (one-time guest): live van approach, trip status, in-cabin tips. Auto-expires.

## Setup

1. Create Supabase project named `sprinter`. Get the project URL, anon key, service role key.
2. Apply schema: paste `supabase/schema.sql` into the Supabase SQL editor and run.
3. Copy `.env.example` to `.env.local` and fill in keys.
4. `npm install`
5. `npm run dev` → http://localhost:3000
6. Create Mark's token:
   ```
   curl -XPOST http://localhost:3000/api/bootstrap -H "X-Bootstrap-Secret: $BOOTSTRAP_SECRET"
   ```
   Open `http://localhost:3000/m/<token>` and bookmark it.

## Live data

- Bouncie GPS polled every 8s by Mark/Dio dashboards. If `BOUNCIE_ACCESS_TOKEN` isn't set, a deterministic mock orbits Newport Beach so you can develop without real data.
- Trips poll every 5s. Status badges update across all three modes within ~5 seconds of any state change.

## Money gating

Cost rendering is gated server-side at the API layer (Dio/Passenger calls to `/api/trips` strip cost fields) AND client-side in the components (`role !== "mark"` hides money). Both layers exist so the API is safe even if a client is modified.
