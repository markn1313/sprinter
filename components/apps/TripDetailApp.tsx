"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Trip } from "@/lib/types";
import { api } from "@/lib/api-client";
import { useEta } from "@/components/useEta";
import { usePosition } from "@/components/usePosition";
import ClientMap from "@/components/ClientMap";
import { MapPin } from "@/components/LiveMap";
import EtaBadge from "@/components/EtaBadge";
import AddressAutocomplete from "@/components/AddressAutocomplete";
import { dollars, shortTime, shortDate } from "@/lib/format";
import { toPTInput, fromPTInput } from "@/lib/pt-time";
import { googleMapsMultiStop } from "@/lib/maps-link";
import { Navigation, X, Save, Loader2, MessageSquare } from "lucide-react";

interface ServerStop {
  id: string;
  kind: "pickup" | "dropoff" | "stop";
  category?: string;
  address: string;
  lat: number | null;
  lng: number | null;
  arrived_at?: string | null;
}

interface TripWithStops extends Trip {
  stops?: ServerStop[];
  route_polyline?: string | null;
}

// Unified waypoint — first = pickup, last = dropoff, middle = intermediate stops.
// `serverId` is "pickup" / "dropoff" for the boundary slots, the row's UUID for
// existing intermediate stops, or "new" for freshly-inserted local entries.
interface Waypoint {
  id: string;
  serverId: string;
  address: string;
  lat: number | null;
  lng: number | null;
  arrived_at?: string | null;
}

interface TripDetailProps {
  token: string;
  tripId: string;
  onBack?: () => void;
  hideMap?: boolean;
}

