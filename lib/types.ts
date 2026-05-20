export type Role = "mark" | "dio" | "passenger" | "tv";

export type TripStatus =
  | "scheduled"
  | "dispatched"
  | "at_pickup"
  | "onboard"
  | "at_dropoff"
  | "complete"
  | "cancelled";

export type IssueKind =
  | "dent"
  | "noise"
  | "low_tire"
  | "battery_low"
  | "detail"
  | "other";

export interface Link {
  token: string;
  role: Role;
  name: string;
  created_by: string | null;
  created_at: string;
  expires_at: string | null;
  trip_id: string | null;
  revoked_at: string | null;
}

// Stop in the destination chain. trip.stops[0] = pickup,
// trip.stops[stops.length-1] = final destination, middle = intermediate
// stops. Replaced the pickup_*/dropoff_* + arrived_at_*_at columns
// dropped in the 2026-05-20 schema migration.
export interface TripStop {
  id: string;
  kind?: "pickup" | "dropoff" | "stop";
  category?: string | null;
  address: string;
  lat: number | null;
  lng: number | null;
  passenger?: string | null;
  passenger_link_token?: string | null;
  created_by_token?: string | null;
  arrived_at?: string | null;
  added_at: string;
}

export interface Trip {
  id: string;
  passenger_name: string;
  passenger_link_token: string | null;
  stops: TripStop[] | null;
  scheduled_at: string;
  dispatched_at: string | null;
  onboard_at: string | null;
  completed_at: string | null;
  status: TripStatus;
  notes: string | null;
  driver_pay_cents: number | null;
  estimated_minutes: number | null;
  actual_minutes: number | null;
  created_at: string;
  created_by: string | null;
}

export interface VanPosition {
  lat: number;
  lng: number;
  heading: number;
  speed_mph: number;
  fuel_pct: number | null;
  battery_v: number | null;
  mileage: number | null;
  ignition: boolean;
  updated_at: string;
}

export interface Issue {
  id: string;
  kind: IssueKind;
  note: string | null;
  reported_by: string;
  reported_at: string;
  resolved_at: string | null;
}

export interface SessionContext {
  token: string;
  role: Role;
  name: string;
  trip_id: string | null;
}
