// Follow-up reminders ("Remind me if no reply in 3 days"): the pure parts, unit-tested
// (test/follow-ups.test.ts). The background's FollowUpService does the checking and notifying.
// (No imports from page modules: the background bundles this file.)

export interface FollowUp {
  /** Message-ID of the sent email, without angle brackets. */
  mid: string;
  subject: string;
  /** Recipients as "Name <email>" (for the reminder text and to find replies). */
  to: string[];
  sentAt: number;
  dueAt: number;
  /** "waiting" for a reply; "due" once the time passed without one (shown under No reply yet). */
  state: "waiting" | "due";
}

export const FOLLOW_UP_DAYS = [1, 2, 3, 7] as const;
const DAY = 86400000;

export function followUpFor(mid: string, subject: string, to: string[], sentAt: number, days: number): FollowUp {
  return { mid: mid.replace(/^<|>$/g, ""), subject, to, sentAt, dueAt: sentAt + days * DAY, state: "waiting" };
}

/** "Re: Fwd: Budget" → "budget": replies keep the subject after their prefixes. */
export function baseSubject(subject: string): string {
  return subject.replace(/^(\s*(re|fwd?|aw|wg|sv|antw)(\[\d+\])?\s*:\s*)+/i, "").trim().toLowerCase();
}

function addressOf(value: string): string {
  const match = /<([^>]+)>/.exec(value);
  return (match ? match[1] : value).trim().toLowerCase();
}

/** Worth reading the headers of: someone else's email after ours, from a recipient or with our subject. */
export function mightReply(f: FollowUp, m: { author?: string; subject?: string; date?: string | number | Date }, me: Set<string>): boolean {
  const from = addressOf(m.author || "");
  if (!from || me.has(from)) return false;
  if (m.date !== undefined && +new Date(m.date) < f.sentAt - 60000) return false;
  const recipients = new Set(f.to.map(addressOf));
  const base = baseSubject(f.subject);
  return recipients.has(from) || (!!base && baseSubject(m.subject || "") === base);
}

/** A reply refers to our Message-ID in In-Reply-To or References. */
export function repliesTo(headers: Record<string, string[] | undefined>, mid: string): boolean {
  const lower: Record<string, string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers || {})) lower[key.toLowerCase()] = value;
  const raw = [...(lower["references"] || []), ...(lower["in-reply-to"] || [])].join(" ");
  return (raw.match(/<[^<>\s]+>/g) || []).some((ref) => ref.slice(1, -1) === mid.replace(/^<|>$/g, ""));
}

/** "Sent to Ana 3 days ago" for the reminder. */
export function followUpMessage(f: FollowUp, now: number): string {
  const names = f.to.map((t) => t.replace(/\s*<[^>]+>\s*$/, "").replace(/^"|"$/g, "") || addressOf(t));
  const who = names.length > 2 ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more` : names.join(" and ");
  const days = Math.max(1, Math.round((now - f.sentAt) / DAY));
  return `No reply yet from ${who || "the recipients"} · sent ${days === 1 ? "a day" : `${days} days`} ago`;
}
