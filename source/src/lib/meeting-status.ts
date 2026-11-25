// Decisions the invitation card and the agenda make from Exchange's calendar (sparkCalendar
// Experiment) and the invitation itself. Pure; unit-tested.
import type { Invitation, Occurrence } from "./invitations";

export type Answer = "ACCEPTED" | "TENTATIVE" | "DECLINED";
/** sparkCalendar.meetingStatus(): what the user's Exchange mailbox knows about a meeting message. */
export interface MeetingStatus { response: string; outOfDate: boolean; onCalendar: boolean; cancelled: boolean; itemClass?: string }
/** One event from sparkCalendar.calendarView(). */
export interface CalendarEvent {
  accountId: string; id: string; uid: string; subject: string; start: string; end: string;
  allDay: boolean; location: string; freeBusy: string; response: string; cancelled: boolean; body?: string;
  /** Outlook's reminder: minutes before, -1 for none, null when Exchange didn't say. */
  reminder?: number | null;
  /** Organizer and attendees (with details): SMTP addresses only. */
  attendees?: { name: string; email: string; role?: string }[];
  /** On another calendar (a shared or extra one; its key), read-only on the page; `busyOnly`: only when they're busy. */
  calendarId?: string;
  shared?: boolean;
  busyOnly?: boolean;
  /** On a calendar Thunderbird can read but not change (a subscription, Google's holidays or birthdays). */
  readOnly?: boolean;
}

const FROM_EXCHANGE: Record<string, Answer | "ORGANIZER"> = { accept: "ACCEPTED", tentative: "TENTATIVE", decline: "DECLINED", organizer: "ORGANIZER" };
/** The user's current answer: one given in this session, else Exchange's, else one Ember saved, else the invitation's own. */
export function currentAnswer(sources: { session?: Answer; server?: MeetingStatus | null; saved?: Answer; invitation?: string }): Answer | "ORGANIZER" | "" {
  if (sources.session) return sources.session;
  const server = sources.server && FROM_EXCHANGE[sources.server.response];
  if (server) return server;
  if (sources.saved) return sources.saved;
  const own = sources.invitation || "";
  return own === "ACCEPTED" || own === "TENTATIVE" || own === "DECLINED" ? own : "";
}
/** Whether the calendar entry Exchange re-read after answering shows that answer ("unknown": it couldn't be read). */
export function exchangeConfirmed(expected: string, verified: string | undefined): boolean {
  // Declining removes the meeting from the calendar, so no entry is the expected outcome there.
  return !verified || verified === "unknown" || verified === expected || (expected === "decline" && verified === "missing");
}
const SHOWN: Record<string, string> = { none: "no answer", missing: "no entry for this meeting", accept: "Accepted", tentative: "Maybe", decline: "Declined", organizer: "you as the organizer" };
/** What the calendar shows instead, for an error message. */
export function shownOnCalendar(verified: string): string { return SHOWN[verified] || verified; }
export const ANSWER_TEXT: Record<Answer | "ORGANIZER", string> = { ACCEPTED: "You accepted", TENTATIVE: "You said maybe", DECLINED: "You declined", ORGANIZER: "You're the organizer" };

const ms = (iso: string) => Date.parse(iso);
/** Events on the user's calendar that overlap the invitation's occurrence and would keep them busy. */
export function conflicts(events: CalendarEvent[], invitation: Pick<Invitation, "uid" | "title">, when: Occurrence): CalendarEvent[] {
  return events.filter((event) => {
    if (event.cancelled || event.response === "decline" || event.freeBusy === "Free" || event.freeBusy === "WorkingElsewhere") return false;
    // Exchange puts a tentative copy of the new invitation on the calendar; that's not a conflict.
    if (event.uid ? event.uid === invitation.uid : event.subject === invitation.title && ms(event.start) === when.start) return false;
    return ms(event.end) > when.start && ms(event.start) < when.end;
  }).sort((a, b) => ms(a.start) - ms(b.start));
}

/** "1:30 – 2:00 PM", or "All day". */
export function timeRange(start: number, end: number, allDay = false): string {
  if (allDay) return "All day";
  const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const from = time(start), to = time(end);
  // Drop a repeated AM/PM: "1:30 – 2:00 PM".
  const suffix = /\s*([AP]M)$/i.exec(from);
  return suffix && to.endsWith(suffix[1]) ? `${from.slice(0, -suffix[0].length)} – ${to}` : `${from} – ${to}`;
}

/** Join is the main action from ten minutes before a meeting until it ends. */
export function joinSoon(when: Occurrence | null, now: number): boolean {
  return !!when && now >= when.start - 10 * 60000 && now < when.end;
}

