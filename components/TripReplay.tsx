"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { api } from "@/lib/api-client";
import { Play, Pause, FastForward, Rewind, Loader2 } from "lucide-react";

interface SamplePoint {
  lat: number;
  lng: number;
  speed: number;
  ts: string;
  ignition: boolean;
}

interface ReplayResponse {
  samples: SamplePoint[];
  pickup: { lat: number; lng: number } | null;
  dropoff: { lat: number; lng: number } | null;
  raw_count: number;
  sample_count: number;
}

interface Props {
  token: string;
  tripId: string;
}

// Trip replay viewer. Loads the trip's GPS samples from /api/trips/[id]/replay,
// renders the route on a map, and lets Mark scrub through the trip — van marker
// moves along the path, speed/time updates live. Three speeds: 1×, 4×, 16×.
export default function TripReplay({ token, tripId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const vanRef = useRef<mapboxgl.Marker | null>(null);
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<ReplayResponse | null>(null);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 4 | 16>(4);
  const tickRef = useRef<number | null>(null);

  // Fetch samples on mount
  useEffect(() => {
    let cancel = false;
    setLoading(true);
    (async () => {
      try {
        const res = await api<ReplayResponse>(token, `/api/trips/${tripId}/replay`);
        if (cancel) return;
        setData(res);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [token, tripId]);

  // Init map once data arrives
  useEffect(() => {
    if (!data || !containerRef.current || mapRef.current || data.samples.length === 0) return;
    const tk = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
    if (!tk) return;
    mapboxgl.accessToken = tk;
    const samples = data.samples;
    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/navigation-night-v1",
      center: [samples[0].lng, samples[0].lat],
      zoom: 13,
      attributionControl: false,
    });
    mapRef.current = map;

    map.on("load", () => {
      // Route line
      const coords = samples.map((s) => [s.lng, s.lat] as [number, number]);
      map.addSource("route", {
        type: "geojson",
        data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } },
      });
      map.addLayer({
        id: "route-glow",
        type: "line",
        source: "route",
        paint: { "line-color": "#06b6d4", "line-width": 10, "line-opacity": 0.25, "line-blur": 6 },
        layout: { "line-cap": "round", "line-join": "round" },
      });
      map.addLayer({
        id: "route",
        type: "line",
        source: "route",
        paint: { "line-color": "#22d3ee", "line-width": 4 },
        layout: { "line-cap": "round", "line-join": "round" },
      });

      // Pickup pin (amber)
      if (data.pickup) {
        const el = document.createElement("div");
        el.style.cssText = "width:18px;height:18px;border-radius:50%;background:#f59e0b;border:2px solid #1c1917;box-shadow:0 0 8px rgba(245,158,11,.6)";
        new mapboxgl.Marker({ element: el }).setLngLat([data.pickup.lng, data.pickup.lat]).addTo(map);
      }
      // Dropoff pin (blue)
      if (data.dropoff) {
        const el = document.createElement("div");
        el.style.cssText = "width:18px;height:18px;border-radius:50%;background:#3b82f6;border:2px solid #1c1917;box-shadow:0 0 8px rgba(59,130,246,.6)";
        new mapboxgl.Marker({ element: el }).setLngLat([data.dropoff.lng, data.dropoff.lat]).addTo(map);
      }

      // Van marker
      const vanEl = document.createElement("div");
      vanEl.style.cssText = "width:24px;height:24px;border-radius:50%;background:#10b981;border:3px solid #f0fdf4;box-shadow:0 0 14px rgba(16,185,129,.9)";
      const van = new mapboxgl.Marker({ element: vanEl }).setLngLat([samples[0].lng, samples[0].lat]).addTo(map);
      vanRef.current = van;

      // Fit bounds to the whole route
      const bounds = new mapboxgl.LngLatBounds();
      for (const c of coords) bounds.extend(c);
      if (data.pickup) bounds.extend([data.pickup.lng, data.pickup.lat]);
      if (data.dropoff) bounds.extend([data.dropoff.lng, data.dropoff.lat]);
      map.fitBounds(bounds, { padding: 60, duration: 800 });
    });

    return () => {
      mapRef.current = null;
      vanRef.current = null;
      map.remove();
    };
  }, [data]);

  // Move van marker as idx changes
  useEffect(() => {
    if (!data || !vanRef.current) return;
    const s = data.samples[idx];
    if (!s) return;
    vanRef.current.setLngLat([s.lng, s.lat]);
  }, [idx, data]);

  // Playback ticker
  useEffect(() => {
    if (!playing || !data || data.samples.length === 0) return;
    const tickMs = 1000 / speed; // 1 sample per (1/speed) seconds
    const id = window.setInterval(() => {
      setIdx((i) => {
        if (i >= data.samples.length - 1) {
          setPlaying(false);
          return i;
        }
        return i + 1;
      });
    }, tickMs);
    tickRef.current = id;
    return () => {
      if (tickRef.current) window.clearInterval(tickRef.current);
    };
  }, [playing, speed, data]);

  const stats = useMemo(() => {
    if (!data || data.samples.length === 0) return null;
    const start = new Date(data.samples[0].ts).getTime();
    const end = new Date(data.samples[data.samples.length - 1].ts).getTime();
    const totalMin = Math.max(1, Math.round((end - start) / 60_000));
    let maxSpeed = 0;
    let sumSpeed = 0;
    let movingCount = 0;
    for (const s of data.samples) {
      if (s.speed > maxSpeed) maxSpeed = s.speed;
      if (s.speed > 1) {
        sumSpeed += s.speed;
        movingCount++;
      }
    }
    const avg = movingCount > 0 ? Math.round(sumSpeed / movingCount) : 0;
    return { totalMin, maxSpeed: Math.round(maxSpeed), avgSpeed: avg };
  }, [data]);

  if (loading) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-8 text-center">
        <Loader2 size={20} className="mx-auto animate-spin text-zinc-500" />
        <div className="mt-2 text-xs text-zinc-500">Loading trip replay…</div>
      </div>
    );
  }
  if (!data || data.samples.length === 0) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-6 text-center text-sm text-zinc-500">
        No GPS data recorded for this trip.
      </div>
    );
  }

  const cur = data.samples[idx];
  const elapsedMin = Math.round((new Date(cur.ts).getTime() - new Date(data.samples[0].ts).getTime()) / 60_000);

  return (
    <div className="space-y-3">
      <div className="relative h-72 overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950">
        <div ref={containerRef} className="h-full w-full" />
        {/* Live overlay: speed + time */}
        <div className="pointer-events-none absolute left-3 top-3 rounded-lg border border-zinc-800 bg-zinc-950/85 px-3 py-2 backdrop-blur">
          <div className="font-mono text-2xl font-bold tabular-nums text-emerald-300">{Math.round(cur.speed)}</div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">mph</div>
        </div>
        <div className="pointer-events-none absolute right-3 top-3 rounded-lg border border-zinc-800 bg-zinc-950/85 px-3 py-2 text-right backdrop-blur">
          <div className="font-mono text-2xl font-bold tabular-nums text-zinc-100">+{elapsedMin}m</div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">elapsed</div>
        </div>
      </div>

      {/* Stats strip */}
      {stats && (
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Duration" value={`${stats.totalMin}m`} />
          <Stat label="Max speed" value={`${stats.maxSpeed} mph`} />
          <Stat label="Avg speed" value={`${stats.avgSpeed} mph`} />
        </div>
      )}

      {/* Scrubber */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-3">
        <input
          type="range"
          min={0}
          max={data.samples.length - 1}
          value={idx}
          onChange={(e) => setIdx(Number(e.target.value))}
          className="w-full accent-emerald-500"
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <button
            onClick={() => setIdx(Math.max(0, idx - 10))}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 active:scale-95"
          >
            <Rewind size={14} />
          </button>
          <button
            onClick={() => setPlaying((p) => !p)}
            className="flex h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-emerald-600 text-sm font-semibold text-white active:scale-95"
          >
            {playing ? <Pause size={16} /> : <Play size={16} />}
            {playing ? "Pause" : "Play"}
          </button>
          <button
            onClick={() => setIdx(Math.min(data.samples.length - 1, idx + 10))}
            className="flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 active:scale-95"
          >
            <FastForward size={14} />
          </button>
          <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
            {([1, 4, 16] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={`px-2 py-1 text-[10px] font-mono font-semibold tabular-nums ${
                  speed === s ? "rounded bg-emerald-600 text-white" : "text-zinc-400"
                }`}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-2 text-center">
      <div className="font-mono text-base font-bold tabular-nums text-zinc-100">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
    </div>
  );
}
