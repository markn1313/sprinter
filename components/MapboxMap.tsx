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

interface DroppedPin {
  lat: number;
  lng: number;
}

interface Props {
  position: (VanPosition & { source?: "bouncie" | "bouncie_cached" | "mock" }) | null;
  pins?: MapPin[];
  polyline?: string | null;
  className?: string;
  fitBounds?: boolean;
  fitPadding?: number | { top: number; bottom: number; left: number; right: number };
  fitMaxZoom?: number;
  // TV / large-screen mode renders a much thicker polyline so the route is
  // legible from across the cabin. Defaults are tuned for phone screens.
  routeLineWidth?: number;
  routeGlowWidth?: number;
  focusMode?: FocusMode;
  focusKey?: number;
  dropPinMode?: boolean;
  droppedPin?: DroppedPin | null;
  onMapClick?: (lat: number, lng: number) => void;
  onDroppedPinClick?: () => void;
}

const PIN_HTML: Record<MapPin["kind"], (idx?: number) => string> = {
  // Red flag for pickup spots (start of trip)
  pickup: () =>
    `<div style="font-size:30px;line-height:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,.6));">🚩</div>`,
  // Finish-line flag for the final destination
  dropoff: () =>
    `<div style="font-size:30px;line-height:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,.6));">🏁</div>`,
  // Red flag for intermediate stops (numbered)
  stop: (idx) =>
    `<div style="position:relative;font-size:30px;line-height:1;filter:drop-shadow(0 2px 3px rgba(0,0,0,.6));">🚩<span style="position:absolute;top:8px;left:14px;background:#dc2626;color:white;border-radius:9999px;width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;font-family:-apple-system,system-ui,sans-serif;">${idx ?? ""}</span></div>`,
  // Blue pulsing dot — "you are here"
  mark: () =>
    `<div style="position:relative;width:18px;height:18px;"><span style="position:absolute;inset:0;border-radius:50%;background:#3b82f6;box-shadow:0 0 0 2px white,0 0 0 4px rgba(59,130,246,.45);"></span><span style="position:absolute;inset:-6px;border-radius:50%;background:#3b82f6;opacity:.35;animation:sprinter-pulse 1.6s ease-out infinite;"></span></div>`,
  passenger: () =>
    `<div style="font-size:24px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6));">👤</div>`,
};