/** Today's agenda: what hasn't ended yet, all-day first, cancelled and declined left out. */
export function agendaItems(events: CalendarEvent[], now: number): CalendarEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (event.cancelled || event.response === "decline" || ms(event.end) <= now) return false;
    // The same meeting on two accounts' calendars (invited at both addresses) shows once.
    const key = `${event.uid || event.subject}|${event.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => Number(b.allDay) - Number(a.allDay) || ms(a.start) - ms(b.start));
}

const JOIN_LINKS: [RegExp, string][] = [
  [/^https:\/\/teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\//i, "Teams"],
  [/^https:\/\/(?!(?:docs|support|community|explore|blog|developers)\.)(?:[\w-]+\.)*zoom(?:gov)?\.(?:us|com)\/(?:j|w|my|wc\/join)\//i, "Zoom"],
  [/^https:\/\/meet\.google\.com\/[a-z]{3,}-[a-z]{3,}-[a-z]{3,}/i, "Google Meet"],
  [/^https:\/\/(?:[\w-]+\.)*webex\.com\/(?:meet|join|wbxmjs|[\w.-]+\/j\.php)/i, "Webex"],
  [/^https:\/\/(?:meet\.goto\.com|global\.gotomeeting\.com\/join)\//i, "GoTo"],
];
/** The first video-meeting link in some text (Outlook safe links unwrapped). */
export function findJoinLink(...texts: string[]): { url: string; label: string } | null {
  for (const text of texts) {
    for (const match of (text || "").matchAll(/https:\/\/[^\s<>"'\\]+/gi)) {
      let url = match[0].replace(/[)\].,;:!?]+$/, "");
      if (/^https:\/\/[\w.-]*safelinks\.protection\.outlook\.com\//i.test(url)) {
        try { url = new URL(url).searchParams.get("url") || url; } catch { /* keep the wrapper */ }
      }
      const kind = JOIN_LINKS.find(([pattern]) => pattern.test(url));
      if (kind) return { url, label: kind[1] };
    }
  }
  return null;
}

/** Today's or tomorrow's agenda (option "Today + tomorrow"): `day` 0 or 1, from midnight to midnight. */
export function dayAgenda(events: CalendarEvent[], now: number, day: 0 | 1): CalendarEvent[] {
  const start = new Date(now); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() + day);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  // Tomorrow lists only what starts tomorrow (not today's late or all-day meetings running past midnight).
  return agendaItems(events, now).filter((event) => ms(event.start) < end.getTime() && ms(event.end) > start.getTime() && (day === 0 || ms(event.start) >= start.getTime()));
}

/** The mark beside a meeting: accepted, tentative, needs a reply; nothing for the user's own meetings. */
export function responseMark(event: CalendarEvent): { mark: string; label: string; tone: "yes" | "maybe" | "reply" } | null {
  if (event.response === "accept") return { mark: "✓", label: "Accepted", tone: "yes" };
  if (event.response === "tentative") return { mark: "?", label: "Tentative", tone: "maybe" };
  if (event.response === "none") return { mark: "!", label: "Needs a reply", tone: "reply" };
  return null;
}

/** Meetings still waiting for the user's answer that overlap another busy meeting: [unanswered, other]. */
export function unansweredClashes(events: CalendarEvent[]): [CalendarEvent, CalendarEvent][] {
  const busy = (event: CalendarEvent) => !event.allDay && !event.cancelled && event.response !== "decline" && event.freeBusy !== "Free" && event.freeBusy !== "WorkingElsewhere";
  const clashes: [CalendarEvent, CalendarEvent][] = [];
  for (const event of events) {
    if (event.response !== "none" || !busy(event)) continue;
    const other = events.find((o) => o !== event && busy(o) && (o.uid ? o.uid !== event.uid : o.id !== event.id) && ms(o.start) < ms(event.end) && ms(o.end) > ms(event.start));
    if (other) clashes.push([event, other]);
  }
  return clashes;
}

export interface CalendarError { accountId: string; name?: string; message: string }

/** This read's events, keeping the last known ones of accounts that couldn't be read this time. */
export function mergeAgenda(previous: CalendarEvent[], fresh: CalendarEvent[], errors: CalendarError[]): CalendarEvent[] {
  const failed = new Set(errors.map((e) => e.accountId));
  return [...fresh, ...previous.filter((event) => failed.has(event.accountId))];
}

/** One line for the log and the agenda's tooltip: which calendar, and what Exchange said. */
export function calendarErrorText(errors: CalendarError[]): string {
  return errors.map((e) => `${e.name || e.accountId}: ${e.message}`).join(" · ");
}
