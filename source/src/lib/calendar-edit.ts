// The event editor's model (Apple Calendar's inspector): a draft made from a time slot, an existing event, an
// email or quick add, turned into what the sparkCalendar Experiment makes or changes. Pure; unit-tested.
import type { Addr } from "./format";

export type Repeat = "none" | "daily" | "weekdays" | "weekly" | "biweekly" | "monthly" | "yearly";
export type ShowAs = "Busy" | "Free" | "Tentative" | "OOF" | "WorkingElsewhere";

export interface EventDraft {
  /** A new event, or a change to one the user owns. */
  mode: "new" | "edit";
  accountId: string;
  itemId?: string;
  changeKey?: string;
  /** One occurrence of a repeating series (its repeat can't change here). */
  occurrence?: boolean;
  title: string;
  location: string;
  notes: string;
  allDay: boolean;
  /** Local "YYYY-MM-DD" and "HH:MM"; an all-day event's end date is its last day. */
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  repeat: Repeat;
  /** Minutes before; -1 for none. */
  reminder: number;
  showAs: ShowAs;
  invitees: Addr[];
  /** The email it was made from. */
  fromEmail?: { subject: string; link?: string };
  /** The event as it was (edits change only what differs). */
  original?: Omit<EventDraft, "original">;
}

/** What the Experiment's createEvent / updateEvent take. */
export interface EwsEvent {
  subject: string; location: string; body: string; start: string; end: string; allDay: boolean; freeBusy: ShowAs;
  reminder: number; attendees: { name: string; email: string }[]; recurrence: { kind: Exclude<Repeat, "none">; start: string } | null; timeZone: string;
}

export const REMINDERS: [number, string][] = [[-1, "None"], [0, "At time of event"], [5, "5 minutes before"], [10, "10 minutes before"], [15, "15 minutes before"], [30, "30 minutes before"], [60, "1 hour before"], [120, "2 hours before"], [1440, "1 day before"]];
export const SHOW_AS: [ShowAs, string][] = [["Busy", "Busy"], ["Free", "Free"], ["Tentative", "Tentative"], ["OOF", "Away"], ["WorkingElsewhere", "Working elsewhere"]];

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** Local time from "YYYY-MM-DD" and "HH:MM". */
export function localTime(date: string, time = "00:00"): number {
  const [y, m, d] = date.split("-").map(Number), [h, min] = time.split(":").map(Number);
  return new Date(y, m - 1, d, h || 0, min || 0).getTime();
}
const nextDay = (date: string) => { const d = new Date(localTime(date)); d.setDate(d.getDate() + 1); return ymd(d); };
const prevDay = (date: string) => { const d = new Date(localTime(date)); d.setDate(d.getDate() - 1); return ymd(d); };

/** "Every week on Thursday" etc., for the draft's first day. */
export function repeatOptions(startDate: string, locale?: string): [Repeat, string][] {
  const d = new Date(localTime(startDate));
  const weekday = d.toLocaleDateString(locale, { weekday: "long" });
  return [["none", "Never"], ["daily", "Every day"], ["weekdays", "Every weekday"], ["weekly", `Every week on ${weekday}`], ["biweekly", `Every 2 weeks on ${weekday}`],
    ["monthly", `Every month on the ${ordinal(d.getDate())}`], ["yearly", `Every year on ${d.toLocaleDateString(locale, { month: "long", day: "numeric" })}`]];
}
function ordinal(n: number) { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }

function blank(accountId: string, start: number, end: number, allDay: boolean): EventDraft {
  const s = new Date(start), e = new Date(end);
  return {
    mode: "new", accountId, title: "", location: "", notes: "", allDay,
    startDate: ymd(s), startTime: hm(s), endDate: allDay ? prevDay(ymd(e)) || ymd(s) : ymd(e), endTime: hm(e),
    repeat: "none", reminder: allDay ? -1 : 15, showAs: allDay ? "Free" : "Busy", invitees: [],
  };
}
/** A new event at a time (the grid, quick add); all-day events end at the next midnight. */
export function draftForSlot(accountId: string, start: number, end: number, allDay = false): EventDraft {
  const draft = blank(accountId, start, end, allDay);
  if (allDay && draft.endDate < draft.startDate) draft.endDate = draft.startDate;
  return draft;
}

