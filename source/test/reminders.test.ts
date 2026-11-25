import { describe, expect, it } from "vitest";
import { planReminders, reminderMessage } from "../src/lib/reminders";
import type { CalendarEvent } from "../src/lib/meeting-status";

const at = (iso: string) => Date.parse(iso);
const event = (p: Partial<CalendarEvent>): CalendarEvent => ({ accountId: "a", id: "x", uid: "U", subject: "Weekly sync", start: "2026-10-28T17:30:00Z", end: "2026-10-28T18:00:00Z", allDay: false, location: "", freeBusy: "Busy", response: "accept", cancelled: false, ...p });

describe("meeting reminders", () => {
  const now = at("2026-10-28T16:00:00Z");
  it("reminds the chosen minutes before each remaining meeting, once per meeting", () => {
    const plan = planReminders([
      event({ id: "a", uid: "A", body: "Join: https://northwind.zoom.us/j/123" }),
      event({ id: "a2", uid: "A", accountId: "b" }), // the same meeting on the other account
      event({ id: "allday", uid: "D", allDay: true, start: "2026-10-28T04:00:00Z", end: "2026-10-29T04:00:00Z" }),
      event({ id: "declined", uid: "X", response: "decline" }),
      event({ id: "done", uid: "E", start: "2026-10-28T14:00:00Z", end: "2026-10-28T15:00:00Z" }),
    ], now, 5);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ key: "A|2026-10-28T17:30:00Z", at: at("2026-10-28T17:25:00Z"), subject: "Weekly sync", join: { url: "https://northwind.zoom.us/j/123", label: "Zoom" } });
  });
  it("follows Outlook's own reminder when asked, and is off at 0", () => {
    const events = [event({ uid: "A", reminder: 15 }), event({ uid: "B", reminder: -1, start: "2026-10-28T19:00:00Z", end: "2026-10-28T19:30:00Z" }), event({ uid: "C", reminder: null, start: "2026-10-28T20:00:00Z", end: "2026-10-28T20:30:00Z" })];
    expect(planReminders(events, now, -1).map((r) => [r.key.split("|")[0], (r.start - r.at) / 60000])).toEqual([["A", 15], ["C", 15]]);
    expect(planReminders(events, now, 0)).toEqual([]);
  });
  it("still reminds shortly after a meeting started (Thunderbird was asleep), not long after", () => {
    expect(planReminders([event({ start: "2026-10-28T15:55:00Z", end: "2026-10-28T16:30:00Z" })], now, 5)).toHaveLength(1);
    expect(planReminders([event({ start: "2026-10-28T15:40:00Z", end: "2026-10-28T16:30:00Z" })], now, 5)).toHaveLength(0);
  });
  it("says when it starts, where, and what a click does", () => {
    const [reminder] = planReminders([event({ location: "Room 2", body: "https://teams.microsoft.com/l/meetup-join/19%3a1/0" })], now, 5);
    const text = reminderMessage(reminder, at("2026-10-28T17:25:00Z")).replace(/\s/g, " ");
    expect(text).toMatch(/^Starts at .+ \(in 5 min\) · Room 2 Click to join on Teams$/);
    expect(reminderMessage({ ...reminder, join: null, location: "https://x" }, at("2026-10-28T17:33:00Z")).replace(/\s/g, " ")).toMatch(/^Started 3 min ago .* Click to open Ember$/);
  });
});
