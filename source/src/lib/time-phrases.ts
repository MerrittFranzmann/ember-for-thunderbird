// Times written in words, for "Create event" from an email and the calendar's quick add: "Thursday from 1 to 3",
// "Friday morning", "Nov 19 at 2:30pm", "tomorrow at noon", "12/3 10-11am". English only. Pure; unit-tested.

export interface FoundTime {
  /** The words as written, and where they start in the text. */
  text: string;
  index: number;
  start: number;
  end: number;
  allDay: boolean;
  /** Whether a time of day was written (else the day only). */
  timed: boolean;
}

const DAY = 86400000;
const WEEKDAY: Record<string, number> = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTH: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const PARTS: Record<string, [number, number]> = { morning: [9, 12], afternoon: [13, 17], evening: [17, 19], lunch: [12, 13], lunchtime: [12, 13], noon: [12, 13], tonight: [19, 21] };

const WD = "(?:sun|mon|tues?|wed(?:nes)?|weds|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?";
const MO = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const ORD = "(?:st|nd|rd|th)?";
const DATE = new RegExp(
  `\\b(?:(?<rel>today|tomorrow|tonight)` +
  `|(?:(?<next>next|this)\\s+)?(?<wd>${WD})\\b\\.?(?:,?\\s+(?:(?<wdmo>${MO})\\.?\\s+(?<wdday>\\d{1,2})${ORD}|(?<wdnum>\\d{1,2})\\/(?<wdnumday>\\d{1,2})))?` +
  `|(?<mo>${MO})\\.?\\s+(?<day>\\d{1,2})${ORD}(?:,?\\s+(?<year>\\d{4}))?` +
  `|(?<day2>\\d{1,2})${ORD}\\s+(?:of\\s+)?(?<mo2>${MO})` +
  `|(?<nm>\\d{1,2})\\/(?<nd>\\d{1,2})(?:\\/(?<ny>\\d{2,4}))?)\\b`, "gi");
const T = "(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)?";
const RANGE = new RegExp(`^(?:from|between)?\\s*${T}\\s*(?:-|–|—|to|and|until|till)\\s*${T}(?![\\d:])`, "i");
const SINGLE = new RegExp(`^(?:at|@|around|by)?\\s*(?:${T}(?![\\d:/])|(noon|midday))`, "i");
const PART = /^(?:in\s+the\s+|at\s+|for\s+)?(morning|afternoon|evening|lunch(?:time)?|noon|tonight)\b/i;
// A time written on its own (before a date, or with no date): "3pm", "2-3pm" (only the end has am/pm), "9:30-10am", "noon".
const MER = "(?:a\\.?m\\.?|p\\.?m\\.?)";
const LONE_TIME = `\\d{1,2}(?::\\d{2})?\\s*${MER}?\\s*(?:-|–|to)\\s*\\d{1,2}(?::\\d{2})?\\s*${MER}|\\d{1,2}(?::\\d{2})?\\s*${MER}`;
// "Dec 10-12", "Dec 10 to Dec 12": the last day of a run of days (not "Dec 10 2-3pm").
const DAY_RUN = new RegExp(`^\\s*(?:-|–|—|to|through|thru|until)\\s*(?:(${MO})\\.?\\s+)?(\\d{1,2})${ORD}\\b(?!\\s*(?::|-|–|${MER}))`, "i");
// "for 30 minutes", "for an hour", "for 1.5 hours", "for half an hour".
const LASTING = /\s+for\s+(half\s+an?|an?|one|\d+(?:\.\d+)?)\s*(minutes?|mins?|hours?|hrs?|h)\b/i;

const meridiem = (m: string | undefined) => (m ? (m[0].toLowerCase() === "p" ? "pm" : "am") : "");
/** 24-hour clock from "1", "pm": hours 1–7 without am/pm are afternoons (meetings), 8–11 mornings. */
function hour24(h: number, mer: string, guess = true): number {
  if (mer === "pm") return h % 12 + 12;
  if (mer === "am") return h % 12;
  if (h > 12) return h;
  return guess && h >= 1 && h <= 7 ? h + 12 : h;
}
const isTime = (h: number, min: number) => h >= 0 && h <= 24 && min >= 0 && min < 60;

