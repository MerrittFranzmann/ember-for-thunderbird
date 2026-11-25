import { describe, expect, it } from "vitest";
import { agendaItems, conflicts, currentAnswer, exchangeConfirmed, joinSoon, shownOnCalendar, timeRange, type CalendarEvent, dayAgenda, responseMark, unansweredClashes } from "../src/lib/meeting-status";

const at = (iso: string) => Date.parse(iso);
const event = (p: Partial<CalendarEvent>): CalendarEvent => ({ accountId: "account1", id: "x", uid: "", subject: "Busy", start: "2026-10-28T17:00:00Z", end: "2026-10-28T18:00:00Z", allDay: false, location: "", freeBusy: "Busy", response: "accept", cancelled: false, ...p });

describe("meeting status", () => {
  it("prefers this session's answer, then Exchange's, then Ember's saved one, then the invitation's", () => {
    expect(currentAnswer({ session: "DECLINED", server: { response: "accept", outOfDate: false, onCalendar: true, cancelled: false } })).toBe("DECLINED");
    expect(currentAnswer({ server: { response: "tentative", outOfDate: false, onCalendar: true, cancelled: false }, saved: "ACCEPTED" })).toBe("TENTATIVE");
    expect(currentAnswer({ server: { response: "none", outOfDate: false, onCalendar: true, cancelled: false }, saved: "ACCEPTED" })).toBe("ACCEPTED");
    expect(currentAnswer({ invitation: "NEEDS-ACTION" })).toBe("");
    expect(currentAnswer({ invitation: "TENTATIVE" })).toBe("TENTATIVE");
    expect(currentAnswer({ server: { response: "organizer", outOfDate: false, onCalendar: true, cancelled: false } })).toBe("ORGANIZER");
  });
  it("only trusts Exchange's success once the calendar entry shows the answer", () => {
    expect(exchangeConfirmed("accept", "accept")).toBe(true);
    expect(exchangeConfirmed("accept", "unknown")).toBe(true);
    expect(exchangeConfirmed("accept", undefined)).toBe(true);
    expect(exchangeConfirmed("accept", "none")).toBe(false);
    expect(exchangeConfirmed("accept", "missing")).toBe(false);
    expect(exchangeConfirmed("decline", "missing")).toBe(true);
    expect(shownOnCalendar("none")).toBe("no answer");
  });
  it("finds busy overlaps, not the invitation's own placeholder or free time", () => {
    const when = { start: at("2026-10-28T17:30:00Z"), end: at("2026-10-28T18:30:00Z") };
    const found = conflicts([
      event({ id: "a", subject: "Weekly sync" }),
      event({ id: "self", uid: "U1", subject: "New meeting", start: "2026-10-28T17:30:00Z", end: "2026-10-28T18:30:00Z", response: "none", freeBusy: "Tentative" }),
      event({ id: "free", freeBusy: "Free" }),
      event({ id: "declined", response: "decline" }),
      event({ id: "cancelled", cancelled: true }),
      event({ id: "before", start: "2026-10-28T16:00:00Z", end: "2026-10-28T17:30:00Z" }),
      event({ id: "tentative", freeBusy: "Tentative", start: "2026-10-28T18:15:00Z", end: "2026-10-28T19:00:00Z" }),
    ], { uid: "U1", title: "New meeting" }, when);
    expect(found.map((e) => e.id)).toEqual(["a", "tentative"]);
    // Without UIDs, the placeholder is recognized by title and start.
    expect(conflicts([event({ id: "self", subject: "New meeting", start: "2026-10-28T17:30:00Z" })], { uid: "U1", title: "New meeting" }, when)).toEqual([]);
  });
  it("formats time ranges and knows when Join is the main action", () => {
    expect(timeRange(0, 1, true)).toBe("All day");
    const range = timeRange(new Date(2026, 9, 28, 13, 30).getTime(), new Date(2026, 9, 28, 14, 0).getTime());
    expect(range.replace(/\s/g, " ")).toMatch(/^1:30 – 2:00 PM$|^13:30 – 14:00$/);
    const when = { start: 100 * 60000, end: 160 * 60000 };
    expect(joinSoon(when, 89 * 60000)).toBe(false);
    expect(joinSoon(when, 91 * 60000)).toBe(true);
    expect(joinSoon(when, 159 * 60000)).toBe(true);
    expect(joinSoon(when, 160 * 60000)).toBe(false);
    expect(joinSoon(null, 0)).toBe(false);
  });
  it("lists the rest of today once, all-day first", () => {
    const now = at("2026-10-28T16:00:00Z");
    const items = agendaItems([
      event({ id: "later", uid: "L", start: "2026-10-28T19:00:00Z", end: "2026-10-28T20:00:00Z" }),
      event({ id: "done", start: "2026-10-28T13:00:00Z", end: "2026-10-28T14:00:00Z" }),
      event({ id: "now", uid: "N", start: "2026-10-28T15:30:00Z", end: "2026-10-28T16:30:00Z" }),
      event({ id: "twice", uid: "N", accountId: "account2", start: "2026-10-28T15:30:00Z", end: "2026-10-28T16:30:00Z" }),
      event({ id: "allday", uid: "A", allDay: true, start: "2026-10-28T04:00:00Z", end: "2026-10-29T04:00:00Z" }),
      event({ id: "gone", cancelled: true, start: "2026-10-28T19:00:00Z", end: "2026-10-28T20:00:00Z" }),
    ], now);
    expect(items.map((e) => e.id)).toEqual(["allday", "now", "later"]);
  });
});