export default function MapboxMap({
  position,
  pins = [],
  polyline,
  className,
  fitBounds = true,
  fitPadding = 60,
  fitMaxZoom = 14,
  routeLineWidth = 4,
  routeGlowWidth = 8,
  focusMode = "auto",
  focusKey = 0,
  dropPinMode = false,
  droppedPin = null,
  onMapClick,
  onDroppedPinClick,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const vanMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const pinMarkersRef = useRef<mapboxgl.Marker[]>([]);
  const dropPinMarkerRef = useRef<mapboxgl.Marker | null>(null);
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
    // Zoom/compass controls intentionally NOT added — Mark prefers a clean map.
    // Pinch-to-zoom + double-tap zoom still work natively.

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
            "line-width": routeGlowWidth,
            "line-opacity": 0.25,
            "line-blur": 6,
          },
        });
        map.addLayer({
          id: "trip-route-line",
          type: "line",
          source: "trip-route",
          paint: {
            "line-color": "#10b981",
            "line-width": routeLineWidth,
            "line-opacity": 0.98,
          },
        });
      } catch (err) {
        console.warn("Traffic layer add failed:", err);
      }
    });

    mapRef.current = map;

    // iOS PWA + Mobile Safari sometimes settle on the final viewport size
    // 100–500ms AFTER the map initializes, leaving Mapbox's canvas measured
    // at the smaller initial value. ResizeObserver catches every container
    // resize (orientation change, URL bar collapse, tab show/hide) and tells
    // Mapbox to re-measure. We also fire a few `resize()` calls right after
    // mount as belt-and-suspenders for the first-paint case.
    let ro: ResizeObserver | null = null;
    try {
      ro = new ResizeObserver(() => {
        try {
          map.resize();
        } catch {
          /* map may be torn down */
        }
      });
      ro.observe(containerRef.current);
    } catch {
      // ResizeObserver unavailable — skip silently
    }
    const resizeTimers = [50, 200, 500, 1500].map((ms) =>
      setTimeout(() => {
        try {
          map.resize();
        } catch {}
      }, ms),
    );

    return () => {
      resizeTimers.forEach((t) => clearTimeout(t));
      try {
        ro?.disconnect();
      } catch {}
      // Aggressively null out marker refs before tearing down the map so any
      // queued mutation observers don't try to read removed DOM nodes.
      try {
        if (vanMarkerRef.current) {
          vanMarkerRef.current.remove();
          vanMarkerRef.current = null;
        }
      } catch {}
      try {
        pinMarkersRef.current.forEach((m) => {
          try { m.remove(); } catch {}
        });
        pinMarkersRef.current = [];
      } catch {}
      try {
        if (dropPinMarkerRef.current) {
          dropPinMarkerRef.current.remove();
          dropPinMarkerRef.current = null;
        }
      } catch {}
      try {
        map.remove();
      } catch {}
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update van marker — black Sprinter silhouette
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !position) return;
    if (!vanMarkerRef.current) {
      const el = document.createElement("div");
      el.style.cssText = "width:36px;height:20px;display:flex;align-items:center;justify-content:center;";
      el.innerHTML = `
        <svg width="36" height="20" viewBox="0 0 64 36" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 2px 4px rgba(0,0,0,.6));">
          <!-- Sprinter van silhouette -->
          <path d="M4 24 L4 12 Q4 6 10 6 L40 6 Q46 6 50 10 L60 16 L60 24 Q60 26 58 26 L52 26 A4 4 0 1 0 44 26 L20 26 A4 4 0 1 0 12 26 L6 26 Q4 26 4 24 Z" fill="#0a0a0a" stroke="#fff" stroke-width="1.2"/>
          <!-- Windshield -->
          <path d="M40 8 L48 10 L56 16 L40 16 Z" fill="#3b3b3b"/>
          <!-- Side window -->
          <rect x="14" y="10" width="22" height="6" rx="1" fill="#3b3b3b"/>
          <!-- Wheels -->
          <circle cx="16" cy="26" r="3.5" fill="#1a1a1a" stroke="#fff" stroke-width="0.8"/>
          <circle cx="48" cy="26" r="3.5" fill="#1a1a1a" stroke="#fff" stroke-width="0.8"/>
        </svg>`;
      vanMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: "center" })
        .setLngLat([position.lng, position.lat])
        .addTo(map);
    } else {
      vanMarkerRef.current.setLngLat([position.lng, position.lat]);
    }
  }, [position]);

  // Update pin markers — defensively guard each step so a single bad pin
  // can't take down the whole tree.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    pinMarkersRef.current.forEach((m) => {
      try { m.remove(); } catch {}
    });
    pinMarkersRef.current = pins
      .map((p) => {
        try {
          const html = PIN_HTML[p.kind]?.(p.index);
          if (!html) return null;
          const el = document.createElement("div");
          el.innerHTML = html;
          const anchor = p.kind === "mark" || p.kind === "passenger" ? "center" : "bottom";
          const marker = new mapboxgl.Marker({ element: el, anchor }).setLngLat([p.lng, p.lat]);
          if (p.label) marker.setPopup(new mapboxgl.Popup({ offset: 18 }).setText(p.label));
          marker.addTo(map);
          return marker;
        } catch (err) {
          console.warn("[MapboxMap] marker failed", err);
          return null;
        }
      })
      .filter((m): m is mapboxgl.Marker => m !== null);
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

  // Live-update line widths when caller bumps them (e.g. TV mode).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => {
      try {
        if (map.getLayer("trip-route-line")) {
          map.setPaintProperty("trip-route-line", "line-width", routeLineWidth);
        }
        if (map.getLayer("trip-route-glow")) {
          map.setPaintProperty("trip-route-glow", "line-width", routeGlowWidth);
        }
      } catch {
        /* layers not ready yet */
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [routeLineWidth, routeGlowWidth]);

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
    // Round the dedupe key to ~5m precision so the van's normal jitter doesn't
    // re-fire fitBounds on every poll. We still re-fit when something
    // meaningfully moves or a stop is added/removed.
    const key = allPoints.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join(";");
    if (key === fittedRef.current) return;
    fittedRef.current = key;
    const bounds = new mapboxgl.LngLatBounds();
    allPoints.forEach((p) => bounds.extend(p));
    map.fitBounds(bounds, { padding: fitPadding, maxZoom: fitMaxZoom, duration: 800 });
  }, [allPoints, fitBounds, focusMode, fitPadding, fitMaxZoom]);

  // Long-press / right-click on the map → drop a pin at that point.
  // Mapbox's `contextmenu` event fires on long-press for touch devices and
  // right-click on desktop. Also supports the legacy `dropPinMode` toggle as a fallback.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !onMapClick) return;
    const longPressHandler = (e: mapboxgl.MapMouseEvent) => {
      onMapClick(e.lngLat.lat, e.lngLat.lng);
      e.preventDefault?.();
    };
    map.on("contextmenu", longPressHandler);

    // Backup: manually detect long touchstart on the map canvas, since some iOS
    // PWAs swallow the contextmenu event.
    let touchTimer: ReturnType<typeof setTimeout> | null = null;
    let touchLngLat: { lng: number; lat: number } | null = null;
    const onTouchStart = (e: mapboxgl.MapTouchEvent) => {
      if (e.originalEvent.touches.length !== 1) return;
      touchLngLat = { lng: e.lngLat.lng, lat: e.lngLat.lat };
      touchTimer = setTimeout(() => {
        if (touchLngLat) {
          onMapClick(touchLngLat.lat, touchLngLat.lng);
          if ("vibrate" in navigator) try { navigator.vibrate?.(40); } catch {}
        }
      }, 550);
    };
    const cancelTouch = () => {
      if (touchTimer) {
        clearTimeout(touchTimer);
        touchTimer = null;
      }
      touchLngLat = null;
    };
    map.on("touchstart", onTouchStart);
    map.on("touchmove", cancelTouch);
    map.on("touchend", cancelTouch);
    map.on("touchcancel", cancelTouch);

    // Also handle the explicit drop-pin mode (legacy) — single click drops pin
    const clickHandler = (e: mapboxgl.MapMouseEvent) => {
      if (dropPinMode) {
        onMapClick(e.lngLat.lat, e.lngLat.lng);
      }
    };
    map.on("click", clickHandler);
    map.getCanvas().style.cursor = dropPinMode ? "crosshair" : "";

    return () => {
      map.off("contextmenu", longPressHandler);
      map.off("touchstart", onTouchStart);
      map.off("touchmove", cancelTouch);
      map.off("touchend", cancelTouch);
      map.off("touchcancel", cancelTouch);
      map.off("click", clickHandler);
      cancelTouch();
      map.getCanvas().style.cursor = "";
    };
  }, [dropPinMode, onMapClick]);

  // Render the dropped pin marker
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (dropPinMarkerRef.current) {
      dropPinMarkerRef.current.remove();
      dropPinMarkerRef.current = null;
    }
    if (!droppedPin) return;
    const el = document.createElement("div");
    el.style.cursor = "pointer";
    el.innerHTML = `<div style="position:relative;font-size:36px;line-height:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,.7));animation:drop-bounce .5s ease-out;">📍</div>`;
    el.onclick = (e) => {
      e.stopPropagation();
      onDroppedPinClick?.();
    };
    dropPinMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: "bottom" })
      .setLngLat([droppedPin.lng, droppedPin.lat])
      .addTo(map);
  }, [droppedPin, onDroppedPinClick]);

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