/** The time of day written right after (or just before) a date: [start, end] minutes from midnight. */
function timeAt(text: string): { from: number; to: number; length: number } | null {
  const lead = /^[\s,]*(?:(?:at|from|between|around|@)\s+)?/i.exec(text)![0].length;
  const rest = text.slice(lead);
  const range = RANGE.exec(text.slice(/^[\s,]*/.exec(text)![0].length));
  if (range) {
    const skipped = /^[\s,]*/.exec(text)![0].length;
    const [h1, m1, a1, h2, m2, a2] = [Number(range[1]), Number(range[2] || 0), meridiem(range[3]), Number(range[4]), Number(range[5] || 0), meridiem(range[6])];
    if (isTime(h1, m1) && isTime(h2, m2) && (a1 || a2 || range[2] || range[5] || /from|between|to/i.test(range[0]))) {
      let end = hour24(h2, a2);
      // "11 to 1pm": the start takes the end's am/pm unless that would put it after the end.
      let start = a1 ? hour24(h1, a1) : a2 ? hour24(h1, a2) : hour24(h1, "");
      if (!a1 && start * 60 + m1 > end * 60 + m2) start = a2 === "pm" ? h1 % 12 : start - 12;
      if (!a2 && end * 60 + m2 <= start * 60 + m1) end += 12;
      if (start >= 0 && end * 60 + m2 > start * 60 + m1 && end <= 24) return { from: start * 60 + m1, to: end * 60 + m2, length: skipped + range[0].length };
    }
  }
  const part = PART.exec(rest);
  if (part) { const [a, b] = PARTS[part[1].toLowerCase()]; return { from: a * 60, to: b * 60, length: lead + part[0].length }; }
  const single = SINGLE.exec(text.replace(/^[\s,]*/, ""));
  if (single) {
    const skipped = /^[\s,]*/.exec(text)![0].length;
    if (single[4]) return { from: 12 * 60, to: 13 * 60, length: skipped + single[0].length };
    const h = Number(single[1]), m = Number(single[2] || 0), mer = meridiem(single[3]);
    // A bare number after a date is a time only with "at" or minutes ("Friday at 3", "Friday 3:30"), not "Friday 3 people".
    if (isTime(h, m) && (mer || single[2] || /^(?:at|@|around|by)/i.test(single[0].trim()))) {
      const start = hour24(h, mer) * 60 + m;
      return { from: start, to: start + 60, length: skipped + single[0].length };
    }
  }
  return null;
}

/** The day a date mention means, from the reference time (an email's date, or now). */
function dayOf(groups: Record<string, string | undefined>, ref: Date): Date | null {
  const today = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
  const plus = (n: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);
  const upcoming = (month: number, day: number, year?: number) => {
    if (!(day >= 1 && day <= 31 && month >= 0 && month <= 11)) return null;
    let d = new Date(year ?? today.getFullYear(), month, day);
    if (d.getMonth() !== month) return null;
    if (year === undefined && d.getTime() < today.getTime() - 31 * DAY) d = new Date(today.getFullYear() + 1, month, day);
    return d;
  };
  if (groups.rel) return plus(groups.rel.toLowerCase() === "tomorrow" ? 1 : 0);
  if (groups.wd) {
    if (groups.wdmo) return upcoming(MONTH[groups.wdmo.slice(0, 3).toLowerCase()] ?? MONTH[groups.wdmo.slice(0, 4).toLowerCase()], Number(groups.wdday));
    if (groups.wdnum) return upcoming(Number(groups.wdnum) - 1, Number(groups.wdnumday));
    const key = groups.wd.toLowerCase().replace(/day$/, "").replace(/nes$/, "").replace(/ur$/, "");
    const target = WEEKDAY[key] ?? WEEKDAY[key.slice(0, 3)];
    if (target === undefined) return null;
    let ahead = (target - today.getDay() + 7) % 7;
    if (ahead === 0 && groups.next?.toLowerCase() !== "this") ahead = 7;
    // "next Friday" said early in a week means the following week's.
    if (groups.next?.toLowerCase() === "next" && ahead < 7 && today.getDay() + ahead <= 6) ahead += 7;
    return plus(ahead);
  }
  if (groups.mo) return upcoming(MONTH[groups.mo.slice(0, 3).toLowerCase()], Number(groups.day), groups.year ? Number(groups.year) : undefined);
  if (groups.mo2) return upcoming(MONTH[groups.mo2.slice(0, 3).toLowerCase()], Number(groups.day2));
  if (groups.nm) {
    const year = groups.ny ? (groups.ny.length === 2 ? 2000 + Number(groups.ny) : Number(groups.ny)) : undefined;
    return upcoming(Number(groups.nm) - 1, Number(groups.nd), year);
  }
  return null;
}

const at = (day: Date, minutes: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes).getTime();

