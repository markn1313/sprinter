"use client";

import { useInsights, type InsightStats } from "@/components/useInsights";
import { Activity, Clock, DollarSign, Gauge, Route as RouteIcon } from "lucide-react";

export default function InsightsCard({ token }: { token: string }) {
  const { data } = useInsights(token);
  if (!data) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4">
        <div className="text-xs uppercase tracking-wider text-zinc-500">Today</div>
        <div className="mt-2 text-sm text-zinc-500">Loading driving stats…</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <StatBlock label="Today" stats={data.today} accent="emerald" />
      <StatBlock label="This week" stats={data.week} accent="blue" />
    </div>
  );
}

function StatBlock({ label, stats, accent }: { label: string; stats: InsightStats; accent: "emerald" | "blue" }) {
  const accentText = accent === "emerald" ? "text-emerald-300" : "text-blue-300";
  const accentBorder = accent === "emerald" ? "border-emerald-700/40" : "border-blue-700/40";
  return (
    <div className={`rounded-2xl border ${accentBorder} bg-zinc-950/80 p-4`}>
      <div className="flex items-baseline justify-between">
        <div className="text-xs uppercase tracking-wider text-zinc-500">{label}</div>
        <div className="text-[10px] text-zinc-500">{stats.trips_completed} trip{stats.trips_completed === 1 ? "" : "s"}</div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
        <Cell
          icon={<RouteIcon size={14} className={accentText} />}
          label="Miles"
          value={stats.miles.toString()}
          unit="mi"
          accent={accentText}
        />
        <Cell
          icon={<Clock size={14} className={accentText} />}
          label="Driving"
          value={fmtMinutes(stats.driving_minutes)}
          accent={accentText}
        />
        <Cell
          icon={<Gauge size={14} className={accentText} />}
          label="Avg speed"
          value={stats.avg_speed_mph.toString()}
          unit="mph"
          accent={accentText}
        />
        <Cell
          icon={<DollarSign size={14} className={accentText} />}
          label="Fuel"
          value={`$${stats.fuel_cost_dollars}`}
          accent={accentText}
        />
        {stats.idle_minutes > 0 && (
          <Cell
            icon={<Activity size={14} className="text-amber-400" />}
            label="Idle"
            value={fmtMinutes(stats.idle_minutes)}
            accent="text-amber-300"
          />
        )}
      </div>
    </div>
  );
}

function Cell({ icon, label, value, unit, accent }: { icon: React.ReactNode; label: string; value: string; unit?: string; accent: string }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-zinc-500">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span className={`font-mono text-lg font-bold tabular-nums ${accent}`}>{value}</span>
        {unit && <span className="text-[10px] text-zinc-500">{unit}</span>}
      </div>
    </div>
  );
}

function fmtMinutes(m: number): string {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}
