import { describe, expect, it } from "vitest";
import { allDayOn, calendarOf, eventKey, eventTitle, daysOf, emailsAbout, eventLook, eventNotes, inAllDayRow, miniMonth, monthCells, overlapsWith, placeDay, rangeFor, oncePerSeries, searchEvents, shownEvents, step, titleFor, whenText } from "../src/lib/calendar-grid";
import type { CalendarEvent } from "../src/lib/meeting-status";

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const iso = (y: number, mo: number, d: number, h = 0, mi = 0) => at(y, mo, d, h, mi).toISOString();
let n = 0;
const ev = (start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  accountId: "a1", id: `E${++n}`, uid: "", subject: `Event ${n}`, start, end, allDay: false, location: "", freeBusy: "Busy", response: "accept", cancelled: false, ...extra,
});
const MON = at(2026, 11, 16).getTime(); // Monday, November 16, 2026

describe("ranges and titles", () => {
  it("covers a day, a week from the first weekday, and whole weeks of a month", () => {
    expect(rangeFor("day", MON + 5 * 3600000, 0)).toEqual({ start: at(2026, 11, 16), end: at(2026, 11, 17) });
    expect(rangeFor("week", MON, 0)).toEqual({ start: at(2026, 11, 15), end: at(2026, 11, 22) });
    expect(rangeFor("week", MON, 1)).toEqual({ start: at(2026, 11, 16), end: at(2026, 11, 23) });
    // November 2026 starts on a Sunday: five weeks, Nov 1 – Dec 5.
    expect(rangeFor("month", MON, 0)).toEqual({ start: at(2026, 11, 1), end: at(2026, 12, 6) });
    // Starting Monday it needs six (Oct 26 – Dec 6).
    expect(rangeFor("month", MON, 1)).toEqual({ start: at(2026, 10, 26), end: at(2026, 12, 7) });
    expect(rangeFor("year", MON, 0)).toEqual({ start: at(2026, 1, 1), end: at(2027, 1, 1) });
  });
  it("steps by the mode, keeping months valid", () => {
    expect(step("day", MON, 1)).toBe(at(2026, 11, 17).getTime());
    expect(step("week", MON, -1)).toBe(at(2026, 11, 9).getTime());
    expect(step("month", at(2026, 1, 31).getTime(), 1)).toBe(at(2026, 2, 1).getTime());
    expect(step("year", MON, 1)).toBe(at(2027, 1, 1).getTime());
  });
  it("titles like Apple: bold month, light year; a week across months shortens both", () => {
    expect(titleFor("month", MON, 0, "en-US")).toEqual({ bold: "November", rest: "2026" });
    expect(titleFor("week", MON, 0, "en-US")).toEqual({ bold: "November", rest: "2026" });
    expect(titleFor("week", at(2026, 11, 30).getTime(), 0, "en-US")).toEqual({ bold: "Nov – Dec", rest: "2026" });
    expect(titleFor("week", at(2026, 12, 30).getTime(), 0, "en-US")).toEqual({ bold: "Dec – Jan", rest: "2026 – 2027" });
    expect(titleFor("day", MON, 0, "en-US")).toEqual({ bold: "November 16,", rest: "2026" });
    expect(titleFor("year", MON, 0, "en-US")).toEqual({ bold: "2026", rest: "" });
  });
});

