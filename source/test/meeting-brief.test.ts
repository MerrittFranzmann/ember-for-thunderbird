import { describe, expect, it } from "vitest";
import { briefDue, briefFor, briefMail, briefSummary, briefView, planBriefs, startsIn } from "../src/lib/meeting-brief";
import { matchesSearchHeader } from "../src/lib/mail-search";
import type { CalendarEvent } from "../src/lib/meeting-status";
import type { MessageHeader } from "../src/lib/types";

const at = (iso: string) => Date.parse(iso);
const me = new Set(["me@northwind.example"]);
const event = (p: Partial<CalendarEvent>): CalendarEvent => ({ accountId: "a", id: "x", uid: "U", subject: "Studio sync", start: "2026-10-28T17:30:00Z", end: "2026-10-28T18:00:00Z", allDay: false, location: "", freeBusy: "Busy", response: "accept", cancelled: false,
  attendees: [{ name: "Ada Lovelace", email: "ada@partner.org", role: "organizer" }, { name: "Me", email: "ME@northwind.example", role: "required" }, { name: "Grace Hopper", email: "grace@northwind.example", role: "required" }], ...p });
const mail = (p: Partial<MessageHeader>): MessageHeader => ({ id: 1, date: new Date("2026-10-27T12:00:00Z"), author: "x@y.z", subject: "s", flagged: false, recipients: [], ccList: [], bccList: [], headerMessageId: "m", size: 1, tags: [], folder: { id: "f", name: "Inbox", path: "/INBOX", specialUse: ["inbox"] }, ...p });

describe("before your meeting", () => {
  const now = at("2026-10-28T17:22:00Z");
  it("is about everyone in the meeting but the user, for meetings with other people", () => {
    const brief = briefFor(event({ body: "https://teams.microsoft.com/l/meetup-join/19%3a1" }), me)!;
    expect(brief.people.map((p) => p.email)).toEqual(["ada@partner.org", "grace@northwind.example"]);
    expect(brief).toMatchObject({ key: "U|2026-10-28T17:30:00Z", subject: "Studio sync", start: at("2026-10-28T17:30:00Z"), join: { label: "Teams" } });
    expect(briefFor(event({ attendees: [{ name: "Me", email: "me@northwind.example" }] }), me)).toBeNull();
    expect(briefFor(event({ allDay: true }), me)).toBeNull();
    expect(briefFor(event({ response: "decline" }), me)).toBeNull();
    expect(briefFor(event({ attendees: undefined }), me)).toBeNull();
  });
  it("gathers the last 30 days of email from or to those people, without junk or trash", () => {
    const brief = briefFor(event({}), me)!;
    const headers = [
      mail({ id: 1, author: "Ada Lovelace <ada@partner.org>", date: new Date("2026-10-27T09:00:00Z") }),
      mail({ id: 2, author: "me@northwind.example", recipients: ["Grace <grace@northwind.example>"], date: new Date("2026-10-28T08:00:00Z") }),
      mail({ id: 3, author: "someone@else.org" }),
      mail({ id: 4, author: "ada@partner.org", date: new Date("2026-09-01T09:00:00Z") }),
      mail({ id: 5, author: "ada@partner.org", junk: true }),
      mail({ id: 6, author: "ada@partner.org", folder: { id: "t", name: "Trash", path: "/Trash", specialUse: ["trash"] } }),
      mail({ id: 7, author: "news@else.org", ccList: ["ADA@partner.org"] }),
    ];
    const found = briefMail(headers, brief, now);
    expect(found.map((m) => m.id)).toEqual([2, 7, 1]);
    expect(briefSummary(brief, found)).toBe("3 recent emails with Ada Lovelace and Grace Hopper");
    expect(briefSummary(brief, found.slice(0, 1))).toBe("1 recent email with Grace Hopper");
    // The list view is a saved-mail search with the same people and dates.
    const view = briefView(brief, now);
    expect(view).toMatchObject({ kind: "search", query: "", scope: "local", filters: { people: ["ada@partner.org", "grace@northwind.example"], after: expect.stringMatching(/^2026-09-2[78]$/) }, meeting: brief });
    const filters = (view as any).filters;
    expect(headers.filter((m) => matchesSearchHeader(m, filters)).map((m) => m.id)).toEqual([1, 2, 7]);
  });
  it("plans a notification ten minutes before each meeting in the next day (now when that has passed)", () => {
    const plan = planBriefs([
      event({ uid: "A", start: "2026-10-28T18:00:00Z", end: "2026-10-28T18:30:00Z" }),
      event({ uid: "A", accountId: "b", start: "2026-10-28T18:00:00Z", end: "2026-10-28T18:30:00Z" }),
      event({ uid: "B" }),
      event({ uid: "C", start: "2026-10-28T17:00:00Z", end: "2026-10-28T17:30:00Z" }),
      event({ uid: "D", start: "2026-10-30T17:00:00Z", end: "2026-10-30T17:30:00Z" }),
    ], now, me);
    expect(plan.map((b) => [b.key.split("|")[0], new Date(b.at).toISOString()])).toEqual([["B", "2026-10-28T17:22:00.000Z"], ["A", "2026-10-28T17:50:00.000Z"]]);
  });
  it("shows above the inbox from ten minutes before until five minutes in", () => {
    const start = at("2026-10-28T17:30:00Z");
    expect(briefDue({ start }, start - 11 * 60000)).toBe(false);
    expect(briefDue({ start }, start - 10 * 60000)).toBe(true);
    expect(briefDue({ start }, start + 4 * 60000)).toBe(true);
    expect(briefDue({ start }, start + 5 * 60000)).toBe(false);
    expect(startsIn(start, start - 8 * 60000)).toBe("In 8 min");
    expect(startsIn(start, start)).toBe("Now");
    expect(startsIn(start, start + 3 * 60000)).toBe("Started 3 min ago");
    expect(startsIn(start, start - 90 * 60000)).toBe("In 1 h 30 min");
  });
});
