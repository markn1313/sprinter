"use client";

import { useEffect, useMemo, useRef } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap, CircleMarker, Polyline } from "react-leaflet";
import L, { LatLngBoundsExpression } from "leaflet";
import "leaflet/dist/leaflet.css";
import { VanPosition } from "@/lib/types";
import { decodePolyline } from "@/lib/routing";

export interface MapPin {
  kind: "pickup" | "dropoff" | "stop" | "mark" | "passenger";
  lat: number;
  lng: number;
  label?: string;
  index?: number;
  // Stable identifier so a drag-end callback can resolve which underlying
  // record to update. Trip stops use their UUID; pickup/dropoff use the
  // sentinel "pickup" / "dropoff" since there's exactly one per trip.
  id?: string;
}

interface Props {
  position: (VanPosition & { source?: "bouncie" | "bouncie_cached" | "mock" }) | null;
  pins?: MapPin[];
  polyline?: string | null;
  polylineColor?: string;
  className?: string;
  zoom?: number;
  fitBounds?: boolean;
}

const vanIcon = L.divIcon({
  className: "van-marker",
  html: `<div style="width:32px;height:32px;border-radius:50%;background:#10b981;border:3px solid #052e1f;box-shadow:0 0 0 4px rgba(16,185,129,.35);display:flex;align-items:center;justify-content:center;color:white;font-size:16px;">🚐</div>`,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
});

function pinIcon(color: string, glyph: string, size = 28): L.DivIcon {
  return L.divIcon({
    className: "pin-marker",
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 0 0 2px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;color:white;font-size:${Math.round(size * 0.45)}px;font-weight:700;">${glyph}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

const PICKUP_ICON = pinIcon("#f59e0b", "P");
const DROPOFF_ICON = pinIcon("#3b82f6", "D");
const MARK_ICON = pinIcon("#a855f7", "M");
const PASSENGER_ICON = pinIcon("#ec4899", "👤", 26);
const stopIcon = (n: number) => pinIcon("#06b6d4", String(n), 22);

function FitBounds({ points }: { points: [number, number][] }) {
  const map = useMap();
  const lastKey = useRef<string>("");
  useEffect(() => {
    if (points.length < 2) return;
    const key = points.map((p) => p.join(",")).join(";");
    if (key === lastKey.current) return;
    lastKey.current = key;
    const bounds: LatLngBoundsExpression = points.map((p) => [p[0], p[1]]);
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14, animate: true });
  }, [points, map]);
  return null;
}

export default function LiveMap({
  position,
  pins = [],
  polyline,
  polylineColor = "#10b981",
  className,
  zoom = 13,
  fitBounds = true,
}: Props) {
  const center = useMemo<[number, number]>(() => {
    if (position) return [position.lat, position.lng];
    if (pins[0]) return [pins[0].lat, pins[0].lng];
    return [33.6189, -117.9298];
  }, [position, pins]);

  const decoded = useMemo(() => (polyline ? decodePolyline(polyline) : null), [polyline]);

  const allPoints = useMemo<[number, number][]>(() => {
    const pts: [number, number][] = [];
    if (position) pts.push([position.lat, position.lng]);
    pins.forEach((p) => pts.push([p.lat, p.lng]));
    return pts;
  }, [position, pins]);

  return (
    <div className={className}>
      <MapContainer
        center={center}
        zoom={zoom}
        scrollWheelZoom
        style={{ height: "100%", width: "100%", borderRadius: "inherit" }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {decoded && decoded.length > 1 && (
          <Polyline
            positions={decoded.map(([lng, lat]) => [lat, lng] as [number, number])}
            pathOptions={{ color: polylineColor, weight: 4, opacity: 0.85 }}
          />
        )}
        {position && (
          <>
            <Marker position={[position.lat, position.lng]} icon={vanIcon}>
              <Popup>
                <strong>Sprinter</strong>
                {position.source === "mock" ? " (mock)" : ""}
                <br />
                {position.speed_mph?.toFixed(0) ?? 0} mph
              </Popup>
            </Marker>
            <CircleMarker
              center={[position.lat, position.lng]}
              radius={20}
              pathOptions={{ color: "#10b981", fillColor: "#10b981", fillOpacity: 0.08, weight: 1 }}
            />
          </>
        )}
        {pins.map((p, i) => {
          const icon =
            p.kind === "pickup"
              ? PICKUP_ICON
              : p.kind === "dropoff"
                ? DROPOFF_ICON
                : p.kind === "mark"
                  ? MARK_ICON
                  : p.kind === "passenger"
                    ? PASSENGER_ICON
                    : stopIcon(p.index ?? i + 1);
          return (
            <Marker key={`${p.kind}-${i}`} position={[p.lat, p.lng]} icon={icon}>
              <Popup>{p.label ?? p.kind}</Popup>
            </Marker>
          );
        })}
        {fitBounds && allPoints.length >= 2 && <FitBounds points={allPoints} />}
      </MapContainer>
    </div>
  );
}
