"use client";

import { useEffect, useRef, useState } from "react";
import { postJson } from "@/lib/api-client";
import { Mic, MicOff, Loader2 } from "lucide-react";

interface Props {
  token: string;
  tripId?: string | null;
}

// Hold-to-talk voice cabin requests. Web Speech API is universally available
// in Chromium-based browsers and Safari (with permission). We listen ONLY
// while the button is held — privacy-respecting, no always-on mic.
//
// Recognized phrases map to the same cabin_requests endpoint as the chip
// strip. Keywords picked to match how people naturally speak in a moving
// vehicle: "warmer", "make it warmer", "I'm cold", etc.
export default function VoiceCabin({ token, tripId }: Props) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as unknown as { SpeechRecognition?: any; webkitSpeechRecognition?: any };
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!SR) {
      setSupported(false);
      return;
    }
    setSupported(true);
    const r = new SR();
    r.lang = "en-US";
    r.continuous = false;
    r.interimResults = false;
    r.maxAlternatives = 3;
    r.onresult = (e: { results: ArrayLike<{ 0: { transcript: string } }> }) => {
      const transcript = (Array.from(e.results) as Array<{ 0: { transcript: string } }>)
        .map((res) => res[0].transcript)
        .join(" ")
        .toLowerCase();
      void handleTranscript(transcript);
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    recognitionRef.current = r;
    return () => {
      try {
        r.stop();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTranscript = async (transcript: string) => {
    const kind = mapToKind(transcript);
    if (!kind) {
      setFeedback(`"${transcript}" — didn't catch a cabin command`);
      setTimeout(() => setFeedback(null), 2500);
      return;
    }
    setBusy(true);
    try {
      await postJson(token, "/api/cabin-requests", { kind, trip_id: tripId ?? null });
      setFeedback(LABELS[kind]);
      setTimeout(() => setFeedback(null), 1800);
    } catch {
      setFeedback("Send failed");
      setTimeout(() => setFeedback(null), 2000);
    } finally {
      setBusy(false);
    }
  };

  const start = () => {
    if (!supported || listening) return;
    try {
      recognitionRef.current?.start();
      setListening(true);
    } catch {
      // already started or permission denied
    }
  };
  const stop = () => {
    try {
      recognitionRef.current?.stop();
    } catch {}
  };

  if (!supported) return null;

  return (
    <div className="relative">
      <button
        onMouseDown={start}
        onMouseUp={stop}
        onMouseLeave={stop}
        onTouchStart={(e) => {
          e.preventDefault();
          start();
        }}
        onTouchEnd={stop}
        disabled={busy}
        aria-label="Hold to speak a cabin request"
        className={`flex h-14 w-14 items-center justify-center rounded-full shadow-2xl transition-transform active:scale-95 ${
          listening ? "bg-emerald-500 ring-4 ring-emerald-400/40 animate-pulse" : "bg-zinc-900 ring-2 ring-zinc-700"
        }`}
      >
        {busy ? (
          <Loader2 size={22} className="animate-spin text-white" />
        ) : listening ? (
          <Mic size={22} className="text-white" />
        ) : (
          <MicOff size={22} className="text-zinc-300" />
        )}
      </button>
      {feedback && (
        <div className="absolute right-full mr-3 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-100 shadow-xl">
          {feedback}
        </div>
      )}
    </div>
  );
}

const LABELS: Record<string, string> = {
  warmer: "Warmer",
  cooler: "Cooler",
  fan_up: "More fan",
  fan_down: "Less fan",
  music: "Music on",
  quiet: "Quiet",
  restroom: "Restroom",
};

function mapToKind(t: string): string | null {
  if (/(warm|heat|too cold|cold)/.test(t)) return "warmer";
  if (/(cool|cold(er)?\b|too hot|hot|chill\b)/.test(t)) return "cooler";
  if (/(more fan|fan up|higher fan|increase fan|more air)/.test(t)) return "fan_up";
  if (/(less fan|fan down|lower fan|decrease fan|less air)/.test(t)) return "fan_down";
  if (/(music|song|play)/.test(t)) return "music";
  if (/(quiet|silence|no music|turn off music)/.test(t)) return "quiet";
  if (/(restroom|bathroom|stop|pee|gotta go)/.test(t)) return "restroom";
  return null;
}
