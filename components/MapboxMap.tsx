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
  // Pixel size of the van marker. The van rotates to its `heading` so it
  // visibly points in the direction of travel.
  vanIconSize?: number;
  // Multiplier for pickup / dropoff / stop pin icons. 1 = phone default,
  // 2+ = TV / large screens.
  pinScale?: number;
  // Follow-cam mode: pitch the map, rotate it to the van's bearing, lock
  // center on the van. Real-GPS feel for the TV in-trip view. Overrides
  // fitBounds while active.
  followCam?: boolean;
  followCamPitch?: number; // degrees, 0 = top-down, 60 = strong perspective
  followCamZoom?: number;
  focusMode?: FocusMode;
  focusKey?: number;
  dropPinMode?: boolean;
  droppedPin?: DroppedPin | null;
  onMapClick?: (lat: number, lng: number) => void;
  onDroppedPinClick?: () => void;
}

const PIN_HTML = (scale: number = 1): Record<MapPin["kind"], (idx?: number) => string> => {
  const base = Math.round(30 * scale);
  const stopBadgeOffset = Math.round(8 * scale);
  const stopBadgeLeft = Math.round(14 * scale);
  const stopBadgeSize = Math.round(16 * scale);
  const stopBadgeFont = Math.max(10, Math.round(10 * scale));
  return {
    pickup: () =>
      `<div style="font-size:${base}px;line-height:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,.7));">🚩</div>`,
    dropoff: () =>
      `<div style="font-size:${base}px;line-height:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,.7));">🏁</div>`,
    stop: (idx) =>
      `<div style="position:relative;font-size:${base}px;line-height:1;filter:drop-shadow(0 2px 4px rgba(0,0,0,.7));">🚩<span style="position:absolute;top:${stopBadgeOffset}px;left:${stopBadgeLeft}px;background:#dc2626;color:white;border-radius:9999px;width:${stopBadgeSize}px;height:${stopBadgeSize}px;display:inline-flex;align-items:center;justify-content:center;font-size:${stopBadgeFont}px;font-weight:700;font-family:-apple-system,system-ui,sans-serif;">${idx ?? ""}</span></div>`,
    mark: () =>
      `<div style="position:relative;width:18px;height:18px;"><span style="position:absolute;inset:0;border-radius:50%;background:#3b82f6;box-shadow:0 0 0 2px white,0 0 0 4px rgba(59,130,246,.45);"></span><span style="position:absolute;inset:-6px;border-radius:50%;background:#3b82f6;opacity:.35;animation:sprinter-pulse 1.6s ease-out infinite;"></span></div>`,
    passenger: () =>
      `<div style="font-size:${Math.round(24 * scale)}px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6));">👤</div>`,
  };
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
  vanIconSize = 36,
  pinScale = 1,
  followCam = false,
  followCamPitch = 60,
  followCamZoom = 16.5,
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
    // Read at module-eval time too in case the inlined value got cached weirdly.
    const token: string | undefined =
      process.env.NEXT_PUBLIC_MAPBOX_TOKEN ||
      (globalThis as { __MAPBOX_TOKEN__?: string }).__MAPBOX_TOKEN__ ||
      undefined;
    if (!token) {
      console.warn("NEXT_PUBLIC_MAPBOX_TOKEN missing — map will be blank");
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
      // Hybrid: satellite imagery with street labels/roads on top.
      style: "mapbox://styles/mapbox/satellite-streets-v12",
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

  // Track last position so we can derive a heading when Bouncie's heading
  // field is missing or stuck at 0 (which is the case on the free Bouncie
  // tier we have today).
  const lastVanLngLatRef = useRef<{ lng: number; lat: number; bearing: number } | null>(null);

  // Update van marker — black Sprinter silhouette. Rotates to derived bearing
  // so it visibly points in the direction of travel. The SVG faces RIGHT
  // (east) at rotation 0, so we offset by -90° so bearing 0 (north) = up.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !position) return;
    // Top-down (overhead) Sprinter — viewBox 36 wide × 64 tall. The front of
    // the van faces UP at rotation 0, so we rotate by the bearing directly
    // (no offset). Width = vanIconSize, height keeps aspect ratio.
    const w = vanIconSize;
    const h = Math.round((vanIconSize * 64) / 36);
    const overheadSvg = `
      <svg width="${w}" height="${h}" viewBox="0 0 36 64" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 2px 5px rgba(0,0,0,.75));overflow:visible;">
        <!-- Side mirrors -->
        <ellipse cx="3" cy="13" rx="2.6" ry="1.4" fill="#0a0a0a" stroke="#fff" stroke-width="0.6"/>
        <ellipse cx="33" cy="13" rx="2.6" ry="1.4" fill="#0a0a0a" stroke="#fff" stroke-width="0.6"/>
        <!-- Body -->
        <rect x="5" y="4" width="26" height="56" rx="5" fill="#0a0a0a" stroke="#ffffff" stroke-width="1.3"/>
        <!-- Hood line -->
        <line x1="6.5" y1="11" x2="29.5" y2="11" stroke="#ffffff" stroke-width="0.5" opacity="0.45"/>
        <!-- Windshield (front, near top) -->
        <path d="M 8 12 L 28 12 L 30 19 L 6 19 Z" fill="#60a5fa" opacity="0.65"/>
        <!-- Roof centerline -->
        <line x1="18" y1="22" x2="18" y2="55" stroke="#3b3b3b" stroke-width="0.6" opacity="0.55"/>
        <!-- Rear door split -->
        <line x1="6" y1="55" x2="30" y2="55" stroke="#ffffff" stroke-width="0.5" opacity="0.45"/>
        <!-- Direction arrow at the front -->
        <path d="M 14 5 L 18 1.5 L 22 5 Z" fill="#10b981" stroke="#ffffff" stroke-width="0.6"/>
      </svg>`;
    if (!vanMarkerRef.current) {
      const outer = document.createElement("div");
      outer.style.cssText = `width:${w}px;height:${h}px;display:flex;align-items:center;justify-content:center;`;
      const inner = document.createElement("div");
      inner.className = "sprinter-van-rotor";
      inner.style.cssText = `width:${w}px;height:${h}px;transform-origin:center center;will-change:transform;transition:transform 250ms linear;display:flex;align-items:center;justify-content:center;`;
      inner.innerHTML = overheadSvg;
      outer.appendChild(inner);
      vanMarkerRef.current = new mapboxgl.Marker({ element: outer, anchor: "center" })
        .setLngLat([position.lng, position.lat])
        .addTo(map);
    } else {
      vanMarkerRef.current.setLngLat([position.lng, position.lat]);
      const outer = vanMarkerRef.current.getElement();
      if (outer && (outer.style.width !== `${w}px` || outer.style.height !== `${h}px`)) {
        outer.style.width = `${w}px`;
        outer.style.height = `${h}px`;
        const inner = outer.querySelector(".sprinter-van-rotor") as HTMLElement | null;
        if (inner) {
          inner.style.width = `${w}px`;
          inner.style.height = `${h}px`;
          inner.innerHTML = overheadSvg;
        }
      }
    }
    // Derive bearing from successive lng/lat (since Bouncie's heading field
    // is reported as 0 on our tier). Use Bouncie heading if it's non-zero;
    // else compute from movement; else hold the last bearing so the icon
    // doesn't snap to north when stopped at a light.
    let bearing = lastVanLngLatRef.current?.bearing ?? 0;
    const reported = typeof position.heading === "number" ? position.heading : 0;
    if (reported > 0 && reported < 360) {
      bearing = reported;
    } else if (lastVanLngLatRef.current) {
      const prev = lastVanLngLatRef.current;
      const dLng = position.lng - prev.lng;
      const dLat = position.lat - prev.lat;
      // Only update bearing on meaningful movement (~10m) to avoid spinning
      // at idle.
      if (Math.abs(dLng) + Math.abs(dLat) > 0.0001) {
        const φ1 = (prev.lat * Math.PI) / 180;
        const φ2 = (position.lat * Math.PI) / 180;
        const λ1 = (prev.lng * Math.PI) / 180;
        const λ2 = (position.lng * Math.PI) / 180;
        const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
        const x =
          Math.cos(φ1) * Math.sin(φ2) -
          Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
        bearing = (Math.atan2(y, x) * 180) / Math.PI;
        if (bearing < 0) bearing += 360;
      }
    }
    lastVanLngLatRef.current = { lng: position.lng, lat: position.lat, bearing };
    // Overhead SVG natively faces UP (north) at rotation 0. In follow-cam
    // mode the map itself rotates to the van's bearing, so the icon stays
    // pointing up on the screen (= forward in the driver's view). In normal
    // 2D mode we rotate the icon to the bearing instead.
    const outer = vanMarkerRef.current.getElement();
    const inner = outer?.querySelector(".sprinter-van-rotor") as HTMLElement | null;
    if (inner) {
      inner.style.transform = followCam ? `rotate(0deg)` : `rotate(${bearing}deg)`;
    }
  }, [position, vanIconSize, followCam]);

  // Follow-cam: keep the map centered on the van, tilted, and rotated to
  // the van's heading so the road ahead is always "up" — like a real GPS.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !followCam || !position) return;
    const bearing = lastVanLngLatRef.current?.bearing ?? 0;
    const apply = () => {
      try {
        map.easeTo({
          center: [position.lng, position.lat],
          bearing,
          pitch: followCamPitch,
          zoom: followCamZoom,
          duration: 1200,
          essential: true,
        });
      } catch {
        /* ignore */
      }
    };
    if (map.isStyleLoaded()) apply();
    else map.once("load", apply);
  }, [position, followCam, followCamPitch, followCamZoom]);

  // When follow-cam is turned OFF, reset pitch/bearing so subsequent fits
  // give a true top-down view again.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || followCam) return;
    try {
      map.easeTo({ pitch: 0, bearing: 0, duration: 600, essential: true });
    } catch {}
    fittedRef.current = ""; // force a re-fit on next allPoints change
  }, [followCam]);

  // Update pin markers — defensively guard each step so a single bad pin
  // can't take down the whole tree.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    pinMarkersRef.current.forEach((m) => {
      try { m.remove(); } catch {}
    });
    const pinHtml = PIN_HTML(pinScale);
    pinMarkersRef.current = pins
      .map((p) => {
        try {
          const html = pinHtml[p.kind]?.(p.index);
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
  }, [pins, pinScale]);

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
    if (followCam) return; // follow-cam owns the camera
    // Round the dedupe key to ~5m precision so the van's normal jitter doesn't
    // re-fire fitBounds on every poll. We still re-fit when something
    // meaningfully moves or a stop is added/removed.
    const key = allPoints.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join(";");
    if (key === fittedRef.current) return;
    fittedRef.current = key;
    const bounds = new mapboxgl.LngLatBounds();
    allPoints.forEach((p) => bounds.extend(p));
    map.fitBounds(bounds, { padding: fitPadding, maxZoom: fitMaxZoom, duration: 800 });
  }, [allPoints, fitBounds, focusMode, fitPadding, fitMaxZoom, followCam]);

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
