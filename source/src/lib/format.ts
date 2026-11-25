// Pure formatting helpers: addresses, names, dates, avatars, sizes.

export interface Addr {
  name: string;
  email: string;
}

/** Parse a single mailbox string: `Name <a@b>`, `"Last, First" <a@b>`, or `a@b`. */
export function parseAddr(s: string | undefined | null): Addr {
  if (!s) return { name: "", email: "" };
  const str = String(s).trim();
  const m = str.match(/^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/);
  if (m) {
    const email = m[2].trim();
    let name = (m[1] || "").trim().replace(/^'+|'+$/g, "");
    if (name === email) name = "";
    return { name, email };
  }
  return { name: "", email: str.replace(/^mailto:/i, "") };
}

/** Split a header value containing several mailboxes (comma separated, quote aware). */
export function splitAddrs(s: string | undefined | null): Addr[] {
  if (!s) return [];
  const out: string[] = [];
  let cur = "", q = false, a = false;
  for (const ch of String(s)) {
    if (ch === '"') q = !q;
    if (!q && ch === "<") a = true;
    if (!q && ch === ">") a = false;
    if (ch === "," && !q && !a) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map(parseAddr).filter((x) => x.email);
}

export function emailOf(s: string | undefined | null): string {
  return parseAddr(s).email.toLowerCase();
}

/** Best display name: real name, else a prettified local part. */
export function displayName(s: string | Addr | undefined | null): string {
  const a = typeof s === "object" && s ? s : parseAddr(s as string);
  if (a.name) return a.name;
  const local = (a.email || "").split("@")[0] || "";
  if (!local) return "(unknown)";
  return local
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

export function firstName(s: string | Addr): string {
  const n = displayName(s);
  if (n.includes(",")) return n.split(",")[1].trim().split(" ")[0] || n;
  return n.split(" ")[0];
}

export function initials(s: string | Addr): string {
  const n = displayName(s).replace(/[^\p{L}\p{N} ]/gu, " ").trim();
  const all = n.split(/\s+/).filter(Boolean);
  // Words with letters make initials ("Quiet Sender 0" → QS, not Q0); keep numbers only if that's all there is.
  const words = all.filter((part) => /\p{L}/u.test(part));
  const parts = words.length ? words : all;
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Muted, accessible avatar palette (white text >= 4.5:1 on each).
const AVATAR_COLORS = [
  "#0a66d8", "#7a3fd1", "#c2410c", "#0f7a5c", "#b4235a", "#1d6f8a",
  "#8a5a00", "#4f46e5", "#a21caf", "#047857", "#b91c1c", "#475569",
];

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function avatarColor(key: string): string {
  return AVATAR_COLORS[hash(key.toLowerCase()) % AVATAR_COLORS.length];
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Spark-style list date: time today, "Yesterday", weekday this week, else date. */
const listTime = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const listWeekday = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const listMonthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const listFullDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
export function listDate(d: Date | number | string, now = new Date()): string {
  const date = new Date(d);
  if (isNaN(date.getTime())) return "";
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (days <= 0) return listTime.format(date);
  if (days === 1) return "Yesterday";
  if (days < 7) return listWeekday.format(date);
  if (date.getFullYear() === now.getFullYear())
    return listMonthDay.format(date);
  return listFullDate.format(date);
}

/** Long date for the reader header. */
export function fullDate(d: Date | number | string, now = new Date()): string {
  const date = new Date(d);
  const t = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86400000);
  if (days <= 0) return `Today at ${t}`;
  if (days === 1) return `Yesterday at ${t}`;
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };
  if (date.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return `${date.toLocaleDateString(undefined, opts)} at ${t}`;
}

export function fileSize(n: number): string {
  if (!n && n !== 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const PREFIX = /^\s*((re|fw|fwd|aw|wg|sv|vs|antw|rif|tr|r)(\[\d+\])?\s*:\s*)+/i;

/** Normalize a subject for conversation grouping. */
export function normSubject(s: string | undefined | null): string {
  let t = String(s || "");
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(PREFIX, "").replace(/^\s*\[[^\]]{1,40}\]\s*/, "");
    if (t === before) break;
  }
  return t.replace(/\s+/g, " ").trim().toLowerCase();
}

export function isReplySubject(s: string | undefined | null): boolean {
  return PREFIX.test(String(s || ""));
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
