"use client";

import React, { useMemo, useState } from "react";
import { Trip } from "@/lib/types";
import { api } from "@/lib/api-client";
import { toPTInput, fromPTInput } from "@/lib/pt-time";
import AddressAutocomplete from "@/components/AddressAutocomplete";
import { X, Loader2, Save, Trash2, GripVertical } from "lucide-react";

// Server shape for a trip's destination chain. The API route in
// app/api/trips/[id]/stops/route.ts owns the canonical type but doesn't
// export it yet; once the chain rewrite lands a shared Stop type we
// should import it instead of defining this here. Mirrors that shape
// exactly (only the fields the modal reads/writes).
interface Stop {
  id: string;
  kind?: "pickup" | "dropoff" | "stop";
  address: string;
  lat: number | null;
  lng: number | null;
  passenger?: string | null;
  passenger_link_token?: string | null;
  created_by_token?: string | null;
  arrived_at?: string | null;
  added_at?: string;
}

// Trip rows in this app sometimes carry a `stops` JSONB column that
// isn't on the base Trip type yet. Narrow widening here keeps the
// modal type-strict without polluting lib/types.ts before the rewrite
// settles.
type TripWithStops = Trip & { stops?: Stop[] | null };

interface Props {
  token: string;
  trip: TripWithStops;
  onClose: () => void;
  onSaved: () => void;
}

// Build the initial chain. Prefer trip.stops[] (the new model) and
// only synthesise from pickup_*/dropoff_* as a defensive fallback for
// pre-backfill rows — the 2026-05-20 migration should make this branch
// unreachable in practice, but it's cheap insurance until the legacy
// columns are dropped.
function initialChain(trip: TripWithStops): Stop[] {
  const fromStops = (trip.stops ?? []).filter((s): s is Stop => !!s);
  if (fromStops.length > 0) return fromStops;
  const synth: Stop[] = [];
  if (trip.pickup_address || trip.pickup_lat != null) {
    synth.push({
      id: "legacy-pickup",
      kind: "pickup",
      address: trip.pickup_address ?? "",
      lat: trip.pickup_lat,
      lng: trip.pickup_lng,
      arrived_at: trip.arrived_at_pickup_at ?? trip.onboard_at ?? null,
    });
  }
  if (trip.dropoff_address || trip.dropoff_lat != null) {
    synth.push({
      id: "legacy-dropoff",
      kind: "dropoff",
      address: trip.dropoff_address ?? "",
      lat: trip.dropoff_lat,
      lng: trip.dropoff_lng,
      arrived_at: trip.arrived_at_dropoff_at ?? null,
    });
  }
  return synth;
}

