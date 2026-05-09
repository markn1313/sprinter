export type Role = "mark" | "dio" | "passenger" | "tv";

export type TripStatus =
  | "scheduled"
  | "dispatched"
  | "at_pickup"
  | "onboard"
  | "at_dropoff"
  | "complete"
  | "cancelled";

export type DioStatusEmoji =
  | "driving"
  | "idle"
  | "fueling"
  | "lunch"
  | "parked"
  | "traffic"
  | "off";

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

export interface Trip {
  id: string;
  passenger_name: string;
  passenger_link_token: string | null;
  pickup_address: string | null;
  pickup_lat: number | null;
  pickup_lng: number | null;
  dropoff_address: string | null;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  scheduled_at: string;
  dispatched_at: string | null;
  arrived_at_pickup_at: string | null;
  onboard_at: string | null;
  arrived_at_dropoff_at: string | null;
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

export interface DioStatus {
  emoji: DioStatusEmoji;
  label: string;
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