/** The fields of an event the editor needs (from sparkCalendar.eventDetails). */
export interface EventSource {
  accountId: string; id: string; changeKey?: string; type?: string; subject: string; location: string; body?: string; start: string; end: string;
  allDay: boolean; freeBusy: string; reminder?: number | null; attendees?: { name: string; email: string; role?: string }[];
}
/** The draft to change an event the user owns. Its repeat shows as it is; a series' times change per occurrence. */
export function draftFromEvent(event: EventSource, me: ReadonlySet<string>): EventDraft {
  const draft = blank(event.accountId, Date.parse(event.start), Date.parse(event.end), event.allDay);
  Object.assign(draft, {
    mode: "edit", itemId: event.id, changeKey: event.changeKey || "", occurrence: event.type === "Occurrence" || event.type === "Exception",
    title: event.subject || "", location: event.location || "", notes: (event.body || "").replace(/\r\n?/g, "\n").trim(),
    reminder: typeof event.reminder === "number" ? event.reminder : -1,
    showAs: (SHOW_AS.some(([v]) => v === event.freeBusy) ? event.freeBusy : "Busy") as ShowAs,
    invitees: (event.attendees || []).filter((a) => a.role !== "organizer" && !me.has(a.email.toLowerCase())).map((a) => ({ name: a.name || "", email: a.email })),
  });
  const { original: _, ...copy } = draft;
  draft.original = structuredClone(copy);
  return draft;
}

/** A new event from an email: its subject, the people on it but the user, the first time it mentions. */
export function draftFromEmail(accountId: string, email: { subject: string; people: Addr[]; link?: string }, when: { start: number; end: number; allDay: boolean } | null, now: number, me: ReadonlySet<string>): EventDraft {
  const next = new Date(now); next.setMinutes(0, 0, 0); next.setHours(next.getHours() + 1);
  const slot = when || { start: next.getTime(), end: next.getTime() + 3600000, allDay: false };
  const draft = draftForSlot(accountId, slot.start, slot.end, slot.allDay);
  draft.title = (email.subject || "").replace(/^(?:\s*(?:re|fwd?|fw|aw|sv)\s*:\s*)+/i, "").trim();
  const seen = new Set<string>();
  draft.invitees = email.people.filter((p) => { const key = p.email.toLowerCase(); if (!key || me.has(key) || seen.has(key)) return false; seen.add(key); return true; });
  draft.fromEmail = { subject: email.subject, link: email.link };
  return draft;
}

/** Why the draft can't be saved yet ("" when it can). */
export function draftProblem(draft: EventDraft): string {
  if (!draft.accountId) return "Choose a calendar.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(draft.endDate)) return "Choose the days.";
  const { start, end } = instants(draft);
  if (!(end > start) && !(draft.allDay && end >= start)) return "The event ends before it starts.";
  const bad = draft.invitees.find((p) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.email));
  if (bad) return `${bad.email || bad.name} isn't an email address.`;
  return "";
}

function instants(draft: Pick<EventDraft, "allDay" | "startDate" | "startTime" | "endDate" | "endTime">): { start: number; end: number } {
  if (draft.allDay) return { start: localTime(draft.startDate), end: localTime(nextDay(draft.endDate)) };
  return { start: localTime(draft.startDate, draft.startTime), end: localTime(draft.endDate, draft.endTime) };
}

/** The notes, with a line pointing to the email it came from. */
function notesOf(draft: Pick<EventDraft, "notes" | "fromEmail" | "mode">): string {
  const from = draft.fromEmail && draft.mode !== "edit" ? `From the email “${draft.fromEmail.subject}”${draft.fromEmail.link ? `: ${draft.fromEmail.link}` : ""}` : "";
  return [draft.notes.trim(), from].filter(Boolean).join("\n\n");
}

/** What createEvent takes. */
export function toEwsEvent(draft: EventDraft, timeZone: string): EwsEvent {
  const { start, end } = instants(draft);
  return {
    subject: draft.title.trim() || "New event", location: draft.location.trim(), body: notesOf(draft),
    start: new Date(start).toISOString(), end: new Date(end).toISOString(), allDay: draft.allDay, freeBusy: draft.showAs, reminder: draft.reminder,
    attendees: draft.invitees.map((p) => ({ name: p.name || "", email: p.email.trim() })),
    recurrence: draft.repeat === "none" ? null : { kind: draft.repeat, start: draft.startDate }, timeZone,
  };
}

