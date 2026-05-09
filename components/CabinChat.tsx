"use client";

import { useEffect, useRef, useState } from "react";
import { postJson } from "@/lib/api-client";
import { Send, Loader2, MessageCircleQuestion } from "lucide-react";

interface Msg {
  role: "user" | "assistant";
  content: string;
}

const QUICK_QUESTIONS = [
  "How do I play TV audio?",
  "How do I connect CarPlay?",
  "What's the WiFi password?",
  "How do I turn up the volume?",
  "How do I change the LED color?",
];

interface Props {
  token: string;
}

export default function CabinChat({ token }: Props) {
  const [messages, setMessages] = useState<Msg[]>([
    { role: "assistant", content: "Hi! Ask me anything about the van — audio, CarPlay, controls, anything." },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const ask = async (text: string) => {
    if (!text.trim() || busy) return;
    const next: Msg[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const res = await postJson<{ reply: string }>(token, "/api/cabin-chat", { messages: next });
      setMessages([...next, { role: "assistant", content: res.reply }]);
    } catch (err) {
      setMessages([
        ...next,
        { role: "assistant", content: "Hmm, couldn't reach the assistant. Try again in a sec." },
      ]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
              m.role === "user"
                ? "ml-auto bg-emerald-700 text-white"
                : "mr-auto bg-zinc-800 text-zinc-100"
            }`}
          >
            {m.content}
          </div>
        ))}
        {busy && (
          <div className="mr-auto inline-flex items-center gap-2 rounded-2xl bg-zinc-800 px-3 py-2 text-sm text-zinc-400">
            <Loader2 size={12} className="animate-spin" /> typing…
          </div>
        )}
      </div>

      {messages.length <= 1 && (
        <div className="border-t border-zinc-900 px-3 py-2">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">Try asking</div>
          <div className="flex flex-wrap gap-1.5">
            {QUICK_QUESTIONS.map((q) => (
              <button
                key={q}
                onClick={() => ask(q)}
                className="rounded-full bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
              >
                <MessageCircleQuestion size={11} className="mr-1 inline" />
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
        className="flex items-center gap-2 border-t border-zinc-900 bg-zinc-950 p-3"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about the van…"
          className="flex-1 rounded-2xl border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-emerald-700"
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="rounded-2xl bg-emerald-600 p-2.5 text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          <Send size={16} />
        </button>
      </form>
    </div>
  );
}
