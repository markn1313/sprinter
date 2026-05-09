import { VanPosition } from "./types";

// Newport Beach as default home base
const HOME_LAT = 33.6189;
const HOME_LNG = -117.9298;

interface BouncieVehicle {
  vin: string;
  nickName: string;
  stats: {
    location: { lat: number; lon: number };
    heading: number;
    speed: number;
    fuelLevel?: number;
    batteryStatus?: { value: number };
    odometer?: number;
    isRunning?: boolean;
    lastUpdated?: string;
  };
}

export async function fetchBouncieVehicle(): Promise<VanPosition | null> {
  const token = process.env.BOUNCIE_ACCESS_TOKEN;
  const vin = process.env.BOUNCIE_VIN;
  if (!token) return null;

  const url = vin
    ? `https://api.bouncie.dev/v1/vehicles?vin=${encodeURIComponent(vin)}`
    : "https://api.bouncie.dev/v1/vehicles";

  try {
    const res = await fetch(url, {
      headers: { Authorization: token },
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn("Bouncie API error", res.status, await res.text());
      return null;
    }
    const data = (await res.json()) as BouncieVehicle[];
    const vehicle = vin ? data.find((v) => v.vin === vin) ?? data[0] : data[0];
    if (!vehicle) return null;
    return {
      lat: vehicle.stats.location.lat,
      lng: vehicle.stats.location.lon,
      heading: vehicle.stats.heading ?? 0,
      speed_mph: vehicle.stats.speed ?? 0,
      fuel_pct: vehicle.stats.fuelLevel ?? null,
      battery_v: vehicle.stats.batteryStatus?.value ?? null,
      mileage: vehicle.stats.odometer ?? null,
      ignition: vehicle.stats.isRunning ?? false,
      updated_at: vehicle.stats.lastUpdated ?? new Date().toISOString(),
    };
  } catch (err) {
    console.warn("Bouncie fetch threw", err);
    return null;
  }
}

// Deterministic mock that simulates the van loitering near Newport Beach
// when Bouncie API isn't wired up. Used only in dev and as a clear fallback.
function mockPosition(): VanPosition {
  const t = Date.now() / 1000;
  const radius = 0.005; // ~0.3 miles
  const orbit = (t / 120) % (Math.PI * 2);
  return {
    lat: HOME_LAT + Math.cos(orbit) * radius,
    lng: HOME_LNG + Math.sin(orbit) * radius,
    heading: ((orbit * 180) / Math.PI) % 360,
    speed_mph: 0,
    fuel_pct: 0.78,
    battery_v: 12.6,
    mileage: 18420,
    ignition: false,
    updated_at: new Date().toISOString(),
  };
}

export async function getVanPosition(): Promise<VanPosition & { source: "bouncie" | "mock" }> {
  const live = await fetchBouncieVehicle();
  if (live) return { ...live, source: "bouncie" };
  return { ...mockPosition(), source: "mock" };
}
