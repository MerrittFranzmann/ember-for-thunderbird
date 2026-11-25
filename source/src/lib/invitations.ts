import ICAL from "ical.js";
import type { MessagePart } from "./types";
import { emailOf } from "./format";
export { inviteTitle, responseSubject, responseTally, type Response } from "./meeting-subjects";
import { findJoinLink } from "./meeting-status";
export { findJoinLink };

export interface CalendarDate {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
  allDay: boolean; timezone: string; instant?: string;
}
export interface Invitation {
  uid: string; title: string; method: string; status: string; sequence: number;
  start: CalendarDate | null; end: CalendarDate | null;
  organizer: { name: string; email: string };
  location: string; description: string; recurring: boolean; recurrenceId: string;
  response: string; canRespond: boolean;
  /** The current or next occurrence; `passed` once every occurrence has ended. */
  next: Occurrence | null; passed: boolean;
  /** DTSTAMP (ms), to order two versions with the same SEQUENCE. */
  stamp: number;
  join: { url: string; label: string } | null;
  /** For a REPLY: who answered, and how. */
  replier: { name: string; email: string; response: string } | null;
  comment: string;
}

export { calendarBodies } from "./calendar-parts";

function dateValue(time: ICAL.Time | null, timezone = ""): CalendarDate | null {
  if (!time || !time.year) return null;
  const zone = timezone || (time.zone?.tzid === "UTC" ? "UTC" : "");
  const value: CalendarDate = { year: time.year, month: time.month, day: time.day, hour: time.hour, minute: time.minute, second: time.second, allDay: time.isDate, timezone: zone };
  if (!time.isDate && time.zone && time.zone.tzid !== "floating") value.instant = time.toJSDate().toISOString();
  return value;
}

/** Close components Exchange left open (forwarded recurring meetings can end without END:VCALENDAR). */
export function closeCalendar(text: string): string {
  const open: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [, verb, name] = /^(BEGIN|END):(\S+)/i.exec(line) || [];
    if (verb?.toUpperCase() === "BEGIN") open.push(name.toUpperCase());
    else if (verb && open[open.length - 1] === name.toUpperCase()) open.pop();
  }
  if (!open.length) return text;
  return text.replace(/\r?\n?$/, "\r\n") + open.reverse().map((name) => `END:${name}\r\n`).join("");
}

/** Offset (ms) of an IANA zone from UTC at an instant; NaN for names Intl doesn't know (e.g. Windows zone names). */
function zoneOffset(zone: string, at: number): number {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(at).map((p) => [p.type, +p.value]));
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(at / 1000) * 1000;
  } catch { return NaN; }
}
/** The instant a calendar time means: its resolved zone, else its named zone, else local time. */
function instantOf(time: ICAL.Time, tzid: string): number {
  if (time.isDate || !time.zone || time.zone.tzid === "floating") {
    const wall = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
    if (!time.isDate && tzid) {
      const first = zoneOffset(tzid, wall);
      if (!Number.isNaN(first)) { const guess = wall - first; return wall - zoneOffset(tzid, guess); }
    }
    return new Date(time.year, time.month - 1, time.day, time.hour, time.minute, time.second).getTime();
  }
  return time.toJSDate().getTime();
}

export interface Occurrence { start: number; end: number }
/** The current or next occurrence (one ending after `now`), and whether every occurrence is over. */
function occurrence(event: ICAL.Event, component: ICAL.Component, now: number): { next: Occurrence | null; passed: boolean } {
  if (!event.startDate) return { next: null, passed: false };
  const tzid = String(component.getFirstProperty("dtstart")?.getParameter("tzid") || "");
  const first = instantOf(event.startDate, tzid);
  const end = event.endDate ? instantOf(event.endDate, String(component.getFirstProperty("dtend")?.getParameter("tzid") || tzid)) : first + (event.startDate.isDate ? 86400000 : 0);
  const length = Math.max(0, end - first);
  if (!event.isRecurring()) return first + length > now ? { next: { start: first, end: first + length }, passed: false } : { next: null, passed: true };
  const iterator = event.iterator();
  for (let n = 0; n < 5000; n++) {
    const time = iterator.next();
    if (!time) return { next: null, passed: true };
    const start = instantOf(time, tzid);
    if (start + length > now) return { next: { start, end: start + length }, passed: false };
  }
  return { next: null, passed: false }; // a very long series: don't call it over
}

