// The Calendar page's geometry and wording (Day / Week / Month / Year, Apple Calendar style): ranges, titles,
// where each event sits in a day column, month cells, and the emails that belong to a meeting. Pure; unit-tested.
import type { CalendarEvent } from "./meeting-status";
import { inviteTitle, responseSubject } from "./meeting-subjects";
import type { MessageHeader } from "./types";

export type CalendarMode = "day" | "week" | "month" | "year";
export const CALENDAR_MODES: CalendarMode[] = ["day", "week", "month", "year"];
/** Height of one hour in the Day and Week grids. */
export const HOUR_PX = 52;
const DAY_MS = 86400000;

/** Apple's calendar colours, in the order of Ember's account dots (blue, orange, green, purple, …). */
export const CALENDAR_COLORS = ["#1a9cf0", "#ff9500", "#34c759", "#af52de", "#ff2d55", "#00b4b4", "#e6b800", "#ff3b30"];

export const ms = (iso: string) => Date.parse(iso);
export function startOfDay(at: number | Date): Date { const d = new Date(at); d.setHours(0, 0, 0, 0); return d; }
export function addDays(at: number | Date, days: number): Date { const d = new Date(at); d.setDate(d.getDate() + days); return d; }
export function sameDay(a: number | Date, b: number | Date): boolean { return startOfDay(a).getTime() === startOfDay(b).getTime(); }

/** The first day of the week for this locale (0 = Sunday), as Apple Calendar uses it. */
export function firstWeekday(locale?: string): number {
  try {
    const info = (new Intl.Locale(locale || navigator.language) as any);
    const week = info.getWeekInfo?.() || info.weekInfo;
    if (week?.firstDay) return week.firstDay % 7;
  } catch { /* older engines */ }
  return 0;
}
export function weekStartOf(at: number | Date, firstDay: number): Date {
  const d = startOfDay(at);
  return addDays(d, -((d.getDay() - firstDay + 7) % 7));
}

/** What the page shows for a mode: [start, end) at local midnights. Year shows months only (no events read). */
export function rangeFor(mode: CalendarMode, anchor: number, firstDay: number): { start: Date; end: Date } {
  if (mode === "day") { const start = startOfDay(anchor); return { start, end: addDays(start, 1) }; }
  if (mode === "week") { const start = weekStartOf(anchor, firstDay); return { start, end: addDays(start, 7) }; }
  if (mode === "month") {
    const first = new Date(anchor); first.setDate(1); first.setHours(0, 0, 0, 0);
    const start = weekStartOf(first, firstDay);
    const next = new Date(first); next.setMonth(next.getMonth() + 1);
    // Whole weeks up to the end of the month.
    const days = Math.ceil((next.getTime() - start.getTime()) / DAY_MS / 7) * 7;
    return { start, end: addDays(start, days) };
  }
  const start = new Date(new Date(anchor).getFullYear(), 0, 1);
  return { start, end: new Date(start.getFullYear() + 1, 0, 1) };
}

/** The anchor one step back or forward (a day, a week, a month, a year). */
export function step(mode: CalendarMode, anchor: number, direction: 1 | -1): number {
  const d = startOfDay(anchor);
  if (mode === "day") d.setDate(d.getDate() + direction);
  else if (mode === "week") d.setDate(d.getDate() + 7 * direction);
  else if (mode === "month") { d.setDate(1); d.setMonth(d.getMonth() + direction); }
  else { d.setDate(1); d.setMonth(0); d.setFullYear(d.getFullYear() + direction); }
  return d.getTime();
}

/** Apple's title: the bold part ("November") and the rest ("2026"). */
export function titleFor(mode: CalendarMode, anchor: number, firstDay: number, locale?: string): { bold: string; rest: string } {
  const d = new Date(anchor);
  const month = (at: Date, style: "long" | "short") => at.toLocaleDateString(locale, { month: style });
  if (mode === "year") return { bold: String(d.getFullYear()), rest: "" };
  // "November 16, 2026": the comma stays with the bold part.
  if (mode === "day") return { bold: `${d.toLocaleDateString(locale, { month: "long", day: "numeric" })},`, rest: String(d.getFullYear()) };
  if (mode === "week") {
    const { start, end } = rangeFor("week", anchor, firstDay);
    const last = addDays(end, -1);
    if (start.getMonth() === last.getMonth()) return { bold: month(start, "long"), rest: String(start.getFullYear()) };
    const years = start.getFullYear() === last.getFullYear() ? String(start.getFullYear()) : `${start.getFullYear()} – ${last.getFullYear()}`;
    return { bold: `${month(start, "short")} – ${month(last, "short")}`, rest: years };
  }
  return { bold: month(d, "long"), rest: String(d.getFullYear()) };
}

