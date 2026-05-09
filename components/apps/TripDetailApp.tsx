"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Trip } from "@/lib/types";
import { api, postJson } from "@/lib/api-client";
import { useEta } from "@/components/useEta";
import { usePosition } from "@/components/usePosition";
import ClientMap from "@/components/ClientMap";
import { MapPin } from "@/components/LiveMap";
import EtaBadge from "@/components/EtaBadge";
import AddressAutocomplete from "@/components/AddressAutocomplete";
import { dollars, statusLabel, statusColor, shortTime, shortDate } from "@/lib/format";
import { googleMapsMultiStop } from "@/lib/maps-link";
import { ArrowLeft, Trash2, Navigation, X, Plus, Pencil, Save, Loader2 } from "lucide-react";

interface Stop {
  id: string;
  kind: "pickup" | "dropoff" | "stop";
  category?: string;
  address: string;
  lat: number | null;
  lng: number | null;
  arrived_at?: string | null;
}

interface TripWithStops extends Trip {
  stops?: Stop[];
  route_polyline?: string | null;
}

export default function TripDetailApp({ token, tripId }: { token: string; tripId: string }) {
  const [trip, setTrip] = useState<TripWithStops | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [scheduled, setScheduled] = useState("");
  const [passenger, setPassenger] = useState("");
  const [pickup, setPickup] = useState("");
  const [dropoff, setDropoff] = useState("");
  const [busy, setBusy] = useState(false);
  const { pos } = usePosition(token, 8000);
  const { eta } = useEta(token, tripId, 25_000);

  const refresh = async () => {
    try {
      const data = await api<{ trips: TripWithStops[] }>(token, "/api/trips");
      const t = data.trips.find((x) => x.id === tripId) ?? null;
      setTrip(t);
      if (t) {
        setPassenger(t.passenger_name);
        setPickup(t.pickup_address ?? "");
        setDropoff(t.dropoff_address ?? "");
        setScheduled(toLocalInput(t.scheduled_at));
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [tripId, token]);

  // Local staged stops — edits are NOT pushed to the driver until "Update driver" is tapped
  const [localStops, setLocalStops] = useState<Stop[] | null>(null);
  useEffect(() => {
    if (trip && localStops === null) {
      setLocalStops(trip.stops ?? []);
    }
  }, [trip, localStops]);
  const stops = localStops ?? trip?.stops ?? [];
  const serverStops = trip?.stops ?? [];
  const isDirty =
    localStops !== null &&
    (localStops.length !== serverStops.length ||
      localStops.some((s, i) => s.id !== serverStops[i]?.id));

  const pins = useMemo<MapPin[]>(() => {
    const out: MapPin[] = [];
    if (trip?.pickup_lat != null && trip.pickup_lng != null)
      out.push({ kind: "pickup", lat: trip.pickup_lat, lng: trip.pickup_lng, label: trip.pickup_address ?? undefined });
    if (trip?.dropoff_lat != null && trip.dropoff_lng != null)
      out.push({ kind: "dropoff", lat: trip.dropoff_lat, lng: trip.dropoff_lng, label: trip.dropoff_address ?? undefined });
    stops.forEach((s, i) => {
      if (s.lat != null && s.lng != null) out.push({ kind: "stop", lat: s.lat, lng: s.lng, label: s.address, index: i + 1 });
    });
    return out;
  }, [trip, stops]);

  const polyline = trip?.route_polyline ?? eta?.polyline ?? null;

  const navUrl = useMemo(() => {
    if (!trip) return null;
    const wp: Array<{ lat: number; lng: number; label?: string }> = [];
    if (trip.pickup_lat != null && trip.pickup_lng != null) wp.push({ lat: trip.pickup_lat, lng: trip.pickup_lng });
    stops.forEach((s) => { if (s.lat != null && s.lng != null) wp.push({ lat: s.lat, lng: s.lng }); });
    if (trip.dropoff_lat != null && trip.dropoff_lng != null)
      wp.push({ lat: trip.dropoff_lat, lng: trip.dropoff_lng, label: trip.dropoff_address ?? undefined });
    if (wp.length < 1) return null;
    return googleMapsMultiStop(wp);
  }, [trip, stops]);

  const save = async () => {
    setBusy(true);
    try {
      await fetch(`/api/trips/${tripId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          passenger_name: passenger,
          pickup_address: pickup || null,
          dropoff_address: dropoff || null,
          scheduled_at: fromLocalInput(scheduled),
        }),
      });
      setEditing(false);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  // Local-only operations — stage changes without pushing to driver
  const removeStop = (stopId: string) => {
    setLocalStops((prev) => (prev ?? []).filter((s) => s.id !== stopId));
  };

  const addStopAt = (
    index: number,
    r: { lat: number; lng: number; display: string },
  ) => {
    setLocalStops((prev) => {
      const cur = prev ?? [];
      const newStop: Stop = {
        id: crypto.randomUUID(),
        kind: "stop",
        address: r.display,
        lat: r.lat,
        lng: r.lng,
      } as Stop;
      const next = [...cur];
      next.splice(Math.max(0, Math.min(next.length, index)), 0, newStop);
      return next;
    });
  };

  const pushUpdateToDriver = async () => {
    if (!localStops) return;
    setBusy(true);
    try {
      await fetch(`/api/trips/${tripId}/stops`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ stops: localStops }),
      });
      // Re-pull from server so we sync with whatever was geocoded server-side
      setLocalStops(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const discardChanges = () => {
    setLocalStops(trip?.stops ?? []);
  };

  const deleteTrip = async () => {
    if (!confirm("Delete this trip? This can't be undone.")) return;
    await fetch(`/api/trips/${tripId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    window.location.href = `/m/${token}`;
  };

  if (error) return <div className="p-6 text-sm text-red-400">{error}</div>;
  if (!trip) return <div className="p-6 text-sm text-zinc-500">Loading…</div>;

  return (
    <div className="min-h-screen bg-zinc-950 pb-24">
      <header className="sticky top-0 z-20 border-b border-zinc-900 bg-zinc-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-3 py-3">
          <Link href={`/m/${token}`} className="flex items-center gap-1 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-900">
            <ArrowLeft size={16} />
          </Link>
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
            <span className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider text-white ${statusColor(trip.status)}`}>
              {statusLabel(trip.status)}
            </span>
            {trip.passenger_name}
          </div>
          <button
            onClick={deleteTrip}
            className="rounded-lg p-1.5 text-red-400 hover:bg-red-950/40"
            title="Delete trip"
          >
            <Trash2 size={16} />
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-3 px-3 pt-3">
        {/* Map */}
        <div className="relative h-[42vh] min-h-[280px] overflow-hidden rounded-2xl border border-zinc-800">
          <ClientMap position={pos} pins={pins} polyline={polyline} className="h-full w-full" />
          {eta && (
            <div className="absolute left-3 bottom-3"><EtaBadge eta={eta} variant="dual" /></div>
          )}
          {navUrl && (
            <a href={navUrl} target="_blank" rel="noreferrer" className="absolute right-3 bottom-3 inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white shadow hover:bg-emerald-500">
              <Navigation size={12} /> Maps
            </a>
          )}
        </div>

        {/* Trip basics — view or edit */}
        {!editing ? (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-xs uppercase tracking-wider text-zinc-500">Scheduled</div>
                <div className="text-base font-semibold text-zinc-100">
                  {shortDate(trip.scheduled_at)} · {shortTime(trip.scheduled_at)}
                </div>
              </div>
              <button
                onClick={() => setEditing(true)}
                className="flex items-center gap-1 rounded-lg bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-200 hover:bg-zinc-700"
              >
                <Pencil size={12} /> Edit basics
              </button>
            </div>
            {trip.driver_pay_cents != null && (
              <div className="mt-2 text-xs text-emerald-300">Driver pay: {dollars(trip.driver_pay_cents)}</div>
            )}
          </div>
        ) : (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4 space-y-3">
            <Field label="Passenger">
              <input value={passenger} onChange={(e) => setPassenger(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Pickup address">
              <input value={pickup} onChange={(e) => setPickup(e.target.value)} placeholder="home · Wynn lobby · address" className={inputCls} />
            </Field>
            <Field label="Dropoff address">
              <input value={dropoff} onChange={(e) => setDropoff(e.target.value)} placeholder="LAX · Cosmopolitan · etc" className={inputCls} />
            </Field>
            <Field label="Scheduled (your local time)">
              <input type="datetime-local" value={scheduled} onChange={(e) => setScheduled(e.target.value)} className={inputCls} />
            </Field>
            <div className="flex gap-2">
              <button onClick={save} disabled={busy} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save
              </button>
              <button onClick={() => setEditing(false)} className="rounded-xl border border-zinc-800 px-3 py-2.5 text-sm text-zinc-300 hover:bg-zinc-900">
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Waypoint sequence — tap any + to insert a stop at that position */}
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4">
          <div className="mb-3 text-xs uppercase tracking-wider text-zinc-500">Route</div>
          <ul className="flex flex-col gap-3">
            {trip.pickup_address && (
              <Waypoint kind="pickup" label={trip.pickup_address} subline="Pickup" />
            )}
            <InsertStop token={token} index={0} onAdd={addStopAt} />
            {stops.map((s, i) => (
              <React.Fragment key={s.id}>
                <Waypoint
                  kind="stop"
                  label={s.address}
                  subline={`Stop ${i + 1}${s.category ? ` · ${s.category}` : ""}`}
                  onRemove={() => removeStop(s.id)}
                />
                <InsertStop token={token} index={i + 1} onAdd={addStopAt} />
              </React.Fragment>
            ))}
            {trip.dropoff_address && (
              <Waypoint kind="dropoff" label={trip.dropoff_address} subline="Final destination" />
            )}
          </ul>
        </div>

        {/* Update driver — only when there are pending route changes */}
        {isDirty && (
          <div className="sticky bottom-3 z-30 rounded-2xl border border-amber-700/60 bg-amber-950/40 p-3 backdrop-blur shadow-2xl">
            <div className="mb-2 text-[11px] uppercase tracking-wider text-amber-300">
              Pending changes — driver hasn&apos;t seen these yet
            </div>
            <div className="flex gap-2">
              <button
                onClick={pushUpdateToDriver}
                disabled={busy}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 py-3 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Update driver
              </button>
              <button
                onClick={discardChanges}
                disabled={busy}
                className="rounded-xl border border-zinc-800 px-3 py-3 text-sm text-zinc-300 hover:bg-zinc-900 disabled:opacity-50"
              >
                Discard
              </button>
            </div>
          </div>
        )}

        {/* Guest invite */}
        {trip.passenger_link_token && (
          <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4">
            <div className="mb-2 text-xs uppercase tracking-wider text-zinc-500">Share with passengers</div>
            <a
              href={`sms:&body=${encodeURIComponent(`Click for details on your trip:\n${typeof window !== "undefined" ? window.location.origin : ""}/p/${trip.passenger_link_token}`)}`}
              className="flex items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500"
            >
              Invite via iMessage
            </a>
          </div>
        )}
      </main>
    </div>
  );
}

const inputCls = "w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-emerald-700";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] uppercase tracking-wider text-zinc-500">{label}</div>
      {children}
    </label>
  );
}

function InsertStop({
  token,
  index,
  onAdd,
}: {
  token: string;
  index: number;
  onAdd: (index: number, r: { lat: number; lng: number; display: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <li className="flex items-center gap-2 pl-9">
        <button
          onClick={() => setOpen(true)}
          className="flex items-center gap-1.5 rounded-full border border-dashed border-zinc-700 bg-zinc-900/50 px-3 py-1 text-[11px] text-zinc-400 hover:border-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
        >
          <span className="text-sm leading-none">+</span> add stop here
        </button>
      </li>
    );
  }
  return (
    <li className="flex items-start gap-2 pl-9">
      <div className="flex-1 rounded-xl border border-zinc-800 bg-zinc-900/60 p-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">
            Insert stop at position {index + 1}
          </span>
          <button
            onClick={() => setOpen(false)}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800"
          >
            <X size={12} />
          </button>
        </div>
        <AddressAutocomplete
          token={token}
          placeholder="Type any address — autocompletes"
          onSelect={(r) => {
            onAdd(index, r);
            setOpen(false);
          }}
        />
      </div>
    </li>
  );
}

function Waypoint({ kind, label, subline, onRemove }: { kind: "pickup" | "stop" | "dropoff"; label: string; subline: string; onRemove?: () => void }) {
  const glyph = kind === "dropoff" ? "🏁" : "🚩";
  const color = kind === "dropoff" ? "text-blue-300" : "text-amber-300";
  return (
    <li className="flex items-center justify-between gap-2 rounded-xl bg-zinc-900/60 px-3 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex w-7 shrink-0 items-center justify-center text-base leading-none">{glyph}</span>
        <div className="min-w-0">
          <div className={`text-[10px] uppercase tracking-wider ${color}`}>{subline}</div>
          <div className="truncate text-sm text-zinc-100">{label}</div>
        </div>
      </div>
      {onRemove && (
        <button onClick={onRemove} className="shrink-0 rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-red-400">
          <X size={14} />
        </button>
      )}
    </li>
  );
}

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(local: string): string {
  return new Date(local).toISOString();
}