export function parseInvitations(text: string, me: Set<string> = new Set(), now = Date.now()): Invitation[] {
  if (text.length > 1024 * 1024) throw new Error("Calendar file is too large to preview. Open it in Thunderbird.");
  const calendar = new ICAL.Component(ICAL.parse(closeCalendar(text)));
  if (calendar.name !== "vcalendar") throw new Error("This is not an iCalendar invitation.");
  const method = String(calendar.getFirstPropertyValue("method") || "PUBLISH").toUpperCase();
  // Skip stub events that carry nothing but an identifier.
  const events = calendar.getAllSubcomponents("vevent").filter((component) => component.hasProperty("dtstart") || component.hasProperty("summary"));
  return events.slice(0, 50).map((component) => {
    const event = new ICAL.Event(component);
    const organizer = component.getFirstProperty("organizer");
    const email = String(organizer?.getFirstValue() || "").replace(/^mailto:/i, "").toLowerCase();
    const name = String(organizer?.getParameter("cn") || email);
    const attendees = component.getAllProperties("attendee");
    const attendee = attendees.find((property) => me.has(String(property.getFirstValue()).replace(/^mailto:/i, "").toLowerCase()));
    const start = dateValue(event.startDate, String(component.getFirstProperty("dtstart")?.getParameter("tzid") || ""));
    const end = start ? dateValue(event.endDate, String(component.getFirstProperty("dtend")?.getParameter("tzid") || start.timezone)) : null;
    const uid = String(event.uid || "");
    const status = String(component.getFirstPropertyValue("status") || "").toUpperCase();
    const location = String(event.location || ""), description = String(event.description || "");
    const value = (property: string) => String(component.getFirstPropertyValue(property) || "");
    // A REPLY carries one attendee: the person answering.
    const answer = method === "REPLY" ? attendees[0] : undefined;
    const answerEmail = String(answer?.getFirstValue() || "").replace(/^mailto:/i, "").toLowerCase();
    const stamp = component.getFirstPropertyValue("dtstamp") as ICAL.Time | null;
    return {
      uid, method, status, title: String(event.summary || "Calendar invitation"),
      sequence: Number(component.getFirstPropertyValue("sequence") || 0), start, end,
      organizer: { name, email }, location, description,
      recurring: component.hasProperty("rrule") || component.hasProperty("rdate"), recurrenceId: String(component.getFirstPropertyValue("recurrence-id") || ""),
      response: String(attendee?.getParameter("partstat") || "NEEDS-ACTION").toUpperCase(),
      canRespond: method === "REQUEST" && status !== "CANCELLED" && !!uid && !!email && !me.has(emailOf(email)),
      ...occurrence(event, component, now),
      stamp: stamp?.toJSDate ? stamp.toJSDate().getTime() : 0,
      join: findJoinLink(value("x-microsoft-skypeteamsmeetingurl"), value("x-google-conference"), location, description, value("url")),
      replier: answer ? { name: String(answer.getParameter("cn") || answerEmail), email: answerEmail, response: String(answer.getParameter("partstat") || "").toUpperCase() } : null,
      comment: value("comment"),
    };
  });
}

export function formatCalendarDate(value: CalendarDate | null): string {
  if (!value) return "Date not specified";
  const options: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", year: "numeric" };
  if (!value.allDay) Object.assign(options, { hour: "numeric", minute: "2-digit" });
  if (value.instant) return new Date(value.instant).toLocaleString(undefined, { ...options, timeZoneName: "short" });
  const wallTime = new Date(Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second));
  const formatted = wallTime.toLocaleString(undefined, { ...options, timeZone: "UTC" });
  return `${formatted}${value.allDay ? " · All day" : ` (${value.timezone || "local time"})`}`;
}

export function invitationLabel(invitation: Invitation): string {
  if (invitation.method === "CANCEL" || invitation.status === "CANCELLED") return "Canceled event";
  if (invitation.method === "REPLY") return "Invitation response";
  if (invitation.method !== "REQUEST") return "Calendar event";
  // Not "updated" from SEQUENCE: Outlook raises it on edits made before the first invite is sent.
  return "Calendar invitation";
}

export function formatInvitationWhen(invitation: Invitation): string {
  const start = invitation.start;
  const end = invitation.end;
  if (!start?.allDay || !end?.allDay) return formatCalendarDate(start);
  const first = Date.UTC(start.year, start.month - 1, start.day);
  const last = new Date(Date.UTC(end.year, end.month - 1, end.day) - 86400000);
  if (+last <= first) return formatCalendarDate(start);
  const finalDay = { ...end, year: last.getUTCFullYear(), month: last.getUTCMonth() + 1, day: last.getUTCDate() };
  return `${formatCalendarDate(start).replace(" · All day", "")} – ${formatCalendarDate(finalDay)}`;
}
