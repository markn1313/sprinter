"use client";

import { useRef, useState, ReactNode, useEffect } from "react";
import { Trash2, Loader2 } from "lucide-react";

interface Props {
  onDelete: () => Promise<void> | void;
  confirmLabel?: string;
  threshold?: number;
  children: ReactNode;
}

const ACTION_WIDTH = 88;

// iMessage-style swipe-left to reveal a Delete action. Touch events only —
// pointer/mouse pass through to children (so desktop click still works for
// row tap-to-open).
export default function SwipeToDelete({
  onDelete,
  confirmLabel = "Delete",
  threshold = 60,
  children,
}: Props) {
  const [offset, setOffset] = useState(0); // current translateX (negative = revealing action)
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const startX = useRef<number | null>(null);
  const startOffset = useRef(0);
  const movedRef = useRef(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Tap outside to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setOffset(0);
        setConfirming(false);
      }
    };
    document.addEventListener("touchstart", handler, { passive: true });
    document.addEventListener("mousedown", handler);
    return () => {
      document.removeEventListener("touchstart", handler);
      document.removeEventListener("mousedown", handler);
    };
  }, [open]);

  const onTouchStart = (e: React.TouchEvent) => {
    startX.current = e.touches[0].clientX;
    startOffset.current = offset;
    movedRef.current = false;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (startX.current == null) return;
    const dx = e.touches[0].clientX - startX.current;
    if (Math.abs(dx) > 6) movedRef.current = true;
    const next = Math.min(0, Math.max(-ACTION_WIDTH, startOffset.current + dx));
    setOffset(next);
  };
  const onTouchEnd = () => {
    if (startX.current == null) return;
    startX.current = null;
    if (offset < -threshold) {
      setOffset(-ACTION_WIDTH);
      setOpen(true);
    } else {
      setOffset(0);
      setOpen(false);
      setConfirming(false);
    }
    // Suppress synthetic click after swipe
    if (movedRef.current) {
      setTimeout(() => (movedRef.current = false), 250);
    }
  };

  const stopIfSwiped = (e: React.MouseEvent | React.TouchEvent) => {
    if (movedRef.current || open) {
      e.stopPropagation();
      e.preventDefault();
    }
  };

  const handleDeleteTap = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    try {
      await onDelete();
    } finally {
      setBusy(false);
      setConfirming(false);
      setOpen(false);
      setOffset(0);
    }
  };

  return (
    <div ref={wrapperRef} className="relative overflow-hidden">
      {/* Action layer behind */}
      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center">
        <button
          onClick={(e) => {
            e.stopPropagation();
            handleDeleteTap();
          }}
          disabled={busy}
          style={{ width: ACTION_WIDTH }}
          className={`pointer-events-auto flex h-full items-center justify-center gap-1 text-xs font-semibold text-white transition ${
            confirming ? "bg-red-700" : "bg-red-600"
          } disabled:opacity-60`}
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
          <span>{confirming ? "Confirm" : confirmLabel}</span>
        </button>
      </div>
      {/* Foreground sliding content */}
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onClickCapture={stopIfSwiped}
        style={{
          transform: `translateX(${offset}px)`,
          transition: startX.current == null ? "transform 200ms ease" : "none",
        }}
        className="relative bg-zinc-950"
      >
        {children}
      </div>
    </div>
  );
}
