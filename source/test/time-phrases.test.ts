import { describe, expect, it } from "vitest";
import { findTimes, quickAdd } from "../src/lib/time-phrases";

const MON = new Date(2026, 10, 16, 11, 42); // Monday, November 16, 2026, 11:42 AM
const t = (d: number, h: number, m = 0, mo = 10) => new Date(2026, mo, d, h, m).getTime();
const one = (text: string, ref = MON) => findTimes(text, ref).map(({ text, start, end }) => ({ text, start, end }));

describe("times in an email", () => {
  it("reads a weekday with a range, guessing afternoons for small hours", () => {
    expect(one("I'm free Thursday from 1 to 3, or Friday morning works too.")).toEqual([
      { text: "Thursday from 1 to 3", start: t(19, 13), end: t(19, 15) },
      { text: "Friday morning", start: t(20, 9), end: t(20, 12) },
    ]);
  });
  it("reads am/pm, minutes, noon and ranges crossing noon", () => {
    expect(one("Can we do Nov 19 at 2:30pm?")).toEqual([{ text: "Nov 19 at 2:30pm", start: t(19, 14, 30), end: t(19, 15, 30) }]);
    expect(one("tomorrow at noon")).toEqual([{ text: "tomorrow at noon", start: t(17, 12), end: t(17, 13) }]);
    expect(one("Wednesday 11-1pm")).toEqual([{ text: "Wednesday 11-1pm", start: t(18, 11), end: t(18, 13) }]);
    expect(one("on 12/3 10–11:30am")).toEqual([{ text: "12/3 10–11:30am", start: t(3, 10, 0, 11), end: t(3, 11, 30, 11) }]);
    expect(one("Tue, Nov 24 9:00 AM - 10:00 AM")).toEqual([{ text: "Tue, Nov 24 9:00 AM - 10:00 AM", start: t(24, 9), end: t(24, 10) }]);
  });
  it("reads a time written before the day", () => {
    expect(one("Let's meet at 3pm on Friday.")).toEqual([{ text: "at 3pm on Friday", start: t(20, 15), end: t(20, 16) }]);
  });
  it("means the next one: a weekday today is next week's, 'next' skips this week", () => {
    expect(one("Monday at 10am")[0].start).toBe(t(23, 10));
    expect(one("next Wednesday at 10am")[0].start).toBe(t(25, 10));
    expect(one("this Wednesday at 10am")[0].start).toBe(t(18, 10));
    // A date already past this year is next year's.
    expect(one("Jan 5 at 9am")[0].start).toBe(new Date(2027, 0, 5, 9).getTime());
  });
  it("ignores numbers that aren't times, and days without a time unless asked", () => {
    expect(one("Friday 3 people are out")).toEqual([]);
    expect(one("Thanks for Monday")).toEqual([]);
    expect(findTimes("Thanks for Monday", MON, { days: true })).toMatchObject([{ text: "Monday", allDay: true, start: t(23, 0), timed: false }]);
    expect(one("Mayday at sea; sunday-ish")).toEqual([]);
  });
});

describe("quick add", () => {
  it("takes the time and place out of the title", () => {
    expect(quickAdd("Lunch with Priya Thu 1pm at Cafe Rio", MON)).toEqual({ title: "Lunch with Priya", location: "Cafe Rio", start: t(19, 13), end: t(19, 14), allDay: false });
    expect(quickAdd("Dentist tomorrow 9-10am", MON)).toMatchObject({ title: "Dentist", start: t(17, 9), end: t(17, 10) });
  });
  it("puts a time alone today, or tomorrow once passed; a day alone is all day", () => {
    expect(quickAdd("Call Dana at 3pm", MON)).toMatchObject({ title: "Call Dana", start: t(16, 15) });
    expect(quickAdd("Standup 9am", MON)).toMatchObject({ title: "Standup", start: t(17, 9) });
    expect(quickAdd("Mom's birthday Friday", MON)).toMatchObject({ title: "Mom's birthday", allDay: true, start: t(20, 0) });
    expect(quickAdd("Think", MON)).toMatchObject({ title: "Think", start: t(16, 12), end: t(16, 13), allDay: false });
  });
});