export default function TripDetailApp({ token, tripId, hideMap }: TripDetailProps) {
  const [trip, setTrip] = useState<TripWithStops | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState("");
  const [passenger, setPassenger] = useState("");
  const [busy, setBusy] = useState(false);
  const { pos } = usePosition(token, 8000);
  const { eta: serverEta } = useEta(token, tripId, 25_000);
  const [previewEta, setPreviewEta] = useState<typeof serverEta>(null);

  const refresh = async () => {
    try {
      const data = await api<{ trips: TripWithStops[] }>(token, "/api/trips");
      const t = data.trips.find((x) => x.id === tripId) ?? null;
      setTrip(t);
      if (t) {
        setPassenger(t.passenger_name);
        setScheduled(toPTInput(t.scheduled_at));
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

  // Server-side view of the route (pickup → stops → dropoff) as a unified list
  const serverOrdered = useMemo<Waypoint[]>(() => {
    if (!trip) return [];
    const list: Waypoint[] = [];
    if (trip.pickup_address || trip.pickup_lat != null) {
      list.push({
        id: "pickup",
        serverId: "pickup",
        address: trip.pickup_address ?? "",
        lat: trip.pickup_lat,
        lng: trip.pickup_lng,
      });
    }
    (trip.stops ?? []).forEach((s) => {
      list.push({
        id: s.id,
        serverId: s.id,
        address: s.address,
        lat: s.lat,
        lng: s.lng,
        arrived_at: s.arrived_at,
      });
    });
    if (trip.dropoff_address || trip.dropoff_lat != null) {
      list.push({
        id: "dropoff",
        serverId: "dropoff",
        address: trip.dropoff_address ?? "",
        lat: trip.dropoff_lat,
        lng: trip.dropoff_lng,
      });
    }
    return list;
  }, [trip]);

  // Local-staged ordered list — null until the user makes a change
  const [localOrdered, setLocalOrdered] = useState<Waypoint[] | null>(null);
  const ordered = localOrdered ?? serverOrdered;

  const isDirty =
    localOrdered !== null && !sameOrdered(localOrdered, serverOrdered);

  // Live preview ETA against the staged route
  useEffect(() => {
    if (!isDirty || !trip || ordered.length < 2) {
      setPreviewEta(null);
      return;
    }
    const upcoming = ordered
      .filter((w) => w.lat != null && w.lng != null)
      .map((w, i, arr) => ({
        lat: w.lat as number,
        lng: w.lng as number,
        kind: i === 0 ? "pickup" : i === arr.length - 1 ? "dropoff" : "stop",
        label: w.address,
      }));
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/eta`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ waypoints: upcoming }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setPreviewEta(data);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isDirty, ordered, trip, token]);

  const eta = isDirty ? previewEta : serverEta;

  // Map pins — keep visual distinction on the map (start flag, finish flag,
  // numbered stops in between) since that's helpful for orientation. Only the
  // text list below is unified.
  const pins = useMemo<MapPin[]>(() => {
    const out: MapPin[] = [];
    ordered.forEach((w, i) => {
      if (w.lat == null || w.lng == null) return;
      const kind = i === 0 ? "pickup" : i === ordered.length - 1 ? "dropoff" : "stop";
      out.push({
        kind,
        lat: w.lat,
        lng: w.lng,
        label: w.address || undefined,
        ...(kind === "stop" ? { index: i } : {}),
      });
    });
    return out;
  }, [ordered]);

  const polyline = trip?.route_polyline ?? eta?.polyline ?? null;

  const navUrl = useMemo(() => {
    const wp: Array<{ lat: number; lng: number; label?: string }> = [];
    ordered.forEach((w) => {
      if (w.lat != null && w.lng != null) wp.push({ lat: w.lat, lng: w.lng, label: w.address });
    });
    if (wp.length < 1) return null;
    return googleMapsMultiStop(wp);
  }, [ordered]);

  const savePassengerOrSchedule = async () => {
    setBusy(true);
    try {
      await fetch(`/api/trips/${tripId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          passenger_name: passenger,
          scheduled_at: fromPTInput(scheduled),
        }),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (): Waypoint[] => localOrdered ?? serverOrdered;

  const removeAt = (index: number) => {
    setLocalOrdered((prev) => {
      const cur = prev ?? serverOrdered;
      return cur.filter((_, i) => i !== index);
    });
  };

  const replaceAt = (index: number, r: { lat: number; lng: number; display: string }) => {
    setLocalOrdered((prev) => {
      const cur = prev ?? serverOrdered;
      const next = [...cur];
      const existing = next[index];
      next[index] = {
        id: existing?.id ?? crypto.randomUUID(),
        serverId: existing?.serverId ?? "new",
        address: r.display,
        lat: r.lat,
        lng: r.lng,
      };
      return next;
    });
  };

  const insertAt = (index: number, r: { lat: number; lng: number; display: string }) => {
    setLocalOrdered((prev) => {
      const cur = prev ?? serverOrdered;
      const newWp: Waypoint = {
        id: crypto.randomUUID(),
        serverId: "new",
        address: r.display,
        lat: r.lat,
        lng: r.lng,
      };
      const next = [...cur];
      next.splice(Math.max(0, Math.min(next.length, index)), 0, newWp);
      return next;
    });
    // touch to suppress the unused-variable warning if startEdit ever isn't called
    void startEdit;
  };

  const pushUpdateToDriver = async () => {
    if (!localOrdered || localOrdered.length < 2) return;
    setBusy(true);
    try {
      const list = localOrdered;
      const first = list[0];
      const last = list[list.length - 1];
      const middle = list.slice(1, -1);

      const oldFirst = serverOrdered[0];
      const oldLast = serverOrdered[serverOrdered.length - 1];
      const pickupChanged =
        !oldFirst ||
        oldFirst.address !== first.address ||
        oldFirst.lat !== first.lat ||
        oldFirst.lng !== first.lng;
      const dropoffChanged =
        !oldLast ||
        oldLast.address !== last.address ||
        oldLast.lat !== last.lat ||
        oldLast.lng !== last.lng;

      if (pickupChanged || dropoffChanged) {
        const body: Record<string, unknown> = {};
        if (pickupChanged) {
          body.pickup_address = first.address;
          body.pickup_lat = first.lat;
          body.pickup_lng = first.lng;
        }
        if (dropoffChanged) {
          body.dropoff_address = last.address;
          body.dropoff_lat = last.lat;
          body.dropoff_lng = last.lng;
        }
        await fetch(`/api/trips/${tripId}`, {
          method: "PATCH",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }

      const serverMiddle = serverOrdered.slice(1, -1);
      const middleChanged = !sameOrdered(middle, serverMiddle);
      if (middleChanged) {
        await fetch(`/api/trips/${tripId}/stops`, {
          method: "PUT",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            stops: middle.map((w) => ({
              id:
                w.serverId !== "new" && w.serverId !== "pickup" && w.serverId !== "dropoff"
                  ? w.serverId
                  : undefined,
              address: w.address,
              lat: w.lat,
              lng: w.lng,
              kind: "stop",
            })),
          }),
        });
      }
      setLocalOrdered(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const discardChanges = () => {
    setLocalOrdered(null);
  };

  // Driver token (singleton) for invite link — hooks must be declared before
  // any early return below, or React's hook ordering breaks (#310).
  const [driverToken, setDriverToken] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api<{ links: Array<{ role: string; token: string }> }>(
          token,
          "/api/links",
        );
        if (cancelled) return;
        const dio = data.links.find((l) => l.role === "dio");
        if (dio) setDriverToken(dio.token);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (error) return <div className="p-6 text-sm text-red-400">{error}</div>;
  if (!trip) return <div className="p-6 text-sm text-zinc-500">Loading…</div>;

  const passengerUrl =
    typeof window !== "undefined" && trip?.passenger_link_token
      ? `${window.location.origin}/p/${trip.passenger_link_token}`
      : null;
  const passengerInviteHref = passengerUrl
    ? `sms:&body=${encodeURIComponent(`Click for details on your trip:\n${passengerUrl}`)}`
    : null;

  const driverUrl =
    typeof window !== "undefined" && driverToken
      ? `${window.location.origin}/d/${driverToken}`
      : null;
  const driverInviteHref = driverUrl
    ? `sms:&body=${encodeURIComponent(`Open for today's trip:\n${driverUrl}`)}`
    : null;

  return (
    <div className={hideMap ? "flex h-full flex-col bg-zinc-950" : "min-h-screen bg-zinc-950 pb-24"}>
      {(passengerInviteHref || driverInviteHref) && (
        <div className="flex items-center justify-end gap-2 px-3 pt-3">
          {driverInviteHref && (
            <a
              href={driverInviteHref}
              className="flex items-center gap-1.5 rounded-xl bg-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-100 hover:bg-zinc-700"
            >
              <MessageSquare size={12} /> Invite Driver
            </a>
          )}
          {passengerInviteHref && (
            <a
              href={passengerInviteHref}
              className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
            >
              <MessageSquare size={12} /> Invite Guests
            </a>
          )}
        </div>
      )}
      <main className={`mx-auto w-full max-w-3xl space-y-3 px-3 pt-3 ${hideMap ? "flex-1 overflow-y-auto pb-6" : ""}`}>
        {!hideMap && (
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
        )}
        {hideMap && eta && (
          <div className="flex items-center justify-between gap-2">
            <EtaBadge eta={eta} variant="dual" />
            {navUrl && (
              <a href={navUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-2 text-xs font-semibold text-white shadow hover:bg-emerald-500">
                <Navigation size={12} /> Maps
              </a>
            )}
          </div>
        )}

        <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-3">
          <ul className="flex flex-col gap-1.5">
            <EditableField
              label="Passenger"
              value={passenger}
              onChange={setPassenger}
              onCommit={savePassengerOrSchedule}
            />

            <EditableField
              label="Scheduled (PT)"
              value={scheduled}
              displayValue={`${shortDate(trip.scheduled_at)} · ${shortTime(trip.scheduled_at)} PT`}
              type="datetime-local"
              onChange={setScheduled}
              onCommit={savePassengerOrSchedule}
            />

            {/* Insert before everything */}
            <InsertStop token={token} index={0} onAdd={insertAt} />

            {/* Unified stop list — pickup/intermediate/dropoff all rendered the same */}
            {ordered.map((w, i) => (
              <React.Fragment key={`${w.id}-${i}`}>
                <UnifiedStop
                  index={i + 1}
                  address={w.address || "(not set)"}
                  token={token}
                  onChange={(r) => replaceAt(i, r)}
                  onRemove={() => removeAt(i)}
                />
                <InsertStop token={token} index={i + 1} onAdd={insertAt} />
              </React.Fragment>
            ))}

            {trip.driver_pay_cents != null && (
              <div className="mt-1 text-xs text-emerald-300">Driver pay: {dollars(trip.driver_pay_cents)}</div>
            )}
          </ul>
        </div>

        {isDirty && (
          <div className="sticky bottom-3 z-30 rounded-2xl border border-amber-700/60 bg-amber-950/40 p-3 backdrop-blur shadow-2xl">
            <div className="mb-2 text-[11px] uppercase tracking-wider text-amber-300">
              Pending changes — driver hasn&apos;t seen these yet
            </div>
            <div className="flex gap-2">
              <button
                onClick={pushUpdateToDriver}
                disabled={busy || ordered.length < 2}
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
      </main>
    </div>
  );
}

function sameOrdered(a: Waypoint[], b: Waypoint[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (x, i) =>
      x.serverId === b[i].serverId &&
      x.address === b[i].address &&
      x.lat === b[i].lat &&
      x.lng === b[i].lng,
  );
}

function EditableField({
  label,
  value,
  displayValue,
  type,
  onChange,
  onCommit,
}: {
  label: string;
  value: string;
  displayValue?: string;
  type?: string;
  onChange: (v: string) => void;
  onCommit: () => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <li
        onClick={() => setEditing(true)}
        className="cursor-pointer rounded-xl bg-zinc-900/60 px-3 py-3 hover:bg-zinc-900"
      >
        <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
        <div className="mt-0.5 truncate text-sm text-zinc-100">{displayValue ?? value}</div>
      </li>
    );
  }
  return (
    <li className="rounded-xl border border-emerald-700/60 bg-zinc-900/60 px-3 py-3">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-emerald-400">{label}</div>
      <input
        autoFocus
        type={type ?? "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={async () => {
          await onCommit();
          setEditing(false);
        }}
        onKeyDown={async (e) => {
          if (e.key === "Enter") {
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setEditing(false);
          }
        }}
        className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-700"
      />
    </li>
  );
}

function UnifiedStop({
  index,
  address,
  token,
  onChange,
  onRemove,
}: {
  index: number;
  address: string;
  token: string;
  onChange: (r: { lat: number; lng: number; display: string }) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <li className="flex items-center gap-2 rounded-xl bg-zinc-900/60 px-2.5 py-1.5">
        <span className="shrink-0 w-5 text-center text-xs font-semibold text-amber-300 tabular-nums">{index}</span>
        <button onClick={() => setEditing(true)} className="min-w-0 flex-1 text-left">
          <div className="truncate text-sm text-zinc-100">{address}</div>
        </button>
        <button
          onClick={onRemove}
          className="shrink-0 rounded-lg p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
        >
          <X size={14} />
        </button>
      </li>
    );
  }
  return (
    <li className="rounded-xl border border-emerald-700/60 bg-zinc-900/60 px-2.5 py-2">
      <div className="mb-2 flex items-center gap-2">
        <span className="shrink-0 w-5 text-center text-xs font-semibold text-amber-300 tabular-nums">{index}</span>
        <span className="flex-1 text-[10px] uppercase tracking-wider text-emerald-400">Editing</span>
        <button onClick={() => setEditing(false)} className="rounded p-1 text-zinc-400 hover:bg-zinc-800">
          <X size={12} />
        </button>
      </div>
      <AddressAutocomplete
        token={token}
        placeholder="Type any address — autocompletes"
        onSelect={(r) => {
          onChange(r);
          setEditing(false);
        }}
      />
    </li>
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
      <li>
        <button
          onClick={() => setOpen(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-zinc-800 bg-zinc-900/30 px-2 py-1 text-[10px] text-zinc-500 hover:border-zinc-600 hover:bg-zinc-800/60 hover:text-zinc-200"
        >
          <span className="text-sm leading-none">+</span> add stop
        </button>
      </li>
    );
  }
  return (
    <li className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
          Insert stop at position {index + 1}
        </span>
        <button onClick={() => setOpen(false)} className="rounded p-1 text-zinc-400 hover:bg-zinc-800">
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
    </li>
  );
}

