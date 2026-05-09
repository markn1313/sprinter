"use client";

import { Trip, Role } from "@/lib/types";
import { dollars, statusLabel, statusColor, shortDate, shortTime } from "@/lib/format";
import { Copy, MessageSquare, ExternalLink } from "lucide-react";
import { useState, MouseEvent } from "react";
import { useRouter } from "next/navigation";

function buildInviteBody(_trip: Trip, url: string): string {
  return `Click for details on your trip:\n${url}`;
}

interface Props {
  trips: Trip[];
  role: Role;
  origin?: string;
  token?: string;
  onChanged?: () => void;
}

export default function TripList({ trips, role, origin, token }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const router = useRouter();

  if (!trips.length) {
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-6 text-center text-sm text-zinc-500">
        No trips yet.
      </div>
    );
  }

  const showMoney = role === "mark";

  const copy = async (id: string, url: string) => {
    await navigator.clipboard.writeText(url);
    setCopied(id);
    setTimeout(() => setCopied(null), 1500);
  };

  // Stop tap-on-row from firing when an inline action is tapped
  const stop = (e: MouseEvent) => e.stopPropagation();

  return (
    <ul className="divide-y divide-zinc-900 rounded-2xl border border-zinc-800 bg-zinc-950/60">
      {trips.map((t) => {
        const tappable = role === "mark" && !!token;
        const openTrip = () => {
          if (tappable) router.push(`/m/${token}/trip/${t.id}`);
        };
        return (
          <li
            key={t.id}
            onClick={openTrip}
            role={tappable ? "button" : undefined}
            className={`px-4 py-3 text-sm transition ${tappable ? "cursor-pointer hover:bg-zinc-900/40 active:bg-zinc-900/60" : ""}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white ${statusColor(t.status)}`}>
                    {statusLabel(t.status)}
                  </span>
                  <span className="font-medium text-zinc-100">{t.passenger_name}</span>
                </div>
                <div className="mt-1 truncate text-xs text-zinc-400">
                  {t.pickup_address && <>From {t.pickup_address} · </>}
                  {t.dropoff_address && <>To {t.dropoff_address}</>}
                  {!t.pickup_address && !t.dropoff_address && <em>No address parsed</em>}
                </div>
                <div className="mt-1 text-xs text-zinc-500">
                  {shortDate(t.scheduled_at)} · {shortTime(t.scheduled_at)}
                  {t.actual_minutes != null && ` · ${t.actual_minutes} min`}
                </div>
              </div>
              {showMoney && t.driver_pay_cents != null && (
                <div className="whitespace-nowrap text-sm font-mono tabular-nums text-emerald-300">
                  {dollars(t.driver_pay_cents)}
                </div>
              )}
            </div>
            {showMoney && t.passenger_link_token && origin && (
              <div className="mt-2 flex items-center gap-2" onClick={stop}>
                <a
                  href={`sms:&body=${encodeURIComponent(buildInviteBody(t, `${origin}/p/${t.passenger_link_token}`))}`}
                  className="flex items-center gap-1.5 rounded-lg bg-emerald-700 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-emerald-600"
                  title="Opens iMessage — pick one or more contacts and hit send"
                  onClick={stop}
                >
                  <MessageSquare size={11} /> Invite via iMessage
                </a>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    copy(t.id, `${origin}/p/${t.passenger_link_token}`);
                  }}
                  className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-1 text-[11px] hover:bg-zinc-700"
                >
                  <Copy size={11} />
                  {copied === t.id ? "Copied" : "Copy"}
                </button>
                <a
                  href={`/p/${t.passenger_link_token}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded bg-zinc-800 px-2 py-1 text-[11px] hover:bg-zinc-700"
                  onClick={stop}
                >
                  <ExternalLink size={11} />
                </a>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
