"use client";

import dynamic from "next/dynamic";
import { ComponentProps } from "react";
import MapErrorBoundary from "./MapErrorBoundary";

const MapboxMap = dynamic(() => import("./MapboxMap"), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full bg-zinc-900 animate-pulse rounded-2xl flex items-center justify-center text-zinc-500">
      Loading map…
    </div>
  ),
});

export default function ClientMap(props: ComponentProps<typeof MapboxMap>) {
  return (
    <MapErrorBoundary>
      <MapboxMap {...props} />
    </MapErrorBoundary>
  );
}
