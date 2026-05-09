"use client";

import { useMemo } from "react";
import { Trip } from "@/lib/types";
import { usePosition } from "@/components/usePosition";
import { useTrips } from "@/components/useTrips";
import { useEta } from "@/components/useEta";
import ClientMap from "@/components/ClientMap";
import { MapPin } from "@/components/LiveMap";
import EtaBadge from "@/components/EtaBadge";
import CabinControls from "@/components/CabinControls";
import { statusLabel, shortTime } from "@/lib/format";
import { MapPin as PinIcon } from "lucide-react";
import CabinChat from "@/components/CabinChat";

export default function PassengerApp({ token, name }: { token: string; name: string }) {
  const { pos } = usePosition(token, 8000);
  const { trips } = useTrips(token, 5000);
  const trip = trips[0] ?? null;
  const { eta } = useEta(token, trip?.id ?? null, 20_000);

  const pins = useMemo<MapPin[]>(() => {
    const out: MapPin[] = [];
    if (trip?.pickup_lat != null && trip.pickup_lng != null) {
      out.push({ kind: "pickup", lat: trip.pickup_lat, lng: trip.pickup_lng, label: trip.pickup_address ?? "Pickup" });
    }
    if (trip?.dropoff_lat != null && trip.dropoff_lng != null) {
      out.push({ kind: "dropoff", lat: trip.dropoff_lat, lng: trip.dropoff_lng, label: trip.dropoff_address ?? "Dropoff" });
    }
    return out;
  }, [trip]);

  const polyline = (trip as unknown as { route_polyline?: string })?.route_polyline ?? eta?.polyline ?? null;
  const isLive = trip && trip.status !== "scheduled" && trip.status !== "complete" && trip.status !== "cancelled";

  return (
    <div className="min-h-screen bg-zinc-950 pb-12">
      <header className="sticky top-0 z-20 border-b border-zinc-900 bg-zinc-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-2xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-xl">🚐</span>
            <span className="text-sm font-medium text-zinc-100">Sprinter</span>
          </div>
        </div>
      </header>

      <section className="relative mx-auto max-w-2xl space-y-3 px-4 pt-4">
        <div className="h-[44vh] min-h-[280px] overflow-hidden rounded-2xl border border-zinc-800">
          <ClientMap position={pos} pins={pins} polyline={polyline} />
        </div>
        {isLive && eta && (
          <div className="absolute left-6 top-8">
            <EtaBadge eta={eta} variant="hero" label={trip?.status === "onboard" ? "to your stop" : "until pickup"} />
          </div>
        )}

        {trip ? <PassengerTripCard trip={trip} etaMinutes={eta?.eta_minutes ?? null} /> : <NoTripCard />}

        {isLive && trip && <CabinControls token={token} tripId={trip.id} />}

        <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/60 h-[420px]">
          <div className="border-b border-zinc-900 px-4 py-2 text-xs uppercase tracking-wider text-zinc-500">
            Ask about the van
          </div>
          <div className="h-[calc(100%-36px)]">
            <CabinChat token={token} />
          </div>
        </div>
      </section>
    </div>
  );
}

function PassengerTripCard({ trip, etaMinutes }: { trip: Trip; etaMinutes: number | null }) {
  const headline = (() => {
    switch (trip.status) {
      case "scheduled":
        return `Pickup at ${shortTime(trip.scheduled_at)}`;
      case "dispatched":
        return etaMinutes != null ? `Dio is ${etaMinutes} min away` : "Van is on the way";
      case "at_pickup":
        return "Van has arrived";
      case "onboard":
        return etaMinutes != null && trip.dropoff_address ? `${etaMinutes} min to ${trip.dropoff_address.split(",")[0]}` : "Onboard";
      case "at_dropoff":
        return "Arrived";
      case "complete":
        return "Trip complete";
      case "cancelled":
        return "Trip cancelled";
    }
  })();

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/80 p-4">
      <div className="text-xs uppercase tracking-wider text-emerald-400">{statusLabel(trip.status)}</div>
      <div className="mt-1 text-lg font-semibold text-zinc-100">{headline}</div>
      <div className="mt-3 space-y-1 text-sm">
        {trip.pickup_address && (
          <div className="flex items-center gap-2 text-zinc-300"><PinIcon size={14} className="text-amber-400" /> {trip.pickup_address}</div>
        )}
        {trip.dropoff_address && (
          <div className="flex items-center gap-2 text-zinc-300"><PinIcon size={14} className="text-blue-400" /> {trip.dropoff_address}</div>
        )}
      </div>
    </div>
  );
}

function NoTripCard() {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-6 text-center text-sm text-zinc-400">
      Your ride hasn&apos;t been dispatched yet — you&apos;ll see it here when Mark sends the van.
    </div>
  );
}

