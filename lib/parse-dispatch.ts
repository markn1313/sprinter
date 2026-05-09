import Anthropic from "@anthropic-ai/sdk";

export type DispatchKind = "trip" | "stop_request" | "pickup_now" | "unclear";

export interface ParsedDispatch {
  kind: DispatchKind;
  passengerName: string;
  isOwnerRiding: boolean;
  pickupHint: string | null;
  dropoffHint: string | null;
  scheduledAt: string; // ISO UTC
  // Stop-request specific
  stopCategory: string | null; // e.g. 'coffee', 'food', 'gas'
  stopOffsetMinutes: number | null; // when (from now) the stop should happen
  rawNotes: string;
}

const SYSTEM_PROMPT = `You are a dispatch parser for Mark's private Sprinter van service. The user typing is always Mark (owner). Dio is the driver.

Output STRICT JSON only. Keys:
- kind: "trip" | "stop_request" | "pickup_now" | "unclear"
   - "pickup_now": Mark wants to be picked up RIGHT NOW from his current location ("come get me", "pick me up now", "I'm ready", "send the van to me")
   - "stop_request": Mark wants to add a stop on the way ("stop for coffee", "I need a restroom", "fuel stop", "grab food")
   - "trip": full trip with passenger / pickup / dropoff
   - "unclear": cannot determine
- passengerName: string. Use "Mark" if Mark himself is the rider; never the imperative verb like "Pick" or "Send"
- isOwnerRiding: boolean. true for "me", "myself", "I", "I'm" — Mark is the rider
- pickupHint: string|null. e.g. "home", "Wynn lobby"; for pickup_now use "current location"
- dropoffHint: string|null. Capitalize venues/landmarks ("Intuit Dome" not "intuit dome"). For pickup_now, dropoff is null.
- scheduledAt: ISO 8601 UTC. Resolve relative times in America/Los_Angeles (PT) and convert to UTC.
- stopCategory: only for kind="stop_request". One of: coffee, food, fast_food, restroom, gas, grocery, pharmacy, atm, ev_charging, rest_stop. Else null.
- stopOffsetMinutes: only for kind="stop_request". Minutes from now to make the stop. Default 15 if unspecified.

TIME PARSING RULES — read carefully, this is the most error-prone part:

1. Mark's local time is America/Los_Angeles (PT). Resolve every time in PT and emit UTC.
2. A BARE clock time like "5pm" / "5" / "17:00" with no day word always means the NEXT FUTURE occurrence in PT. The result MUST be after the current PT moment. Never resolve a bare time to a moment that has already passed today — that's wrong even if "today's 5pm" feels natural; if 5pm has already passed today PT, "5pm" means tomorrow's 5pm.
3. "today at X" = today's calendar day in PT (must still be future; if today's X has passed, treat as the user mis-spoke and use today anyway only if within 5 minutes past, else use tomorrow's X).
4. "tomorrow at X" = next calendar day in PT.
5. "tonight" = the upcoming evening (later today PT if it's still before ~8pm PT, else assume the user means right now or imminent).
6. "in N minutes/hours" = now + N.
7. Default scheduledAt = now + 30 min if no time given.
8. For pickup_now, scheduledAt = now.

Examples (assume current PT is shown above each):

  PT now: Friday May 9, 12:30 AM. Input: "Pick me up at 5pm"
  → 5pm Friday May 9 PT (the next future 5pm, ~16.5 hrs away). NOT 5pm Thursday May 8.

  PT now: Friday May 9, 6:30 PM. Input: "Pick me up at 5pm"
  → 5pm Saturday May 10 PT (today's 5pm has already passed).

  PT now: Friday May 9, 3:00 PM. Input: "5pm"
  → 5pm Friday May 9 PT (today, ~2 hrs away).

  PT now: Saturday May 10, 11:00 PM. Input: "tomorrow at 9am"
  → 9am Sunday May 11 PT.`;

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
      max_tokens: 320,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Now (UTC): ${nowIso}\nNow (Mark local): ${nowPT}\n\nDispatch input:\n"${input.replace(/"/g, '\\"')}"\n\nReturn only the JSON object.`,
        },
      ],
    });

    const block = resp.content[0];
    const text = block && block.type === "text" ? block.text : "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return regexFallback(input, now);
    const parsed = JSON.parse(m[0]) as Partial<ParsedDispatch>;
    return finalize(parsed, input, now);
  } catch (err) {
    console.warn("Parser LLM threw:", err);
    return regexFallback(input, now);
  }
}

function finalize(parsed: Partial<ParsedDispatch>, input: string, now: Date): ParsedDispatch {
  let validScheduled =
    parsed.scheduledAt && !isNaN(new Date(parsed.scheduledAt).getTime())
      ? new Date(parsed.scheduledAt).toISOString()
      : new Date(now.getTime() + 30 * 60_000).toISOString();

  // Past-time guard: bare-time inputs ("5pm") that the model resolves to
  // earlier today (or any time before "now") are almost certainly meant to be
  // the next future occurrence. Skip the guard for explicit pickup_now (which
  // is intentionally "now") and stop_request (which is offset-based, not a
  // scheduled trip). Allow up to 5 min of clock skew.
  const kind = parsed.kind as DispatchKind | undefined;
  if (kind !== "pickup_now" && kind !== "stop_request") {
    const scheduled = new Date(validScheduled).getTime();
    const cutoff = now.getTime() - 5 * 60_000;
    if (scheduled < cutoff) {
      // Advance by full 24-hour increments until it's in the future.
      let advanced = scheduled;
      while (advanced < cutoff) advanced += 24 * 3600_000;
      validScheduled = new Date(advanced).toISOString();
    }
  }

  return {
    kind: (parsed.kind as DispatchKind) || "trip",
    passengerName: parsed.passengerName || "Guest",
    isOwnerRiding: !!parsed.isOwnerRiding,
    pickupHint: parsed.pickupHint || null,
    dropoffHint: parsed.dropoffHint || null,
    scheduledAt: validScheduled,
    stopCategory: parsed.stopCategory || null,
    stopOffsetMinutes:
      typeof parsed.stopOffsetMinutes === "number" ? parsed.stopOffsetMinutes : null,
    rawNotes: input.trim(),
  };
}

function regexFallback(input: string, now: Date): ParsedDispatch {
  const raw = input.trim();
  const isOwner = /\b(me|myself|i am|i'm)\b/i.test(raw);
  const pickupNow =
    /\b(pick me up|come get me|send (?:the )?van to me|i'?m ready|i need a ride)\b/i.test(raw);
  const stopReq = /\b(stop|grab|need)\b/i.test(raw) && /\b(coffee|food|gas|bathroom|restroom)\b/i.test(raw);
  const passengerName = isOwner
    ? "Mark"
    : raw.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/)?.[1] ?? "Guest";

  return {
    kind: pickupNow ? "pickup_now" : stopReq ? "stop_request" : "trip",
    passengerName,
    isOwnerRiding: isOwner || pickupNow,
    pickupHint: pickupNow ? "current location" : null,
    dropoffHint: null,
    scheduledAt: pickupNow
      ? now.toISOString()
      : new Date(now.getTime() + 30 * 60_000).toISOString(),
    stopCategory: null,
    stopOffsetMinutes: null,
    rawNotes: raw,
  };
}

export const parseDispatch = parseDispatchWithLLM;