/** For an edit: only the fields that changed (times change together), and whether to tell the attendees. */
export function draftChanges(draft: EventDraft, timeZone: string): { changes: Partial<EwsEvent>; send: boolean } {
  const after = toEwsEvent(draft, timeZone);
  if (!draft.original) return { changes: after, send: after.attendees.length > 0 };
  const before = toEwsEvent({ ...draft.original, fromEmail: undefined } as EventDraft, timeZone);
  const changes: Partial<EwsEvent> = {};
  for (const key of ["subject", "location", "body", "freeBusy", "reminder", "allDay"] as const) if (after[key] !== before[key]) (changes as any)[key] = after[key];
  if (after.start !== before.start || after.end !== before.end || after.allDay !== before.allDay) Object.assign(changes, { start: after.start, end: after.end, allDay: after.allDay, timeZone });
  const emails = (list: EwsEvent["attendees"]) => list.map((p) => p.email.toLowerCase()).sort().join(",");
  if (emails(after.attendees) !== emails(before.attendees)) changes.attendees = after.attendees;
  // A series' pattern is changed on the series itself, not from one occurrence.
  if (!draft.occurrence && draft.repeat !== draft.original.repeat) Object.assign(changes, { recurrence: after.recurrence, timeZone });
  const meeting = after.attendees.length > 0 || before.attendees.length > 0;
  const worthTelling = Object.keys(changes).some((k) => k !== "reminder" && k !== "freeBusy" && k !== "timeZone");
  return { changes, send: meeting && worthTelling };
}

/** Windows time zone names Exchange uses, for this Mac's zone ("" when unknown: times are then sent in UTC). */
const WINDOWS_ZONES: Record<string, string> = {
  "America/New_York": "Eastern Standard Time", "America/Detroit": "Eastern Standard Time", "America/Toronto": "Eastern Standard Time",
  "America/Indiana/Indianapolis": "US Eastern Standard Time", "America/Chicago": "Central Standard Time", "America/Winnipeg": "Central Standard Time",
  "America/Denver": "Mountain Standard Time", "America/Edmonton": "Mountain Standard Time", "America/Phoenix": "US Mountain Standard Time",
  "America/Los_Angeles": "Pacific Standard Time", "America/Vancouver": "Pacific Standard Time", "America/Anchorage": "Alaskan Standard Time",
  "Pacific/Honolulu": "Hawaiian Standard Time", "America/Halifax": "Atlantic Standard Time", "America/Puerto_Rico": "SA Western Standard Time",
  "America/Mexico_City": "Central Standard Time (Mexico)", "America/Bogota": "SA Pacific Standard Time", "America/Sao_Paulo": "E. South America Standard Time",
  "Europe/London": "GMT Standard Time", "Europe/Dublin": "GMT Standard Time", "Europe/Lisbon": "GMT Standard Time",
  "Europe/Paris": "Romance Standard Time", "Europe/Brussels": "Romance Standard Time", "Europe/Madrid": "Romance Standard Time",
  "Europe/Berlin": "W. Europe Standard Time", "Europe/Amsterdam": "W. Europe Standard Time", "Europe/Rome": "W. Europe Standard Time", "Europe/Zurich": "W. Europe Standard Time",
  "Europe/Athens": "GTB Standard Time", "Europe/Kiev": "FLE Standard Time", "Europe/Kyiv": "FLE Standard Time", "Africa/Johannesburg": "South Africa Standard Time",
  "Africa/Nairobi": "E. Africa Standard Time", "Africa/Lagos": "W. Central Africa Standard Time", "Asia/Dubai": "Arabian Standard Time",
  "Asia/Kolkata": "India Standard Time", "Asia/Singapore": "Singapore Standard Time", "Asia/Manila": "Singapore Standard Time", "Asia/Tokyo": "Tokyo Standard Time",
  "Asia/Seoul": "Korea Standard Time", "Asia/Shanghai": "China Standard Time", "Australia/Sydney": "AUS Eastern Standard Time", "Pacific/Auckland": "New Zealand Standard Time",
  UTC: "UTC", "Etc/UTC": "UTC",
};
export function windowsZone(iana = Intl.DateTimeFormat().resolvedOptions().timeZone): string { return WINDOWS_ZONES[iana] || ""; }
