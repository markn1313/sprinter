"use client";

import { useEffect, useState, useRef } from "react";
import { api } from "@/lib/api-client";
import { MapPin, Loader2 } from "lucide-react";

interface Result {
  lat: number;
  lng: number;
  display: string;
}

interface Props {
  token: string;
  placeholder?: string;
  onSelect: (result: Result) => void;
}

export default function AddressAutocomplete({ token, placeholder = "Add a stop or destination", onSelect }: Props) {
  const [text, setText] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const tRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (tRef.current) clearTimeout(tRef.current);
    if (text.trim().length < 3) {
      setResults([]);
      return;
    }
    tRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api<{ results: Result[] }>(
          token,
          `/api/places/autocomplete?q=${encodeURIComponent(text)}`,
        );
        setResults(data.results || []);
        setOpen(true);
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => {
      if (tRef.current) clearTimeout(tRef.current);
    };
  }, [text, token]);

  const pick = (r: Result) => {
    onSelect(r);
    setText("");
    setResults([]);
    setOpen(false);
  };

  return (
    <div className="relative">
      <div className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-2">
        <MapPin size={14} className="text-zinc-500" />
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setOpen(results.length > 0)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={placeholder}
          className="flex-1 bg-transparent text-sm text-zinc-100 placeholder-zinc-500 outline-none"
        />
        {loading && <Loader2 size={14} className="animate-spin text-zinc-500" />}
      </div>
      {open && results.length > 0 && (
        <ul className="absolute z-30 mt-1 w-full overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950/95 shadow-2xl backdrop-blur">
          {results.map((r, i) => (
            <li key={i}>
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(r)}
                className="block w-full truncate px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800"
              >
                {r.display}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
