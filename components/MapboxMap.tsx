"use client";

import { useEffect, useRef, useMemo } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { VanPosition } from "@/lib/types";
import { decodePolyline } from "@/lib/routing";

export interface MapPin {
  kind: "pickup" | "dropoff" | "stop" | "mark" | "passenger";
  lat: number;
  lng: number;
  label?: string;
  index?: number;
}

type FocusMode = "auto" | "van" | "me" | "dest" | "van-me" | "me-dest";

interface Props {
  position: (VanPosition & { source?: "bouncie" | "mock" }) | null;
  pins?: MapPin[];
  polyline?: string | null;
  className?: string;
  fitBounds?: boolean;
  focusMode?: FocusMode;
  focusKey?: number;
}

const PIN_STYLE: Record<MapPin["kind"], { color: string; glyph: string }> = {
  pickup: { color: "#f59e0b", glyph: "P" },
  dropoff: { color: "#3b82f6", glyph: "D" },
  stop: { color: "#06b6d4", glyph: "·" },
  mark: { color: "#a855f7", glyph: "M" },
  passenger: { color: "#ec4899", glyph: "·" },
};

export default function MapboxMap({ position, pins = [], polyline, className, fitBounds = true, focusMode = "auto", focusKey = 0 }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const vanMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const pinMarkersRef = useRef<mapboxgl.Marker[]>([]);
  const fittedRef = useRef<string>("");

  // Init
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!token) {
      console.warn("NEXT_PUBLIC_MAPBOX_TOKEN missing");
      return;
    }
    mapboxgl.accessToken = token;
    const center: [number, number] = position
      ? [position.lng, position.lat]
      : pins[0]
        ? [pins[0].lng, pins[0].lat]
        : [-117.9298, 33.6189];
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/navigation-night-v1",
      center,
      zoom: 13,
      attributionControl: false,
      cooperativeGestures: false,
    });
    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), "top-right");

    // Add traffic layer once style loads
    map.on("load", () => {
      try {
        map.addSource("mapbox-traffic", {
          type: "vector",
          url: "mapbox://mapbox.mapbox-traffic-v1",
        });
        map.addLayer({
          id: "traffic-overlay",
          type: "line",
          source: "mapbox-traffic",
          "source-layer": "traffic",
          paint: {
            "line-width": 2,
            "line-color": [
              "match",
              ["get", "congestion"],
              "low",
              "#22c55e",
              "moderate",
              "#f59e0b",
              "heavy",
              "#ef4444",
              "severe",
              "#7f1d1d",
              "transparent",
            ],
            "line-opacity": 0.7,
          },
        });

        // Empty source for our route polyline
        map.addSource("trip-route", {
          type: "geojson",
          data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [] } },
        });
        map.addLayer({
          id: "trip-route-glow",
          type: "line",
          source: "trip-route",
          paint: {
            "line-color": "#10b981",
            "line-width": 8,
            "line-opacity": 0.18,
            "line-blur": 4,
          },
        });
        map.addLayer({
          id: "trip-route-line",
          type: "line",
          source: "trip-route",
          paint: {
            "line-color": "#10b981",
            "line-width": 4,
            "line-opacity": 0.95,
          },
        });
      } catch (err) {
        console.warn("Traffic layer add failed:", err);
      }
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update van marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !position) return;
    if (!vanMarkerRef.current) {
      const el = document.createElement("div");
      el.innerHTML = `<div style="width:36px;height:36px;border-radius:50%;background:#10b981;border:3px solid #052e1f;box-shadow:0 0 0 4px rgba(16,185,129,.35);display:flex;align-items:center;justify-content:center;font-size:18px;">🚐</div>`;
      vanMarkerRef.current = new mapboxgl.Marker({ element: el }).setLngLat([position.lng, position.lat]).addTo(map);
    } else {
      vanMarkerRef.current.setLngLat([position.lng, position.lat]);
    }
  }, [position]);

  // Update pin markers
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    pinMarkersRef.current.forEach((m) => m.remove());
    pinMarkersRef.current = pins.map((p) => {
      const style = PIN_STYLE[p.kind];
      const glyph = p.index ? String(p.index) : style.glyph;
      const el = document.createElement("div");
      el.innerHTML = `<div style="width:28px;height:28px;border-radius:50%;background:${style.color};border:2px solid white;box-shadow:0 0 0 2px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;color:white;font-size:13px;font-weight:700;">${glyph}</div>`;
      const marker = new mapboxgl.Marker({ element: el }).setLngLat([p.lng, p.lat]);
      if (p.label) marker.setPopup(new mapboxgl.Popup({ offset: 18 }).setText(p.label));
      marker.addTo(map);
      return marker;
    });
  }, [pins]);

  // Update polyline
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      const src = map.getSource("trip-route") as mapboxgl.GeoJSONSource | undefined;
      if (!src) return;
      const coords = polyline ? decodePolyline(polyline) : [];
      src.setData({
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: coords },
      });
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [polyline]);

  // Auto-fit bounds (only in "auto" mode)
  const allPoints = useMemo<[number, number][]>(() => {
    const pts: [number, number][] = [];
    if (position) pts.push([position.lng, position.lat]);
    pins.forEach((p) => pts.push([p.lng, p.lat]));
    return pts;
  }, [position, pins]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !fitBounds || focusMode !== "auto" || allPoints.length < 2) return;
    const key = allPoints.map((p) => p.join(",")).join(";");
    if (key === fittedRef.current) return;
    fittedRef.current = key;
    const bounds = new mapboxgl.LngLatBounds();
    allPoints.forEach((p) => bounds.extend(p));
    map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 800 });
  }, [allPoints, fitBounds, focusMode]);

  // Imperative focus modes — triggered by focusKey changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || focusMode === "auto") return;
    const me = pins.find((p) => p.kind === "mark");
    const dest = pins.find((p) => p.kind === "dropoff") ?? pins.find((p) => p.kind === "pickup");
    const flyTo = (lat: number, lng: number) => map.flyTo({ center: [lng, lat], zoom: 14, duration: 700 });
    const fit = (pts: Array<{ lat: number; lng: number }>) => {
      const b = new mapboxgl.LngLatBounds();
      pts.forEach((p) => b.extend([p.lng, p.lat]));
      map.fitBounds(b, { padding: 80, maxZoom: 14, duration: 700 });
    };
    if (focusMode === "van" && position) flyTo(position.lat, position.lng);
    else if (focusMode === "me" && me) flyTo(me.lat, me.lng);
    else if (focusMode === "dest" && dest) flyTo(dest.lat, dest.lng);
    else if (focusMode === "van-me" && position && me) fit([{ lat: position.lat, lng: position.lng }, me]);
    else if (focusMode === "me-dest" && me && dest) fit([me, dest]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, focusMode]);

  return <div ref={containerRef} className={className} />;
}
