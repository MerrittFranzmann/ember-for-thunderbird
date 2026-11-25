// Find a time: when everyone is free, from Exchange's busy times (sparkCalendar.availability). Pure; unit-tested.

export interface Busy { start: number; end: number }
export interface PersonBusy { email: string; busy: Busy[]; /** Exchange couldn't see their calendar. */ unknown?: boolean }

export interface SlotOptions {
  /** Look from here (a slot never starts before `now`) to there. */
  from: number;
  to: number;
  now: number;
  minutes: number;
  /** Working hours, minutes from midnight. */
  dayStart?: number;
  dayEnd?: number;
  step?: number;
  weekdays?: boolean;
  limit?: number;
}

/** Times everyone (whose calendar Exchange could see) is free for `minutes`, within working hours. One per free
 *  stretch (the first time of it), so the choices spread across the days. */
export function freeSlots(people: PersonBusy[], o: SlotOptions): Busy[] {
  const { minutes, dayStart = 9 * 60, dayEnd = 17 * 60, step = 30, weekdays = true, limit = 5 } = o;
  const busy = people.filter((p) => !p.unknown).flatMap((p) => p.busy).sort((a, b) => a.start - b.start);
  const length = minutes * 60000;
  const out: Busy[] = [];
  const day = new Date(o.from); day.setHours(0, 0, 0, 0);
  for (let i = 0; out.length < limit && day.getTime() < o.to && i < 31; i++, day.setDate(day.getDate() + 1)) {
    if (weekdays && (day.getDay() === 0 || day.getDay() === 6)) continue;
    const open = new Date(day); open.setHours(0, dayStart, 0, 0);
    const close = new Date(day); close.setHours(0, dayEnd, 0, 0);
    let t = Math.max(open.getTime(), o.from, Math.ceil(o.now / (step * 60000)) * step * 60000);
    // Back onto the step grid from the day's start.
    t = open.getTime() + Math.ceil((t - open.getTime()) / (step * 60000)) * step * 60000;
    let inStretch = false;
    for (; t + length <= Math.min(close.getTime(), o.to) && out.length < limit; t += step * 60000) {
      const clash = busy.some((b) => b.start < t + length && b.end > t);
      if (clash) { inStretch = false; continue; }
      if (!inStretch) out.push({ start: t, end: t + length });
      inStretch = true;
    }
  }
  return out;
}

/** Whether everyone (who could be seen) is free then. */
export function everyoneFree(people: PersonBusy[], start: number, end: number): boolean {
  return !people.some((p) => !p.unknown && p.busy.some((b) => b.start < end && b.end > start));
}

/** A day's busy blocks for a timeline from `dayStart` to `dayEnd` (minutes): left/width as fractions. */
export function timeline(busy: Busy[], day: number, dayStart = 8 * 60, dayEnd = 18 * 60): { left: number; width: number }[] {
  const d = new Date(day); d.setHours(0, 0, 0, 0);
  const from = d.getTime() + dayStart * 60000, to = d.getTime() + dayEnd * 60000, span = to - from;
  return busy.filter((b) => b.end > from && b.start < to).map((b) => {
    const a = Math.max(b.start, from), z = Math.min(b.end, to);
    return { left: (a - from) / span, width: (z - a) / span };
  });
}

/** "Thu 1:00 PM" for a slot pill, "Thu, Nov 19 · 1:00 – 1:30 PM" in full. */
export function slotLabel(slot: Busy, locale?: string, full = false): string {
  const d = new Date(slot.start);
  const time = (at: number) => new Date(at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (!full) return `${d.toLocaleDateString(locale, { weekday: "short" })} ${time(slot.start)}`;
  return `${d.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" })} · ${time(slot.start)} – ${time(slot.end)}`;
}
