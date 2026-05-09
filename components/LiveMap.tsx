"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap, CircleMarker } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { VanPosition } from "@/lib/types";

interface Props {
  position: (VanPosition & { source?: "bouncie" | "mock" }) | null;
  pickup?: { lat: number; lng: number; label?: string } | null;
  dropoff?: { lat: number; lng: number; label?: string } | null;
  className?: string;
  zoom?: number;
  follow?: boolean;
}

const vanIcon = L.divIcon({
  className: "van-marker",
  html: `<div style="width:28px;height:28px;border-radius:50%;background:#10b981;border:3px solid #052e1f;box-shadow:0 0 0 3px rgba(16,185,129,.35);display:flex;align-items:center;justify-content:center;color:white;font-size:14px;">🚐</div>`,
  iconSize: [28, 28],
  iconAnchor: [14, 14],
});

const pinIcon = (color: string) =>
  L.divIcon({
    className: "pin-marker",
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 0 0 2px rgba(0,0,0,.4);"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });

function FollowVan({ position }: { position: { lat: number; lng: number } | null }) {
  const map = useMap();
  const lastRef = useRef<string>("");
  useEffect(() => {
    if (!position) return;
    const key = `${position.lat.toFixed(4)},${position.lng.toFixed(4)}`;
    if (key === lastRef.current) return;
    lastRef.current = key;
    map.panTo([position.lat, position.lng], { animate: true });
  }, [position, map]);
  return null;
}

export default function LiveMap({
  position,
  pickup,
  dropoff,
  className,
  zoom = 13,
  follow = true,
}: Props) {
  const center = useMemo<[number, number]>(() => {
    if (position) return [position.lat, position.lng];
    if (pickup) return [pickup.lat, pickup.lng];
    return [33.6189, -117.9298];
  }, [position, pickup]);

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
        {position && (
          <>
            <Marker position={[position.lat, position.lng]} icon={vanIcon}>
              <Popup>
                <div style={{ fontSize: 12 }}>
                  <div>
                    <strong>Sprinter</strong>{" "}
                    {position.source === "mock" ? "(mock)" : ""}
                  </div>
                  <div>{position.speed_mph?.toFixed(0) ?? 0} mph</div>
                  {position.fuel_pct != null && (
                    <div>Fuel {(position.fuel_pct * 100).toFixed(0)}%</div>
                  )}
                </div>
              </Popup>
            </Marker>
            <CircleMarker
              center={[position.lat, position.lng]}
              radius={20}
              pathOptions={{ color: "#10b981", fillColor: "#10b981", fillOpacity: 0.1, weight: 1 }}
            />
            {follow && <FollowVan position={position} />}
          </>
        )}
        {pickup && (
          <Marker position={[pickup.lat, pickup.lng]} icon={pinIcon("#f59e0b")}>
            <Popup>Pickup{pickup.label ? `: ${pickup.label}` : ""}</Popup>
          </Marker>
        )}
        {dropoff && (
          <Marker position={[dropoff.lat, dropoff.lng]} icon={pinIcon("#3b82f6")}>
            <Popup>Dropoff{dropoff.label ? `: ${dropoff.label}` : ""}</Popup>
          </Marker>
        )}
      </MapContainer>
    </div>
  );
}