/** A stable key for an event occurrence (recurring meetings share an item id on some servers). */
/** The calendar an event is on: an account's main calendar (its id), or another calendar's key. */
export const calendarOf = (event: Pick<CalendarEvent, "accountId" | "calendarId">) => event.calendarId || event.accountId;
export const eventKey = (event: Pick<CalendarEvent, "accountId" | "id" | "start" | "calendarId">) => `${calendarOf(event)}|${event.id}|${event.start}`;

/** An event's title: "Busy" for a busy time from a calendar the user can't read. */
export const eventTitle = (event: Pick<CalendarEvent, "subject" | "busyOnly">) => event.subject || (event.busyOnly ? "Busy" : "(no title)");

/** In the all-day row: all-day events, and timed ones lasting a day or more (as Apple shows them). */
export function inAllDayRow(event: CalendarEvent): boolean {
  return event.allDay || ms(event.end) - ms(event.start) >= DAY_MS;
}

/** Events the page shows: not declined (Exchange keeps some), not on hidden calendars, earliest first. */
export function shownEvents(events: CalendarEvent[], hidden: ReadonlySet<string>): CalendarEvent[] {
  return events.filter((e) => e.response !== "decline" && !hidden.has(calendarOf(e)))
    .sort((a, b) => ms(a.start) - ms(b.start) || ms(b.end) - ms(a.end) || (a.subject || "").localeCompare(b.subject || ""));
}

/** Events that touch [from, to). */
export function during(events: CalendarEvent[], from: number, to: number): CalendarEvent[] {
  return events.filter((e) => ms(e.start) < to && (ms(e.end) > from || (ms(e.end) === ms(e.start) && ms(e.start) >= from)));
}

export interface Placed {
  event: CalendarEvent;
  /** Pixels from the top of the day column, and height (at least a quarter hour). */
  top: number;
  height: number;
  /** Side-by-side lanes for overlapping events: this one's lane, and how many its group uses. */
  lane: number;
  lanes: number;
  /** Lanes it can fill from its own (rightwards, while nothing else overlaps it there). */
  span: number;
  startsBefore: boolean;
  endsAfter: boolean;
}
/** Timed events in one day column, placed in lanes like Apple Calendar. */
export function placeDay(events: CalendarEvent[], day: number | Date, hourPx = HOUR_PX): Placed[] {
  const from = startOfDay(day).getTime(), to = addDays(from, 1).getTime();
  const minute = hourPx / 60;
  const items = during(events.filter((e) => !inAllDayRow(e)), from, to).map((event) => {
    const start = Math.max(ms(event.start), from), end = Math.min(Math.max(ms(event.end), ms(event.start)), to);
    // Minutes from midnight by the clock (a DST day still reads 9 AM at 9 AM).
    const startMin = start === from ? 0 : new Date(start).getHours() * 60 + new Date(start).getMinutes();
    const endMin = end === to ? 24 * 60 : new Date(end).getHours() * 60 + new Date(end).getMinutes();
    return { event, startMin, endMin: Math.max(endMin, startMin + 15), startsBefore: ms(event.start) < from, endsAfter: ms(event.end) > to };
  }).sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const placed: Placed[] = [];
  let group: (typeof items[number] & { lane: number })[] = [];
  let groupEnd = -1;
  const flush = () => {
    const lanes: number[] = [];
    for (const item of group) {
      let lane = lanes.findIndex((end) => end <= item.startMin);
      if (lane < 0) { lane = lanes.length; lanes.push(0); }
      lanes[lane] = item.endMin;
      item.lane = lane;
    }
    for (const item of group) {
      let span = 1;
      while (item.lane + span < lanes.length && !group.some((o) => o !== item && o.lane === item.lane + span && o.startMin < item.endMin && o.endMin > item.startMin)) span++;
      placed.push({ event: item.event, top: item.startMin * minute, height: (item.endMin - item.startMin) * minute, lane: item.lane, lanes: lanes.length, span, startsBefore: item.startsBefore, endsAfter: item.endsAfter });
    }
    group = [];
  };
  for (const item of items) {
    if (group.length && item.startMin >= groupEnd) flush();
    group.push({ ...item, lane: 0 });
    groupEnd = Math.max(groupEnd, item.endMin);
  }
  if (group.length) flush();
  return placed;
}

