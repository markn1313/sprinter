// Anchors all editable / display times to America/Los_Angeles regardless of
// the user's device timezone. The HTML <input type="datetime-local"> control
// has no timezone parameter — it always renders in the device timezone — so
// we project trips into PT manually and parse them back the same way. Mark
// might be on his phone in NY, but a Sprinter trip's "5pm" always means 5pm
// PT.

export function toPTInput(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  let hour = get("hour");
  if (hour === "24") hour = "00";
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}`;
}

export function fromPTInput(local: string): string {
  const [datePart, timePart] = local.split("T");
  if (!datePart || !timePart) return new Date(local).toISOString();
  const [y, mo, d] = datePart.split("-").map(Number);
  const [h, mi] = timePart.split(":").map(Number);

  // PT is always UTC-7 (PDT) or UTC-8 (PST). Build candidate UTC times for
  // both offsets and pick the one that round-trips to the same PT wall clock.
  for (const offset of [7, 8]) {
    const candidate = new Date(Date.UTC(y, mo - 1, d, h + offset, mi));
    if (toPTInput(candidate.toISOString()) === local) return candidate.toISOString();
  }
  // Spring-forward gap (2am–3am vanishes): pick PDT to land safely past it.
  return new Date(Date.UTC(y, mo - 1, d, h + 7, mi)).toISOString();
}
