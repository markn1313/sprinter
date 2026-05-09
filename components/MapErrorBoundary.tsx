"use client";

import React from "react";

interface State {
  error: Error | null;
}

// Catches any throw inside the Mapbox tree so the rest of the page survives.
// Without this, iOS Safari aborts the whole page when Mapbox-gl throws during
// mount/unmount race conditions.
export default class MapErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.warn("[MapErrorBoundary]", error.message);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        this.props.fallback ?? (
          <div className="flex h-full w-full items-center justify-center bg-zinc-900 text-zinc-400">
            <button
              onClick={this.reset}
              className="rounded-xl bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700"
            >
              Map hiccup — tap to retry
            </button>
          </div>
        )
      );
    }
    return this.props.children;
  }
}