/** Days with times written in some text, in order. A day without a time is kept only with `days`. */
export function findTimes(text: string, ref: Date, { days = false } = {}): FoundTime[] {
  const found: FoundTime[] = [];
  for (const match of (text || "").matchAll(DATE)) {
    const groups = match.groups || {};
    const day = dayOf(groups, ref);
    if (!day) continue;
    const after = text.slice(match.index! + match[0].length, match.index! + match[0].length + 40);
    // "tonight" is a day and a time.
    let time = groups.rel?.toLowerCase() === "tonight" ? { from: 19 * 60, to: 21 * 60, length: 0 } : timeAt(after);
    let index = match.index!, length = match[0].length + (time?.length || 0);
    if (!time) {
      // "at 2pm on Thursday", "the morning of Nov 19".
      const before = text.slice(Math.max(0, index - 30), index);
      const lead = new RegExp(`(?:(?:at|from)\\s+)?(${LONE_TIME}|morning|afternoon|evening|noon)\\s+(?:on\\s+|of\\s+)?$`, "i").exec(before);
      const parsed = lead && timeAt(lead[1]);
      if (lead && parsed) { time = parsed; index -= lead[0].length; length += lead[0].length; }
    }
    if (!time && !days) continue;
    // A run of days ("Dec 10-12"): all day from the first to the last.
    let last: Date | null = null;
    const run = !time && (groups.mo || groups.mo2 || groups.wdmo) ? DAY_RUN.exec(after) : null;
    if (run) {
      const month = run[1] ? MONTH[run[1].slice(0, 3).toLowerCase()] : day.getMonth();
      let end = new Date(day.getFullYear(), month, Number(run[2]));
      if (!run[1] && end < day) end = new Date(day.getFullYear(), month + 1, Number(run[2]));
      if (end < day) end = new Date(day.getFullYear() + 1, month, Number(run[2]));
      if (end.getDate() === Number(run[2]) && end > day && end.getTime() - day.getTime() < 62 * DAY) { last = end; length += run[0].length; }
    }
    if (found.some((f) => index < f.index + f.text.length)) continue;
    found.push(time
      ? { text: text.slice(index, index + length).trim(), index, start: at(day, time.from), end: at(day, time.to), allDay: false, timed: true }
      : { text: text.slice(index, index + length), index, start: day.getTime(), end: (last || day).getTime() + DAY, allDay: true, timed: false });
  }
  return found;
}

/** Quick add ("Lunch with Priya Thu 1pm at Cafe Rio"): the title, place and time (a time alone is today, or
 *  tomorrow once it has passed; no time is the next hour). */
export function quickAdd(text: string, now: Date): { title: string; location: string; start: number; end: number; allDay: boolean } {
  let rest = ` ${text.trim()} `;
  let when: { start: number; end: number; allDay: boolean } | null = null;
  const [found] = findTimes(rest, now, { days: true });
  if (found) {
    when = { start: found.start, end: found.end, allDay: found.allDay };
    rest = rest.slice(0, found.index) + " " + rest.slice(found.index + found.text.length);
  } else {
    const time = new RegExp(`\\s(?:at\\s+)?(${LONE_TIME}|noon)(?=\\s)`, "i").exec(rest);
    const parsed = time && timeAt(time[1]);
    if (time && parsed) {
      let day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (at(day, parsed.from) <= now.getTime()) day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
      when = { start: at(day, parsed.from), end: at(day, parsed.to), allDay: false };
      rest = rest.slice(0, time.index) + " " + rest.slice(time.index + time[0].length);
    }
  }
  if (!when) {
    const next = new Date(now); next.setMinutes(0, 0, 0); next.setHours(next.getHours() + 1);
    when = { start: next.getTime(), end: next.getTime() + 3600000, allDay: false };
  }
  // "for 30 minutes": how long, from the start (a time without an end lasts an hour).
  const lasting = LASTING.exec(rest);
  if (lasting) {
    const amount = /^half/i.test(lasting[1]) ? 0.5 : /^(?:an?|one)$/i.test(lasting[1]) ? 1 : Number(lasting[1]);
    const minutes = Math.round(amount * (/^h/i.test(lasting[2]) ? 60 : 1));
    if (!when.allDay && minutes >= 5 && minutes <= 24 * 60) {
      when = { ...when, end: when.start + minutes * 60000 };
      rest = rest.slice(0, lasting.index) + " " + rest.slice(lasting.index + lasting[0].length);
    }
  }
  // " at Cafe Rio" / " @ Cafe Rio" at the end is the place.
  let location = "";
  const place = /\s(?:at|@)\s+([^\s].*?)\s*$/i.exec(rest);
  if (place && !/^\d/.test(place[1])) { location = place[1].trim(); rest = rest.slice(0, place.index); }
  const title = rest.replace(/\s+(?:on|at|from|for)\s*$/i, "").replace(/\s{2,}/g, " ").trim().replace(/[,;:-]+$/, "").trim();
  return { title: title || "New event", location, ...when };
}
