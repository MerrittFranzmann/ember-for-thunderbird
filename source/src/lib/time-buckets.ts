import type { Conversation } from "./types";
export interface TimeBucket { id: string; label: string; conversations: Conversation[]; }

/** Period boundaries computed once per `now`; the returned function only compares numbers. */
function bucketer(now: Date): (value: number) => { id: string; label: string } {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const week = new Date(+day); week.setDate(day.getDate() - (day.getDay() + 6) % 7);
  const month = +new Date(now.getFullYear(), now.getMonth(), 1);
  const year = +new Date(now.getFullYear(), 0, 1);
  const tomorrow = new Date(+day); tomorrow.setDate(day.getDate() + 1);
  // A sender's clock or time zone a few hours ahead isn't "Upcoming": that's today's mail.
  const upcoming = Math.max(+tomorrow, +now + 6 * 3600000);
  const years = new Map<number, { id: string; label: string }>();
  return (value) => {
    if (!Number.isFinite(value)) return { id: "unknown", label: "Undated" };
    if (value >= upcoming) return { id: "future", label: "Upcoming" };
    if (value >= +day) return { id: "day", label: "Today" };
    if (value >= +week) return { id: "week", label: "This week" };
    if (value >= month) return { id: "month", label: "This month" };
    if (value >= year) return { id: "year", label: "This year" };
    const y = new Date(value).getFullYear();
    let period = years.get(y);
    if (!period) years.set(y, period = { id: `year:${y}`, label: String(y) });
    return period;
  };
}

/** Exclusive calendar periods in the user's local timezone; weeks start Monday. */
export function timeBucket(date: Date | string | number, now = new Date()): { id: string; label: string } {
  return bucketer(now)(+new Date(date));
}

export function groupTimeBuckets(conversations: Conversation[], now = new Date()): TimeBucket[] {
  const groups = new Map<string, TimeBucket>();
  const bucket = bucketer(now);
  // Dates parsed once per conversation, not once per comparison (16k+ conversations at scale).
  const sorted = conversations.map((conversation) => ({ conversation, time: +new Date(conversation.latest.date) }))
    .sort((a, b) => b.time - a.time || a.conversation.key.localeCompare(b.conversation.key));
  for (const { conversation, time } of sorted) {
    const period = bucket(time);
    let group = groups.get(period.id);
    if (!group) groups.set(period.id, group = { ...period, conversations: [] });
    group.conversations.push(conversation);
  }
  return Array.from(groups.values());
}
