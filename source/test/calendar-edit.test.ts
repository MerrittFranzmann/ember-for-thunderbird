import { describe, expect, it } from "vitest";
import { draftChanges, draftForSlot, draftFromEmail, draftFromEvent, draftProblem, repeatOptions, toEwsEvent, windowsZone } from "../src/lib/calendar-edit";

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
const iso = (d: number, h: number, m = 0) => new Date(at(d, h, m)).toISOString();
const ME = new Set(["me@x.test"]);
const ZONE = "Eastern Standard Time";

describe("new events", () => {
  it("makes a timed event from a slot, with a 15-minute alert", () => {
    const draft = draftForSlot("a1", at(19, 13), at(19, 14, 30));
    expect(draft).toMatchObject({ mode: "new", startDate: "2026-11-19", startTime: "13:00", endDate: "2026-11-19", endTime: "14:30", reminder: 15, showAs: "Busy", repeat: "none" });
    draft.title = "Venue walkthrough"; draft.repeat = "weekly";
    expect(toEwsEvent(draft, ZONE)).toEqual({ subject: "Venue walkthrough", location: "", body: "", start: iso(19, 13), end: iso(19, 14, 30), allDay: false, freeBusy: "Busy", reminder: 15, attendees: [], recurrence: { kind: "weekly", start: "2026-11-19" }, timeZone: ZONE });
  });
  it("makes all-day events end at the midnight after their last day, shown as free", () => {
    const draft = draftForSlot("a1", at(26, 0), at(28, 0), true);
    expect(draft).toMatchObject({ allDay: true, startDate: "2026-11-26", endDate: "2026-11-27", showAs: "Free", reminder: -1 });
    expect(toEwsEvent(draft, "")).toMatchObject({ start: iso(26, 0), end: iso(28, 0), allDay: true });
  });
  it("says what's wrong", () => {
    const draft = draftForSlot("a1", at(19, 13), at(19, 14));
    expect(draftProblem(draft)).toBe("");
    expect(draftProblem({ ...draft, endTime: "12:00" })).toBe("The event ends before it starts.");
    expect(draftProblem({ ...draft, invitees: [{ name: "Priya", email: "priya" }] })).toBe("priya isn't an email address.");
    expect(draftProblem({ ...draft, accountId: "" })).toBe("Choose a calendar.");
  });
  it("from an email: its subject without Re:, the people on it but me, the time it mentions, and a line back to it", () => {
    const draft = draftFromEmail("a1", { subject: "RE: Venue contract", people: [{ name: "Priya", email: "Priya@x.test" }, { name: "Me", email: "me@x.test" }, { name: "P", email: "priya@x.test" }], link: "http://127.0.0.1:47391/email/abc" },
      { start: at(19, 13), end: at(19, 15), allDay: false }, at(16, 11), ME);
    expect(draft).toMatchObject({ title: "Venue contract", startTime: "13:00", endTime: "15:00", invitees: [{ name: "Priya", email: "Priya@x.test" }] });
    expect(toEwsEvent(draft, ZONE).body).toBe("From the email “RE: Venue contract”: http://127.0.0.1:47391/email/abc");
    // No time in it: the next hour.
    expect(draftFromEmail("a1", { subject: "Hi", people: [] }, null, at(16, 11, 42), ME)).toMatchObject({ startDate: "2026-11-16", startTime: "12:00", endTime: "13:00" });
  });
  it("words the repeats for the first day", () => {
    expect(repeatOptions("2026-11-19", "en-US").map(([, label]) => label)).toEqual(["Never", "Every day", "Every weekday", "Every week on Thursday", "Every 2 weeks on Thursday", "Every month on the 19th", "Every year on November 19"]);
  });
});

describe("changing events", () => {
  const meeting = { accountId: "a1", id: "EV1", changeKey: "CK", type: "Single", subject: "Board prep", location: "Room 4", body: "Agenda", start: iso(17, 10), end: iso(17, 11), allDay: false, freeBusy: "Busy", reminder: 15,
    attendees: [{ name: "Me", email: "me@x.test", role: "organizer" }, { name: "Oliver", email: "oliver@x.test", role: "required" }] };
  it("starts from the event, without the organizer and me among the invitees", () => {
    const draft = draftFromEvent(meeting, ME);
    expect(draft).toMatchObject({ mode: "edit", itemId: "EV1", changeKey: "CK", occurrence: false, title: "Board prep", location: "Room 4", notes: "Agenda", invitees: [{ name: "Oliver", email: "oliver@x.test" }] });
    expect(draftChanges(draft, ZONE)).toEqual({ changes: {}, send: false });
  });
  it("sends only what changed, and tells attendees about real changes only", () => {
    const draft = draftFromEvent(meeting, ME);
    draft.startTime = "10:30"; draft.endTime = "11:30"; draft.location = "";
    expect(draftChanges(draft, ZONE)).toEqual({ changes: { location: "", start: iso(17, 10, 30), end: iso(17, 11, 30), allDay: false, timeZone: ZONE }, send: true });
    const quiet = draftFromEvent(meeting, ME);
    quiet.reminder = 30;
    expect(draftChanges(quiet, ZONE)).toEqual({ changes: { reminder: 30 }, send: false });
    const people = draftFromEvent(meeting, ME);
    people.invitees = [];
    expect(draftChanges(people, ZONE)).toEqual({ changes: { attendees: [] }, send: true });
  });
  it("doesn't change a series' repeat from one occurrence", () => {
    const draft = draftFromEvent({ ...meeting, type: "Occurrence" }, ME);
    draft.repeat = "daily";
    expect(draftChanges(draft, ZONE).changes).toEqual({});
    const single = draftFromEvent(meeting, ME);
    single.repeat = "monthly";
    expect(draftChanges(single, ZONE).changes).toEqual({ recurrence: { kind: "monthly", start: "2026-11-17" }, timeZone: ZONE });
  });
  it("names Exchange's time zone", () => {
    expect(windowsZone("America/New_York")).toBe("Eastern Standard Time");
    expect(windowsZone("Mars/Base")).toBe("");
  });
});
