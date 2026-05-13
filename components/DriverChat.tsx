"use client";

import { useEffect, useRef, useState } from "react";
import { api, postJson } from "@/lib/api-client";
import { ArrowUp, Loader2 } from "lucide-react";
import { useRealtime } from "@/components/useRealtime";

type ChatRole = "mark" | "dio" | "passenger";

interface Msg {
  id: string;
  sender_role: ChatRole;
  body: string;
  sent_at: string;
  read_at: string | null;
}

interface Props {
  token: string;
  // The role of the *current viewer*. Determines which side bubbles render on.
  // Passengers can join the same thread as Mark <-> Dio; their messages
  // sender_role='passenger' and show "mine" on their side, "theirs" on
  // Mark and Dio.
  viewerRole: ChatRole;
}

const POLL_MS = 30000;

export default function DriverChat({ token, viewerRole }: Props) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const refresh = async () => {
    try {
      const data = await api<{ messages: Msg[] }>(token, "/api/messages");
      setMessages(data.messages || []);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [token]);

  // Live updates: any new message hits the table, refetch.
  useRealtime({ table: "messages", onChange: refresh });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = async () => {
    if (!input.trim() || busy) return;
    setBusy(true);
    const text = input;
    setInput("");
    try {
      await postJson(token, "/api/messages", { body: text });
      await refresh();
    } catch {
      setInput(text);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {messages.length === 0 ? (
          <div className="mt-12 text-center text-sm text-zinc-500">
            {viewerRole === "dio" ? "No messages yet." : "Send the driver a message."}
          </div>
        ) : (
          messages.map((m) => {
            const mine = m.sender_role === viewerRole;
            return (
              <div
                key={m.id}
                className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                  mine ? "ml-auto bg-emerald-700 text-white" : "mr-auto bg-zinc-800 text-zinc-100"
                }`}
              >
                <div>{m.body}</div>
                <div className={`mt-1 text-[10px] ${mine ? "text-emerald-200/80" : "text-zinc-500"}`}>
                  {new Date(m.sent_at).toLocaleTimeString("en-US", {
                    timeZone: "America/Los_Angeles",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="border-t border-zinc-900 bg-zinc-950 p-3"
      >
        <div className="relative">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={viewerRole === "dio" ? "Message Mark…" : "Message the driver…"}
            rows={1}
            className="w-full resize-none rounded-2xl border border-zinc-800 bg-zinc-900 px-3 py-2 pr-12 text-base text-zinc-100 placeholder-zinc-500 outline-none focus:border-emerald-700"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="absolute bottom-2 right-2 flex h-9 w-9 items-center justify-center rounded-full bg-emerald-600 text-white shadow-lg disabled:bg-zinc-700 disabled:opacity-50 enabled:hover:bg-emerald-500"
            aria-label="Send"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={16} strokeWidth={3} />}
          </button>
        </div>
      </form>
    </div>
  );
}

// Hook for any viewer's app to count unread messages from the other parties
// in the thread (i.e. messages whose sender_role is not the viewer's role).
export function useUnreadDriverChat(token: string, viewerRole: ChatRole) {
  const [unread, setUnread] = useState(0);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const data = await api<{ messages: Msg[] }>(token, "/api/messages");
        if (cancelled) return;
        const n = (data.messages || []).filter(
          (m) => m.sender_role !== viewerRole && !m.read_at,
        ).length;
        setUnread(n);
      } catch {
        // ignore
      }
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [token, viewerRole, version]);
  useRealtime({ table: "messages", onChange: () => setVersion((v) => v + 1) });
  return unread;
}
