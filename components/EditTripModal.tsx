"use client";

import { useState } from "react";
import { Trip } from "@/lib/types";
import { api } from "@/lib/api-client";
import { X, Loader2, Save, Trash2 } from "lucide-react";

interface Props {
  token: string;
  trip: Trip;
  onClose: () => void;
  onSaved: () => void;
}

export default function EditTripModal({ token, trip, onClose, onSaved }: Props) {
  const [passenger, setPassenger] = useState(trip.passenger_name);
  const [pickup, setPickup] = useState(trip.pickup_address ?? "");
  const [dropoff, setDropoff] = useState(trip.dropoff_address ?? "");
  // Convert UTC scheduled_at to local datetime-input format YYYY-MM-DDTHH:mm
  const [scheduled, setScheduled] = useState(() => toLocalInput(trip.scheduled_at));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(token, `/api/trips/${trip.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          passenger_name: passenger,
          pickup_address: pickup || null,
          dropoff_address: dropoff || null,
          scheduled_at: fromLocalInput(scheduled),
        }),
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
          <Field label="Pickup address">
            <input
              value={pickup}
              onChange={(e) => setPickup(e.target.value)}
              placeholder="e.g. home, Wynn lobby, 123 Main St"
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-emerald-700"
            />
          </Field>
          <Field label="Dropoff address">
            <input
              value={dropoff}
              onChange={(e) => setDropoff(e.target.value)}
              placeholder="e.g. LAX, Cosmopolitan, John Wayne"
              className="w-full rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-emerald-700"
            />
          </Field>
          <Field label="Scheduled (local time)">
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
            disabled={busy}
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

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(local: string): string {
  // local is "YYYY-MM-DDTHH:mm" interpreted as the user's local timezone
  return new Date(local).toISOString();
}
