"use client";

import dynamic from "next/dynamic";
import { ComponentProps } from "react";

const LiveMap = dynamic(() => import("./LiveMap"), {
  ssr: false,
  loading: () => (
    <div className="h-full w-full bg-zinc-900 animate-pulse rounded-2xl flex items-center justify-center text-zinc-500">
      Loading map…
    </div>
  ),
});

export default function ClientMap(props: ComponentProps<typeof LiveMap>) {
  return <LiveMap {...props} />;
}
