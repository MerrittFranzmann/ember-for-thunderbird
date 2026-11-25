// Undo send and send later: an email the user sent waits in Ember's outbox (outbox-store.ts) until its time,
// then the background sends it (outbox-service.ts). Undo, Edit or Send now take it back before then.
// The pure parts, unit-tested (test/outbox.test.ts). (No imports from page modules: the background bundles this file.)

export type QueuedMode = "new" | "reply" | "replyAll" | "forward" | "draft";

export interface QueuedEmail {
  id: string;
  /** When it goes out. */
  sendAt: number;
  queuedAt: number;
  /** "undo": waiting out Settings → Undo send; "later": the user picked a time. */
  kind: "undo" | "later";
  /** "sending" while the background sends it (Undo is too late then); "failed" keeps it for Try again / Edit. */
  state: "waiting" | "sending" | "failed";
  error?: string;
  subject: string;
  /** Recipients as "Name <email>", for the list and the follow-up reminder. */
  to: string[];
  mode: QueuedMode;
  /** A draft that is a reply: sent through Thunderbird's composer to keep its threading. */
  threaded?: boolean;
  /** The email answered or forwarded (or the draft being sent): Thunderbird's id when queued, and its
   *  Message-ID to find it again (ids change when an email moves, and with every Thunderbird start). */
  related?: { id?: number; mid?: string };
  /** Thunderbird's compose details (attachments as files). */
  details: any;
  /** Remind me if no reply in this many days (0: none). */
  followUp: number;
  /** What Undo / Edit puts back in the composer. */
  draft: any;
}

/** Settings → Undo send: seconds an email waits before it goes (0: sends right away). */
export const UNDO_SEND_CHOICES: [number, string][] = [[0, "Off"], [10, "10 seconds"], [30, "30 seconds"], [60, "1 minute"], [120, "2 minutes"]];

export function queueId(now = Date.now()): string {
  return `q-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const at = (base: Date, days: number, hour: number, minute = 0) => {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d;
};
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const clock = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** "Today, 6:00 PM", "Tomorrow, 8:00 AM", "Mon 3 Nov, 8:00 AM". */
export function sendTimeText(time: number, now = Date.now()): string {
  const d = new Date(time), today = new Date(now);
  if (sameDay(d, today)) return `Today, ${clock(d)}`;
  if (sameDay(d, at(today, 1, 0))) return `Tomorrow, ${clock(d)}`;
  return `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}, ${clock(d)}`;
}

/** "1:43" (minutes:seconds) until an email goes. */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export interface SendLaterChoice { label: string; at: number }

/** The composer's Send later menu: a few times that make sense from now. */
export function sendLaterChoices(nowMs = Date.now()): SendLaterChoice[] {
  const now = new Date(nowMs);
  const choices: { label: string; at: Date }[] = [];
  // Three hours on, at the next quarter hour, while that's still the working day.
  const later = new Date(nowMs + 3 * 3600000);
  later.setMinutes(Math.ceil(later.getMinutes() / 15) * 15, 0, 0);
  if (sameDay(later, now) && later.getHours() < 17) choices.push({ label: "Later today", at: later });
  if (now.getHours() < 17) choices.push({ label: "This evening", at: at(now, 0, 18) });
  choices.push({ label: "Tomorrow morning", at: at(now, 1, 8) });
  choices.push({ label: "Tomorrow afternoon", at: at(now, 1, 13) });
  // Monday 8 AM (next week's), unless that's tomorrow.
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  if (toMonday > 1) choices.push({ label: "Monday morning", at: at(now, toMonday, 8) });
  return choices.map((c) => ({ label: c.label, at: +c.at }));
}

/** What the outbox shows for an email: when it goes, or why it didn't. */
export function queuedStatus(q: Pick<QueuedEmail, "state" | "kind" | "sendAt" | "error">, now = Date.now()): string {
  if (q.state === "sending") return "Sending…";
  if (q.state === "failed") return `Couldn't send${q.error ? `: ${q.error}` : ""}`;
  if (q.kind === "undo") return `Sending in ${countdown(q.sendAt - now)}`;
  return `Sends ${sendTimeText(q.sendAt, now).replace(/^Today, /, "today at ").replace(/^Tomorrow, /, "tomorrow at ")}`;
}
