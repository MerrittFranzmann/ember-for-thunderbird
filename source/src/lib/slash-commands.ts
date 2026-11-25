// Slash commands in the composer (as in Notion): "/" at the start of a line or after a space opens a
// menu at the cursor; typing filters it. The pure parts (the list, matching, free-time text) are
// unit-tested (test/slash-commands.test.ts); Composer.svelte runs the chosen command on the editor.

export type SlashGroup = "Format" | "Insert" | "Email";
export interface SlashCommand {
  id: string;
  label: string;
  hint: string;
  group: SlashGroup;
  /** Other words it's found by ("h1" finds Heading). */
  keywords: string[];
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { id: "heading", label: "Heading", hint: "Large section title", group: "Format", keywords: ["h1", "h2", "title"] },
  { id: "subheading", label: "Subheading", hint: "Smaller title", group: "Format", keywords: ["h3", "section"] },
  { id: "bullets", label: "Bulleted list", hint: "• Simple list", group: "Format", keywords: ["ul", "list", "-"] },
  { id: "numbers", label: "Numbered list", hint: "1. Ordered list", group: "Format", keywords: ["ol", "list", "1."] },
  { id: "todo", label: "To-do list", hint: "☐ Items to tick off", group: "Format", keywords: ["checkbox", "check", "task"] },
  { id: "quote", label: "Quote", hint: "Indented quotation", group: "Format", keywords: ["blockquote", "cite"] },
  { id: "divider", label: "Divider", hint: "A line between sections", group: "Format", keywords: ["hr", "line", "separator", "---"] },
  { id: "code", label: "Code", hint: "Monospaced block", group: "Format", keywords: ["pre", "monospace"] },
  { id: "callout", label: "Callout", hint: "Highlighted note", group: "Format", keywords: ["note", "box", "highlight", "info"] },
  { id: "table", label: "Table", hint: "2 × 3 grid", group: "Format", keywords: ["grid", "columns", "rows"] },
  { id: "link", label: "Link", hint: "Add a web link", group: "Insert", keywords: ["url", "href"] },
  { id: "attach", label: "Attach file", hint: "Add files", group: "Insert", keywords: ["file", "attachment", "upload", "paperclip"] },
  { id: "date", label: "Today's date", hint: "", group: "Insert", keywords: ["today", "day"] },
  { id: "time", label: "Current time", hint: "", group: "Insert", keywords: ["now", "clock"] },
  { id: "availability", label: "My free times", hint: "Open slots from your calendar", group: "Insert", keywords: ["availability", "schedule", "meeting", "slots", "calendar", "free"] },
  { id: "cc", label: "Add Cc / Bcc", hint: "Show the Cc and Bcc fields", group: "Email", keywords: ["bcc", "copy"] },
  { id: "remind", label: "Remind me if no reply", hint: "In 3 days", group: "Email", keywords: ["follow", "followup", "reminder", "nudge"] },
  { id: "signature", label: "Signature", hint: "Choose or edit", group: "Email", keywords: ["sig", "sign"] },
  { id: "draft", label: "Save draft", hint: "⌘S", group: "Email", keywords: ["save"] },
];

/** Commands matching what was typed after "/": label words first, then keywords, then anywhere. */
export function matchCommands(query: string, commands: SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  const scored: { c: SlashCommand; score: number }[] = [];
  for (const c of commands) {
    const label = c.label.toLowerCase();
    const words = label.split(/[\s/]+/);
    let score = 0;
    if (label.startsWith(q)) score = 4;
    else if (words.some((w) => w.startsWith(q))) score = 3;
    else if (c.keywords.some((k) => k.startsWith(q))) score = 2;
    else if (label.includes(q) || c.keywords.some((k) => k.includes(q))) score = 1;
    if (score) scored.push({ c, score });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.c);
}

/** True when "/" was typed where a command makes sense: at the start of a line or after a space. */
export function opensMenu(before: string): boolean {
  return before === "" || /[\s ]$/.test(before);
}

export interface Busy { start: number; end: number }

/**
 * Free 30-minute-or-longer slots on the next working days, within working hours, around busy times.
 * Returns plain lines such as "Thu, Oct 30: 9:00–11:30 AM, 2:00–5:00 PM".
 */
export function freeTimes(busy: Busy[], now: number, { days = 3, startHour = 9, endHour = 17, minMinutes = 30, locale = undefined as string | undefined } = {}): string[] {
  const lines: string[] = [];
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const sorted = busy.slice().sort((a, b) => a.start - b.start);
  const time = (t: number) => new Date(t).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  for (let i = 0; lines.length < days && i < 14; i++) {
    const d = new Date(day.getTime());
    d.setDate(d.getDate() + i);
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const open = new Date(d); open.setHours(startHour, 0, 0, 0);
    const close = new Date(d); close.setHours(endHour, 0, 0, 0);
    let cursor = Math.max(open.getTime(), i === 0 ? Math.ceil(now / 1800000) * 1800000 : open.getTime());
    const slots: string[] = [];
    for (const b of sorted) {
      if (b.end <= cursor || b.start >= close.getTime()) continue;
      if (b.start - cursor >= minMinutes * 60000) slots.push(`${time(cursor)}–${time(b.start)}`);
      cursor = Math.max(cursor, b.end);
    }
    if (close.getTime() - cursor >= minMinutes * 60000) slots.push(`${time(cursor)}–${time(close.getTime())}`);
    if (!slots.length) continue;
    lines.push(`${d.toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" })}: ${slots.join(", ")}`);
  }
  return lines;
}
