import { addHours, addMinutes, set, startOfDay, addDays } from "date-fns";

export interface ParsedDispatch {
  passengerName: string;
  pickupHint: string | null;
  dropoffHint: string | null;
  scheduledAt: string;
  rawNotes: string;
}

const FILLER = /\b(send|the|van|to|pick up|pickup|drive|take|at|then|to take|to drive|to pick up|so he can go to|so they can go to)\b/gi;

const ABS_TIME = /\b(\d{1,2})(?::(\d{2}))?\s?(am|pm)?\b/i;
const RELATIVE_NOW = /\b(now|right now|asap|immediately)\b/i;
const IN_DURATION = /\bin\s+(\d+)\s+(min|mins|minutes|hour|hours|hr|hrs)\b/i;

export function parseDispatch(input: string, now = new Date()): ParsedDispatch {
  const raw = input.trim();
  let work = " " + raw + " ";

  // 1) Time
  let scheduledAt = now.toISOString();
  if (RELATIVE_NOW.test(work)) {
    scheduledAt = now.toISOString();
    work = work.replace(RELATIVE_NOW, " ");
  } else {
    const inMatch = work.match(IN_DURATION);
    if (inMatch) {
      const n = Number(inMatch[1]);
      const unit = inMatch[2].toLowerCase();
      const d = unit.startsWith("h") ? addHours(now, n) : addMinutes(now, n);
      scheduledAt = d.toISOString();
      work = work.replace(IN_DURATION, " ");
    } else {
      const m = work.match(ABS_TIME);
      if (m) {
        const hour = Number(m[1]);
        const minute = m[2] ? Number(m[2]) : 0;
        const ap = m[3]?.toLowerCase();
        let h24 = hour;
        if (ap === "pm" && hour < 12) h24 += 12;
        if (ap === "am" && hour === 12) h24 = 0;
        if (!ap && hour < 7) h24 = hour + 12; // 6 means 6pm by default in dispatch
        let target = set(startOfDay(now), { hours: h24, minutes: minute });
        if (target.getTime() < now.getTime() - 30 * 60_000) {
          target = addDays(target, 1);
        }
        scheduledAt = target.toISOString();
        work = work.replace(ABS_TIME, " ");
      }
    }
  }

  // 2) Pickup / dropoff
  let pickupHint: string | null = null;
  let dropoffHint: string | null = null;

  const fromMatch = work.match(/\bfrom\s+([^,]+?)(?:\s+to\s+|$)/i);
  if (fromMatch) {
    pickupHint = fromMatch[1].trim();
    work = work.replace(fromMatch[0], " ");
  }
  const toMatch = work.match(/\bto\s+([^,]+?)(?:\s+at\s+|$)/i);
  if (toMatch) {
    dropoffHint = toMatch[1].trim();
    work = work.replace(toMatch[0], " ");
  }

  // 3) Passenger name — first capitalized token sequence remaining
  const nameMatch = raw.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/);
  const passengerName = nameMatch ? nameMatch[1] : "Guest";

  return {
    passengerName,
    pickupHint,
    dropoffHint,
    scheduledAt,
    rawNotes: raw,
  };
}