/** All-day-row events on one day. */
export function allDayOn(events: CalendarEvent[], day: number | Date): CalendarEvent[] {
  const from = startOfDay(day).getTime();
  return during(events.filter(inAllDayRow), from, addDays(from, 1).getTime());
}

/** The days of a range, one Date per local midnight. */
export function daysOf(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  for (let d = startOfDay(start); d < end; d = addDays(d, 1)) days.push(d);
  return days;
}

export interface MonthCell { date: Date; inMonth: boolean; events: CalendarEvent[] }
/** The month grid's cells: whole weeks, each day's events (all-day first, then by time). */
export function monthCells(anchor: number, firstDay: number, events: CalendarEvent[]): MonthCell[] {
  const { start, end } = rangeFor("month", anchor, firstDay);
  const month = new Date(anchor).getMonth();
  return daysOf(start, end).map((date) => {
    const from = date.getTime(), to = addDays(date, 1).getTime();
    const list = during(events, from, to).sort((a, b) => Number(inAllDayRow(b)) - Number(inAllDayRow(a)) || ms(a.start) - ms(b.start));
    return { date, inMonth: date.getMonth() === month, events: list };
  });
}

/** A small month (sidebar, Year view): always six weeks, so its height doesn't jump. */
export function miniMonth(year: number, month: number, firstDay: number): { date: Date; inMonth: boolean }[] {
  const start = weekStartOf(new Date(year, month, 1), firstDay);
  return Array.from({ length: 42 }, (_, i) => { const date = addDays(start, i); return { date, inMonth: date.getMonth() === month }; });
}

/** Weekday names from the first day of the week: [short, letter]. */
export function weekdayNames(firstDay: number, locale?: string): { short: string; letter: string; long: string }[] {
  const sunday = new Date(2026, 10, 15); // a Sunday
  return Array.from({ length: 7 }, (_, i) => {
    const d = addDays(sunday, (firstDay + i) % 7);
    const short = d.toLocaleDateString(locale, { weekday: "short" });
    return { short, letter: d.toLocaleDateString(locale, { weekday: "narrow" }), long: d.toLocaleDateString(locale, { weekday: "long" }) };
  });
}

/** How an event is drawn: an unanswered invitation is outlined, a maybe is striped, free time is faint. */
export type EventLook = "unanswered" | "tentative" | "free" | "cancelled" | "busy";
export function eventLook(event: CalendarEvent): EventLook {
  if (event.cancelled) return "cancelled";
  if (event.response === "none") return "unanswered";
  if (event.response === "tentative" || event.freeBusy === "Tentative") return "tentative";
  if (event.freeBusy === "Free" || event.freeBusy === "WorkingElsewhere") return "free";
  return "busy";
}

/** Other busy events at the same time (for "Overlaps …" in the details). */
export function overlapsWith(event: CalendarEvent, events: CalendarEvent[]): CalendarEvent[] {
  if (inAllDayRow(event)) return [];
  if (event.shared) return [];
  return events.filter((o) => o !== event && eventKey(o) !== eventKey(event) && !o.shared && !inAllDayRow(o) && !o.cancelled && o.response !== "decline"
    && o.freeBusy !== "Free" && ms(o.start) < ms(event.end) && ms(o.end) > ms(event.start));
}

/** Whether the user answers this event (an invitation), or owns it (organizer, or their own appointment). */
export function isInvitation(event: CalendarEvent): boolean {
  return event.response === "none" || event.response === "accept" || event.response === "tentative" || event.response === "decline";
}

