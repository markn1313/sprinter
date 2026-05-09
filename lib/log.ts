import { supabaseAdmin } from "@/lib/supabase";

// Fire-and-forget loggers. They write to the timeseries / audit tables when
// they exist, swallow errors otherwise. No awaiting in callers — these run in
// the background of the request and shouldn't add latency.

interface VehiclePositionRow {
  trip_id?: string | null;
  source: "bouncie" | "driver_phone" | "mark_phone";
  lat?: number | null;
  lng?: number | null;
  heading?: number | null;
  speed_mph?: number | null;
  fuel_pct?: number | null;
  ignition?: boolean | null;
  battery_v?: number | null;
  mileage?: number | null;
}

export function logVehiclePosition(row: VehiclePositionRow): void {
  // Don't await — let it complete after the response. Errors swallowed because
  // missing tables shouldn't break the live request.
  try {
    void Promise.resolve(supabaseAdmin().from("vehicle_positions").insert(row)).then(
      () => {},
      () => {},
    );
  } catch {
    // ignore
  }
}

interface TripEventRow {
  trip_id: string;
  kind: string;
  actor_token?: string | null;
  payload?: Record<string, unknown>;
}

export function logTripEvent(row: TripEventRow): void {
  try {
    void Promise.resolve(
      supabaseAdmin().from("trip_events").insert({
        trip_id: row.trip_id,
        kind: row.kind,
        actor_token: row.actor_token ?? null,
        payload: row.payload ?? null,
      }),
    ).then(
      () => {},
      () => {},
    );
  } catch {
    // ignore
  }
}

interface PassengerPrefsRow {
  token: string;
  display_name?: string;
  preferred_temp_f?: number;
  preferred_fan?: number;
  music_pref?: string;
  notes?: string;
}

export function upsertPassengerPrefs(row: PassengerPrefsRow): void {
  try {
    void Promise.resolve(
      supabaseAdmin()
        .from("passenger_prefs")
        .upsert(
          { ...row, updated_at: new Date().toISOString() },
          { onConflict: "token" },
        ),
    ).then(
      () => {},
      () => {},
    );
  } catch {
    // ignore
  }
}