describe("day columns", () => {
  it("puts overlapping meetings side by side and lone ones full width", () => {
    const a = ev(iso(2026, 11, 16, 9), iso(2026, 11, 16, 10));
    const b = ev(iso(2026, 11, 16, 9, 30), iso(2026, 11, 16, 10, 30));
    const c = ev(iso(2026, 11, 16, 10), iso(2026, 11, 16, 11)); // reuses a's lane
    const d = ev(iso(2026, 11, 16, 14), iso(2026, 11, 16, 14, 5)); // short: drawn as 15 minutes
    const placed = placeDay([d, c, b, a], MON, 52);
    const of = (e: CalendarEvent) => placed.find((p) => p.event === e)!;
    expect([of(a).lane, of(b).lane, of(c).lane]).toEqual([0, 1, 0]);
    expect([of(a).lanes, of(b).lanes, of(c).lanes]).toEqual([2, 2, 2]);
    expect(of(a).top).toBe(9 * 52);
    expect(of(d)).toMatchObject({ lane: 0, lanes: 1, top: 14 * 52, height: 13 });
  });
  it("clips a meeting that crosses midnight to each day", () => {
    const late = ev(iso(2026, 11, 16, 23), iso(2026, 11, 17, 1));
    const [today] = placeDay([late], MON, 60);
    const [tomorrow] = placeDay([late], at(2026, 11, 17), 60);
    expect(today).toMatchObject({ top: 23 * 60, height: 60, endsAfter: true, startsBefore: false });
    expect(tomorrow).toMatchObject({ top: 0, height: 60, startsBefore: true });
  });
  it("shows all-day events and day-long meetings in the all-day row, on each of their days", () => {
    const holiday = ev(iso(2026, 11, 26), iso(2026, 11, 28), { allDay: true });
    const retreat = ev(iso(2026, 11, 16, 9), iso(2026, 11, 18, 17));
    expect(inAllDayRow(retreat)).toBe(true);
    expect(allDayOn([holiday, retreat], at(2026, 11, 17))).toEqual([retreat]);
    expect(allDayOn([holiday], at(2026, 11, 27))).toEqual([holiday]);
    expect(allDayOn([holiday], at(2026, 11, 28))).toEqual([]);
    expect(placeDay([holiday, retreat], at(2026, 11, 17))).toEqual([]);
  });
  it("leaves out declined events and hidden calendars, earliest first", () => {
    const one = ev(iso(2026, 11, 16, 11), iso(2026, 11, 16, 12));
    const two = ev(iso(2026, 11, 16, 9), iso(2026, 11, 16, 10), { accountId: "a2" });
    const declined = ev(iso(2026, 11, 16, 8), iso(2026, 11, 16, 9), { response: "decline" });
    expect(shownEvents([one, two, declined], new Set())).toEqual([two, one]);
    expect(shownEvents([one, two, declined], new Set(["a2"]))).toEqual([one]);
  });
});

describe("month and mini months", () => {
  it("lists each day's events, all-day first", () => {
    const meeting = ev(iso(2026, 11, 19, 9), iso(2026, 11, 19, 10));
    const birthday = ev(iso(2026, 11, 19), iso(2026, 11, 20), { allDay: true });
    const cells = monthCells(MON, 0, [meeting, birthday]);
    expect(cells.length).toBe(35);
    expect(cells[0]).toMatchObject({ inMonth: true });
    expect(cells[34]).toMatchObject({ inMonth: false });
    expect(cells.find((c) => c.date.getDate() === 19 && c.inMonth)!.events).toEqual([birthday, meeting]);
  });
  it("always draws six weeks", () => {
    const days = miniMonth(2026, 1, 0);
    expect(days.length).toBe(42);
    expect(days.filter((d) => d.inMonth).length).toBe(28);
    expect(daysOf(at(2026, 11, 15), at(2026, 11, 22)).length).toBe(7);
  });
});

