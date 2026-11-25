// "Before your meeting": recent email with the people in a meeting, gathered into one list ten minutes
// before it starts (a notification from the background, a strip above the inbox, and each meeting in
// Today). The list is a saved-mail search filtered to those people. Pure; unit-tested.
import { findJoinLink, type CalendarEvent } from "./meeting-status";
import { emailOf } from "./format";
import type { MessageHeader, View } from "./types";

export interface MeetingBrief {
  key: string;
  subject: string;
  start: number;
  end: number;
  /** Everyone in the meeting but the user: organizer first. */
  people: { name: string; email: string }[];
  join: { url: string; label: string } | null;
}

/** How far back "recent" goes, and when the brief is offered. */
export const BRIEF_DAYS = 30;
export const BRIEF_LEAD = 10 * 60000;
const DAY = 86400000;

export function briefFor(event: CalendarEvent, me: Set<string>): MeetingBrief | null {
  if (event.allDay || event.cancelled || event.response === "decline") return null;
  const people = (event.attendees || []).filter((person) => person.email && !me.has(person.email.toLowerCase())).map(({ name, email }) => ({ name: name || email, email: email.toLowerCase() }));
  if (!people.length) return null;
  return { key: `${event.uid || event.id}|${event.start}`, subject: event.subject || "Meeting", start: Date.parse(event.start), end: Date.parse(event.end), people, join: findJoinLink(event.location, event.body || "") };
}

/** Local calendar date, as search filters take it. */
const ymd = (at: number) => { const d = new Date(at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** The list view: saved mail from or to any of the meeting's people in the last 30 days. */
export function briefView(brief: MeetingBrief, now: number): View {
  return { kind: "search", query: "", scope: "local", filters: { people: brief.people.map((p) => p.email), after: ymd(now - BRIEF_DAYS * DAY) }, meeting: brief };
}

/** Whether an email involves any of these people (sender, To or Cc). */
export function involves(message: MessageHeader, people: Set<string>): boolean {
  if (people.has(emailOf(message.author))) return true;
  for (const raw of message.recipients || []) if (people.has(emailOf(raw))) return true;
  for (const raw of message.ccList || []) if (people.has(emailOf(raw))) return true;
  return false;
}

/** The brief's emails among saved headers, newest first (junk and trash left out). */
export function briefMail(headers: MessageHeader[], brief: MeetingBrief, now: number): MessageHeader[] {
  const people = new Set(brief.people.map((p) => p.email));
  const since = new Date(`${ymd(now - BRIEF_DAYS * DAY)}T00:00:00`).getTime();
  return headers.filter((m) => +new Date(m.date) >= since && !m.junk && !m.folder?.specialUse?.some((use) => use === "junk" || use === "trash") && involves(m, people))
    .sort((a, b) => +new Date(b.date) - +new Date(a.date));
}

/** "5 recent emails with Ada Lovelace and Grace Hopper": the people the emails are with, most first. */
export function briefSummary(brief: MeetingBrief, mail: MessageHeader[]): string {
  const counts = new Map<string, number>();
  for (const m of mail) for (const raw of [m.author, ...(m.recipients || []), ...(m.ccList || [])]) {
    const email = emailOf(raw);
    if (brief.people.some((p) => p.email === email)) counts.set(email, (counts.get(email) || 0) + 1);
  }
  const names = [...counts].sort((a, b) => b[1] - a[1]).map(([email]) => brief.people.find((p) => p.email === email)!.name);
  const who = names.length <= 2 ? names.join(" and ") : `${names[0]}, ${names[1]} and ${names.length - 2} more`;
  return `${mail.length} recent email${mail.length === 1 ? "" : "s"}${who ? ` with ${who}` : ""}`;
}

/** "In 10 min", "Now", "Started 3 min ago". */
export function startsIn(start: number, now: number): string {
  const minutes = Math.round((start - now) / 60000);
  if (minutes > 0) return minutes >= 60 ? `In ${Math.floor(minutes / 60)} h ${minutes % 60 ? `${minutes % 60} min` : ""}`.trim() : `In ${minutes} min`;
  return minutes === 0 ? "Now" : `Started ${-minutes} min ago`;
}

/** Meetings in the next day that get a brief, and when (ten minutes before; now if that has passed). */
export function planBriefs(events: CalendarEvent[], now: number, me: Set<string>): (MeetingBrief & { at: number })[] {
  const seen = new Set<string>();
  const plan: (MeetingBrief & { at: number })[] = [];
  for (const event of events) {
    const brief = briefFor(event, me);
    if (!brief || !(brief.start > now) || brief.start > now + DAY || seen.has(brief.key)) continue;
    seen.add(brief.key);
    plan.push({ ...brief, at: Math.max(now, brief.start - BRIEF_LEAD) });
  }
  return plan.sort((a, b) => a.start - b.start);
}

/** Whether the brief belongs above the inbox now: from ten minutes before until five minutes in. */
export function briefDue(brief: Pick<MeetingBrief, "start">, now: number): boolean {
  return now >= brief.start - BRIEF_LEAD && now < brief.start + 5 * 60000;
}