export default function EditTripModal({ token, trip, onClose, onSaved }: Props) {
  const [passenger, setPassenger] = useState(trip.passenger_name);
  // Always project trip times into PT for editing — wherever Mark's device is.
  const [scheduled, setScheduled] = useState(() => toPTInput(trip.scheduled_at));
  // The whole route as one ordered chain. First = pickup, last = final
  // destination, middle = stops. Same mental model as a Google Maps
  // multi-stop directions list.
  const [chain, setChain] = useState<Stop[]>(() => initialChain(trip));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const removeAt = (i: number) =>
    setChain((prev) => prev.filter((_, idx) => idx !== i));

  const appendStop = (r: { lat: number; lng: number; display: string }) =>
    setChain((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        kind: "stop",
        address: r.display,
        lat: r.lat,
        lng: r.lng,
        added_at: new Date().toISOString(),
      },
    ]);

  // Drag-to-reorder. HTML5 DnD is enough here — same pattern as
  // TripDetailApp, no extra dep needed. Touch reorder happens via long-press
  // + drag in mobile Safari/Chrome; the grip handle telegraphs it visually.
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const onDrop = (i: number) => {
    if (dragIndex == null || dragIndex === i) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }
    setChain((prev) => {
      const next = [...prev];
      const [moved] = next.splice(dragIndex, 1);
      const targetIdx = dragIndex < i ? i - 1 : i;
      next.splice(targetIdx, 0, moved);
      return next;
    });
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const canSave = useMemo(() => chain.length >= 1, [chain]);

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    try {
      // 1) Replace the chain. optimize=false because Mark just explicitly
      // ordered these — the optimizer would clobber his intent. The PUT
      // also geocodes any rows missing lat/lng, so manual-entry edits work.
      if (chain.length > 0) {
        await api(token, `/api/trips/${trip.id}/stops`, {
          method: "PUT",
          body: JSON.stringify({
            stops: chain.map((s) => ({
              id: s.id?.startsWith("legacy-") ? undefined : s.id,
              kind: s.kind ?? "stop",
              address: s.address,
              lat: s.lat,
              lng: s.lng,
              passenger: s.passenger ?? null,
              passenger_link_token: s.passenger_link_token ?? null,
              created_by_token: s.created_by_token ?? null,
              arrived_at: s.arrived_at ?? null,
              added_at: s.added_at,
            })),
            optimize: false,
          }),
        });
      }

      // 2) Dual-write the chain ends to the legacy pickup_*/dropoff_*
      // columns. The state machine still reads those (and so do a couple
      // of pre-chain views), so until the cutover the only safe move is
      // to keep them in sync — mirrors MarkApp.commitDropoff. Also folds
      // in passenger_name + scheduled_at since this modal owns those too.
      const first = chain[0];
      const last = chain[chain.length - 1];
      const patch: Record<string, unknown> = {
        passenger_name: passenger,
        scheduled_at: fromPTInput(scheduled),
      };
      if (first) {
        patch.pickup_address = first.address || null;
        patch.pickup_lat = first.lat;
        patch.pickup_lng = first.lng;
      }
      if (last && chain.length >= 2) {
        patch.dropoff_address = last.address || null;
        patch.dropoff_lat = last.lat;
        patch.dropoff_lng = last.lng;
      } else if (chain.length < 2) {
        // Single-stop chain — clear the dropoff side so the state machine
        // doesn't keep firing on a stale destination.
        patch.dropoff_address = null;
        patch.dropoff_lat = null;
        patch.dropoff_lng = null;
      }
      await api(token, `/api/trips/${trip.id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });

      onSaved();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(token, `/api/trips/${trip.id}`, { method: "DELETE" });
      onSaved();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-[2px]" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md max-h-[90vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl border border-zinc-800 bg-zinc-950 p-4 shadow-2xl"
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="text-base font-semibold text-zinc-100">Edit trip</div>
          <button onClick={onClose} className="rounded-full p-1 text-zinc-400 hover:bg-zinc-800">
            <X size={16} />
          </button>
        </div>
        <div className="space-y-3">
          <Field label="Passenger">
            <input
              value={passenger}
              onChange={(e) => setPassenger(e.target.value)}
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-700"
            />
          </Field>

          {/* Single ordered destination chain. Row 1 = pickup, last row =
              final destination, anything between = stops. Same model the
              backend now uses; the user-visible cue is the "first" /
              "last" labels and the numeric index. */}
          <div>
            <div className="mb-1 text-[11px] uppercase tracking-wider text-zinc-500">
              Destinations
            </div>
            <ul className="space-y-1.5">
              {chain.map((s, i) => {
                const role =
                  i === 0 ? "Pickup" : i === chain.length - 1 ? "Dropoff" : "Stop";
                const arrived = !!s.arrived_at;
                return (
                  <li
                    key={s.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", String(i));
                      setDragIndex(i);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (dragIndex == null || dragIndex === i) return;
                      setDragOverIndex(i);
                    }}
                    onDragLeave={() => setDragOverIndex(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      onDrop(i);
                    }}
                    onDragEnd={() => {
                      setDragIndex(null);
                      setDragOverIndex(null);
                    }}
                    className={`flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-2.5 py-2 ${
                      dragIndex === i ? "opacity-40" : ""
                    } ${dragOverIndex === i ? "ring-2 ring-emerald-500/60" : ""}`}
                  >
                    <span
                      className="shrink-0 cursor-grab text-zinc-500 hover:text-zinc-300 active:cursor-grabbing"
                      aria-label="Drag to reorder"
                      title="Drag to reorder"
                    >
                      <GripVertical size={14} />
                    </span>
                    <span className="shrink-0 w-5 text-center text-xs font-semibold text-amber-300 tabular-nums">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                          {role}
                        </span>
                        {arrived && (
                          <span className="text-[10px] uppercase tracking-wider text-emerald-400">
                            • arrived
                          </span>
                        )}
                        {s.passenger && (
                          <span className="truncate text-[10px] text-zinc-400">
                            · {s.passenger}
                          </span>
                        )}
                      </div>
                      <div className="truncate text-sm text-zinc-100">
                        {s.address || "(no address)"}
                      </div>
                    </div>
                    <button
                      onClick={() => removeAt(i)}
                      className="shrink-0 rounded-lg p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                      title="Remove from chain"
                    >
                      <X size={14} />
                    </button>
                  </li>
                );
              })}
            </ul>

            {/* Append a destination. DestinationInput is the future home
                for this (it knows about pin-drop and "use my GPS"), but
                it doesn't exist on disk yet — use AddressAutocomplete
                inline for now. Swap to <DestinationInput …/> when it
                lands; the onSelect/onAdd contract is the same shape. */}
            <div className="mt-2">
              <AddressAutocomplete
                token={token}
                placeholder="Add a destination — autocompletes"
                onSelect={appendStop}
              />
            </div>
          </div>

          <Field label="Scheduled (PT)">
            <input
              type="datetime-local"
              value={scheduled}
              onChange={(e) => setScheduled(e.target.value)}
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-700"
            />
          </Field>
        </div>
        {err && <div className="mt-3 text-xs text-red-400">{err}</div>}
        <div className="mt-4 flex items-center gap-2">
          <button
            onClick={save}
            disabled={busy || !canSave}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-emerald-600 px-3 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save changes
          </button>
          {confirmDelete ? (
            <button
              onClick={del}
              disabled={busy}
              className="rounded-xl bg-red-700 px-3 py-2.5 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-50"
            >
              Confirm delete
            </button>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
              className="rounded-xl border border-red-900/60 px-3 py-2.5 text-sm font-medium text-red-400 hover:bg-red-950/50 disabled:opacity-50"
              title="Delete trip"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-[11px] uppercase tracking-wider text-zinc-500">{label}</div>
      {children}
    </label>
  );
}