describe("details", () => {
  it("draws unanswered, maybe, free and cancelled differently", () => {
    expect(eventLook(ev("", "", { response: "none" }))).toBe("unanswered");
    expect(eventLook(ev("", "", { response: "tentative" }))).toBe("tentative");
    expect(eventLook(ev("", "", { response: "organizer", freeBusy: "Free" }))).toBe("free");
    expect(eventLook(ev("", "", { cancelled: true, response: "none" }))).toBe("cancelled");
    expect(eventLook(ev("", "", { response: "organizer" }))).toBe("busy");
  });
  it("finds busy overlaps only", () => {
    const a = ev(iso(2026, 11, 16, 14), iso(2026, 11, 16, 15));
    const b = ev(iso(2026, 11, 16, 14, 30), iso(2026, 11, 16, 15, 15));
    const free = ev(iso(2026, 11, 16, 14), iso(2026, 11, 16, 15), { freeBusy: "Free" });
    const after = ev(iso(2026, 11, 16, 15), iso(2026, 11, 16, 16));
    expect(overlapsWith(a, [a, b, free, after])).toEqual([b]);
  });
  it("words the time", () => {
    expect(whenText(ev(iso(2026, 11, 16, 9), iso(2026, 11, 16, 9, 30)), "en-US")).toEqual({ day: "Monday, November 16, 2026", time: "9:00 AM to 9:30 AM" });
    expect(whenText(ev(iso(2026, 11, 26), iso(2026, 11, 28), { allDay: true }), "en-US").time).toBe("All day, until Fri, Nov 27");
    expect(whenText(ev(iso(2026, 11, 19), iso(2026, 11, 20), { allDay: true }), "en-US").time).toBe("All day");
    expect(whenText(ev(iso(2026, 11, 16, 23), iso(2026, 11, 17, 0)), "en-US").time).toBe("11:00 PM to 12:00 AM");
  });
  it("drops the Teams block from the notes", () => {
    const body = "Walk through slide 7.\r\n\r\n________________________________________________________________________________\r\nMicrosoft Teams meeting\r\nJoin: https://teams.microsoft.com/l/meetup-join/x";
    expect(eventNotes(body)).toBe("Walk through slide 7.");
    expect(eventNotes("Microsoft Teams meeting\nJoin on your computer")).toBe("");
    expect(eventNotes(undefined)).toBe("");
  });
  it("finds the meeting's emails by title, newest first, without trash", () => {
    const mail = (id: number, subject: string, day: number, extra: any = {}) => ({ id, subject, date: at(2026, 11, day), headerMessageId: `m${id}`, author: "", recipients: [], ccList: [], bccList: [], flagged: false, size: 0, tags: [], ...extra });
    const event = ev(iso(2026, 11, 19, 13), iso(2026, 11, 19, 14), { subject: "Venue walkthrough" });
    const headers = [mail(1, "Venue walkthrough", 10), mail(2, "Accepted: Venue walkthrough", 12), mail(3, "RE: Venue walkthrough", 14), mail(4, "Venue walkthrough notes", 15), mail(5, "Venue walkthrough", 16, { folder: { specialUse: ["trash"] } })] as any;
    expect(emailsAbout(event, headers).map((m) => m.id)).toEqual([3, 2, 1]);
    expect(emailsAbout({ ...event, subject: "1:1" }, headers)).toEqual([]);
  });
  it("searches titles, places and people", () => {
    const a = ev("", "", { subject: "Budget review", location: "Room 4" });
    const b = ev("", "", { subject: "Sync", attendees: [{ name: "Priya Nair", email: "priya@x.test" }] });
    expect(searchEvents([a, b], "budget")).toEqual([a]);
    expect(searchEvents([a, b], "priya")).toEqual([b]);
    expect(searchEvents([a, b], "room 4")).toEqual([a]);
    expect(searchEvents([a, b], " ")).toEqual([]);
  });
});

describe("shared calendars on the page", () => {
  const mine = ev("2026-11-17T14:00:00Z", "2026-11-17T15:00:00Z", { id: "M", subject: "Mine" });
  const theirs = ev("2026-11-17T14:30:00Z", "2026-11-17T15:30:00Z", { id: "T", subject: "", calendarId: "A|priya@x.test", shared: true, busyOnly: true, response: "shared" });
  it("keys events by their calendar", () => {
    expect(calendarOf(mine)).toBe(mine.accountId);
    expect(calendarOf(theirs)).toBe("A|priya@x.test");
    expect(eventKey(theirs)).toBe(`A|priya@x.test|T|${theirs.start}`);
  });
  it("hides a calendar by its key", () => {
    expect(shownEvents([mine, theirs], new Set(["A|priya@x.test"]))).toEqual([mine]);
    expect(shownEvents([mine, theirs], new Set())).toEqual([mine, theirs]);
  });
  it("doesn't count someone else's meetings as the user's clashes", () => {
    expect(overlapsWith(mine, [mine, theirs])).toEqual([]);
    expect(overlapsWith(theirs, [mine, theirs])).toEqual([]);
  });
  it("calls a busy time with no subject Busy", () => {
    expect(eventTitle(theirs)).toBe("Busy");
    expect(eventTitle({ ...theirs, subject: "Board prep" })).toBe("Board prep");
    expect(eventTitle({ ...mine, subject: "" })).toBe("(no title)");
  });
});

describe("search results once per series", () => {
  const occ = (uid: string, day: number, subject = "Standup"): any => ({ accountId: "a", calendarId: "c", id: `${uid}#${day}`, uid, subject, location: "", start: new Date(2026, 10, day, 9).toISOString(), end: new Date(2026, 10, day, 9, 15).toISOString(), allDay: false });
  it("keeps a repeating event's next occurrence, upcoming first, then the past, latest first", () => {
    const now = new Date(2026, 10, 18, 12).getTime();
    const list = [occ("s", 16), occ("s", 17), occ("s", 19), occ("s", 20), occ("one", 21, "Offsite"), occ("old", 10, "Kickoff"), occ("old2", 14, "Retro")];
    const out = oncePerSeries(list, now);
    expect(out.map((r) => [r.event.subject, new Date(r.event.start).getDate(), r.count])).toEqual([["Standup", 19, 4], ["Offsite", 21, 1], ["Retro", 14, 1], ["Kickoff", 10, 1]]);
  });
});