/** "Monday, November 16, 2026" and "9:00 – 9:30 AM" (or "All day", or a span across days). */
export function whenText(event: CalendarEvent, locale?: string): { day: string; time: string } {
  const start = new Date(ms(event.start)), end = new Date(ms(event.end));
  const long = (d: Date) => d.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const time = (d: Date) => d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  if (event.allDay) {
    const last = addDays(end, -1);
    return { day: long(start), time: last > start && !sameDay(last, start) ? `All day, until ${last.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" })}` : "All day" };
  }
  if (!sameDay(start, end) && !(end.getHours() === 0 && end.getMinutes() === 0 && sameDay(addDays(end, -1), start))) {
    return { day: long(start), time: `${time(start)} to ${end.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" })}, ${time(end)}` };
  }
  return { day: long(start), time: `${time(start)} to ${time(end)}` };
}

/** "9 AM" / "9:30 AM" (short times for grid blocks and month rows). */
export function shortTime(at: number, locale?: string): string {
  const d = new Date(at);
  return d.toLocaleTimeString(locale, { hour: "numeric", minute: d.getMinutes() ? "2-digit" : undefined });
}

/** The meeting's notes without the call boilerplate Teams, Zoom and Outlook add. */
export function eventNotes(body: string | undefined): string {
  let text = (body || "").replace(/\r\n?/g, "\n");
  // Teams/Zoom blocks start with a rule of underscores or "Microsoft Teams meeting" / "Join Zoom Meeting".
  const cut = text.search(/^\s*(?:_{10,}|Microsoft Teams(?: meeting| Need help\?)|Join Zoom Meeting|-::~:~::~:)/im);
  if (cut >= 0) text = text.slice(0, cut);
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  return text.length > 800 ? `${text.slice(0, 800).trimEnd()}…` : text;
}

const normal = (subject: string) => {
  let title = inviteTitle(responseSubject(subject)?.title ?? subject);
  // "Canceled: X", "Re: X", "RE: FW: X".
  for (let previous = ""; previous !== title;) { previous = title; title = title.replace(/^(?:re|aw|sv|fw|fwd|canceled|cancelled)\s*:\s*/i, ""); }
  return title.toLowerCase().replace(/\s+/g, " ").trim();
};
/** Saved emails about a meeting: its invitation, answers and replies (same title), newest first. */
export function emailsAbout(event: CalendarEvent, headers: MessageHeader[], limit = 4): MessageHeader[] {
  const title = normal(event.subject || "");
  if (title.length < 4) return [];
  return headers.filter((m) => !m.junk && !m.folder?.specialUse?.some((use) => use === "junk" || use === "trash") && normal(m.subject || "") === title)
    .sort((a, b) => +new Date(b.date) - +new Date(a.date))
    .filter((m, i, list) => list.findIndex((o) => o.headerMessageId === m.headerMessageId) === i)
    .slice(0, limit);
}

/** Events whose title, place or people match a search, soonest first from `from`. */
/** Search results with each repeating event once: its next occurrence (or, if all are past, its latest), and how
 *  many occurrences were found. Upcoming first, soonest first; then past ones, most recent first. */
export function oncePerSeries(events: CalendarEvent[], now: number): { event: CalendarEvent; count: number }[] {
  const series = new Map<string, { event: CalendarEvent; count: number }>();
  const upcoming = (e: CalendarEvent) => ms(e.end) > now;
  for (const event of events) {
    const key = event.uid ? `${event.accountId}|${event.calendarId || ""}|${event.uid}` : eventKey(event);
    const seen = series.get(key);
    if (!seen) { series.set(key, { event, count: 1 }); continue; }
    seen.count++;
    const a = seen.event, b = event;
    const better = upcoming(b) ? !upcoming(a) || ms(b.start) < ms(a.start) : !upcoming(a) && ms(b.start) > ms(a.start);
    if (better) seen.event = b;
  }
  return [...series.values()].sort((x, y) => {
    const ux = upcoming(x.event), uy = upcoming(y.event);
    if (ux !== uy) return ux ? -1 : 1;
    return ux ? ms(x.event.start) - ms(y.event.start) : ms(y.event.start) - ms(x.event.start);
  });
}

export function searchEvents(events: CalendarEvent[], query: string): CalendarEvent[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return events.filter((e) => {
    const text = `${e.subject} ${e.location} ${(e.attendees || []).map((p) => `${p.name} ${p.email}`).join(" ")}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}