describe("today + tomorrow agenda", () => {
  const ev = (p: Partial<CalendarEvent>): CalendarEvent => ({ accountId: "a", id: "x", uid: "", subject: "M", start: "", end: "", allDay: false, location: "", freeBusy: "Busy", response: "accept", cancelled: false, ...p });
  const local = (day: number, h: number, m = 0) => { const d = new Date(2026, 9, 28 + day, h, m); return d.toISOString(); };
  const now = new Date(2026, 9, 28, 11, 40).getTime();
  const events = [
    ev({ id: "standup", subject: "Standup", start: local(0, 9), end: local(0, 9, 15) }),
    ev({ id: "one", subject: "1:1", start: local(0, 11, 30), end: local(0, 12) }),
    ev({ id: "crit", subject: "Design critique", start: local(0, 15), end: local(0, 16), response: "none" }),
    ev({ id: "vendor", subject: "Vendor call", start: local(0, 15, 30), end: local(0, 16, 30) }),
    ev({ id: "lunch", subject: "Lunch", start: local(0, 13), end: local(0, 14), response: "none", freeBusy: "Free" }),
    ev({ id: "board", subject: "Board prep", start: local(1, 14), end: local(1, 15) }),
    ev({ id: "later", subject: "Next week", start: local(3, 9), end: local(3, 10) }),
  ];
  it("splits what's left of today from tomorrow", () => {
    expect(dayAgenda(events, now, 0).map((e) => e.id)).toEqual(["one", "lunch", "crit", "vendor"]);
    expect(dayAgenda(events, now, 1).map((e) => e.id)).toEqual(["board"]);
  });
  it("marks each answer and finds unanswered meetings that clash", () => {
    expect(responseMark(events[0])).toMatchObject({ mark: "✓", tone: "yes" });
    expect(responseMark(ev({ response: "tentative" }))).toMatchObject({ mark: "?" });
    expect(responseMark(events[2])).toMatchObject({ mark: "!", label: "Needs a reply" });
    expect(responseMark(ev({ response: "organizer" }))).toBeNull();
    expect(unansweredClashes(dayAgenda(events, now, 0)).map(([a, b]) => [a.id, b.id])).toEqual([["crit", "vendor"]]);
  });
});
describe("today + tomorrow: all-day", () => {
  it("keeps an all-day event on its own day", () => {
    const allDay = { accountId: "a", id: "ad", uid: "", subject: "Offsite", start: new Date(2026, 9, 28).toISOString(), end: new Date(2026, 9, 29).toISOString(), allDay: true, location: "", freeBusy: "Busy", response: "accept", cancelled: false };
    const now = new Date(2026, 9, 28, 11).getTime();
    expect(dayAgenda([allDay], now, 0)).toHaveLength(1);
    expect(dayAgenda([allDay], now, 1)).toHaveLength(0);
  });
});
