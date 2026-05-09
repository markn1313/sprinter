import Anthropic from "@anthropic-ai/sdk";

export interface ParsedDispatch {
  passengerName: string;
  isOwnerRiding: boolean;
  pickupHint: string | null;
  dropoffHint: string | null;
  scheduledAt: string; // ISO UTC
  rawNotes: string;
}

const SYSTEM_PROMPT = `You are a dispatch parser for Mark's private Sprinter van service.
Mark is the owner; Dio is the driver. The user typing into the dispatch bar is always Mark.

Output STRICT JSON only, no prose, with these keys:
- passengerName: string  (the rider; if Mark is the rider, use "Mark"; never the imperative verb)
- isOwnerRiding: boolean (true if Mark himself is the rider — phrases like "me", "myself", "I am going")
- pickupHint: string|null (e.g. "home", "Wynn lobby", "John Wayne", or null if not specified)
- dropoffHint: string|null (e.g. "LAX", "Intuit Dome", "Cosmopolitan", or null if not specified) — capitalize venue/city/airport names properly
- scheduledAt: ISO 8601 UTC timestamp for when pickup happens

Mark is in America/Los_Angeles (PT). Resolve all relative times in his timezone and convert to UTC.
Examples (assuming "now" is Friday 2026-05-08 22:00 PT = 2026-05-09T05:00:00Z):
- "now" / "asap" / "right away" → now (current UTC)
- "in 30 minutes" → now + 30m
- "5pm" or "5" with no modifier → today 5pm PT if still future, otherwise tomorrow 5pm PT
- "tomorrow at 5pm" → 2026-05-09T17:00 PT = 2026-05-10T00:00:00Z
- "next Tuesday at 9" → upcoming Tuesday 9am PT (or 9pm if context suggests evening)
- If you can't determine a time, default to 30 minutes from now`;

export async function parseDispatchWithLLM(input: string, now = new Date()): Promise<ParsedDispatch> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return regexFallback(input, now);
  }

  const anthropic = new Anthropic({ apiKey });

  const nowIso = now.toISOString();
  const nowPT = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(now);

  try {
    const resp = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 256,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Now (UTC): ${nowIso}\nNow (Mark's local): ${nowPT}\n\nDispatch input:\n"${input.replace(/"/g, '\\"')}"\n\nReturn only the JSON object.`,
        },
      ],
    });

    const block = resp.content[0];
    const text = block && block.type === "text" ? block.text : "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("Parser LLM returned non-JSON:", text);
      return regexFallback(input, now);
    }
    const parsed = JSON.parse(jsonMatch[0]) as Partial<ParsedDispatch>;

    return {
      passengerName: parsed.passengerName || "Guest",
      isOwnerRiding: !!parsed.isOwnerRiding,
      pickupHint: parsed.pickupHint || null,
      dropoffHint: parsed.dropoffHint || null,
      scheduledAt: parsed.scheduledAt && !isNaN(new Date(parsed.scheduledAt).getTime())
        ? new Date(parsed.scheduledAt).toISOString()
        : new Date(now.getTime() + 30 * 60_000).toISOString(),
      rawNotes: input.trim(),
    };
  } catch (err) {
    console.warn("Parser LLM threw:", err);
    return regexFallback(input, now);
  }
}

// Last-resort regex fallback — kept so dispatch never fails outright.
function regexFallback(input: string, now: Date): ParsedDispatch {
  const raw = input.trim();
  const lower = raw.toLowerCase();
  const isOwner = /\b(me|myself|i am|i'm)\b/i.test(raw);
  const passengerName = isOwner
    ? "Mark"
    : (raw.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/)?.[1] ??
        (raw.match(/\bpick(?:ing|s|ed)?\s+up\s+([a-z]+)/i)?.[1] ?? "Guest"));

  let scheduled = new Date(now.getTime() + 30 * 60_000);
  const inMatch = lower.match(/\bin\s+(\d+)\s+(min|mins|minutes|hour|hours|hr|hrs)\b/);
  if (inMatch) {
    const n = Number(inMatch[1]);
    const unit = inMatch[2];
    scheduled = new Date(now.getTime() + n * (unit.startsWith("h") ? 3600_000 : 60_000));
  }

  const fromMatch = raw.match(/\bfrom\s+([^,]+?)(?:\s+to\s+|$)/i);
  const toMatch = raw.match(/\bto\s+([^,]+?)(?:\s+at\s+|$)/i);

  return {
    passengerName: passengerName.charAt(0).toUpperCase() + passengerName.slice(1).toLowerCase(),
    isOwnerRiding: isOwner,
    pickupHint: fromMatch ? fromMatch[1].trim() : null,
    dropoffHint: toMatch ? toMatch[1].trim() : null,
    scheduledAt: scheduled.toISOString(),
    rawNotes: raw,
  };
}

// Backwards-compat export name
export const parseDispatch = parseDispatchWithLLM;
