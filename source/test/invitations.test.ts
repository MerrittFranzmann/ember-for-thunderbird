import { describe, expect, it } from "vitest";
import { calendarBodies, closeCalendar, findJoinLink, formatCalendarDate, formatInvitationWhen, invitationLabel, inviteTitle, parseInvitations, responseSubject, responseTally } from "../src/lib/invitations";
const calendar = (method = "REQUEST", properties = "") => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Ember Test//EN\r\nMETHOD:${method}\r\nBEGIN:VEVENT\r\nUID:test-event@example.org\r\nDTSTART:20261030T140000Z\r\nDTEND:20261030T150000Z\r\nSUMMARY:Board review\r\nORGANIZER;CN=Ada Lovelace:mailto:ada@example.org\r\nATTENDEE;CN=Merritt;PARTSTAT=TENTATIVE:mailto:me@work.org\r\nLOCATION:Room 4B\r\nDESCRIPTION:Review the deck\\nBring the budget.\r\n${properties}END:VEVENT\r\nEND:VCALENDAR\r\n`;

describe("calendar invitation preview", () => {
  it("reads event, organizer, dates and the current identity's response", () => {
    const [event] = parseInvitations(calendar(), new Set(["me@work.org"]));
    expect(event.title).toBe("Board review");
    expect(event.organizer).toEqual({ name: "Ada Lovelace", email: "ada@example.org" });
    expect(event.start?.instant).toBe("2026-10-30T14:00:00.000Z");
    expect(event.response).toBe("TENTATIVE");
    expect(event.description).toBe("Review the deck\nBring the budget.");
    expect(event.canRespond).toBe(true);
  });
  it("distinguishes invitations, cancellations, replies and self-organized events", () => {
    // Outlook raises SEQUENCE whenever the organizer edits, often before the first invite reaches you.
    expect(invitationLabel(parseInvitations(calendar("REQUEST", "SEQUENCE:2\r\n"))[0])).toBe("Calendar invitation");
    for (const method of ["CANCEL", "REPLY", "PUBLISH"]) expect(parseInvitations(calendar(method))[0].canRespond).toBe(false);
    expect(parseInvitations(calendar(), new Set(["ada@example.org"]))[0].canRespond).toBe(false);
    expect(invitationLabel(parseInvitations(calendar("CANCEL"))[0])).toBe("Canceled event");
  });
  it("preserves named wall time when timezone definitions are absent", () => {
    const source = calendar().replace("DTSTART:20261030T140000Z", "DTSTART;TZID=America/New_York:20261030T100000").replace("DTEND:20261030T150000Z", "DTEND;TZID=America/New_York:20261030T110000");
    const [event] = parseInvitations(source);
    expect(event.start?.timezone).toBe("America/New_York");
    expect(event.start?.hour).toBe(10);
    expect(formatCalendarDate(event.start)).toContain("America/New_York");
  });
  it("identifies recurring and all-day events without treating a forwarded email as an invitation", () => {
    const allDay = calendar("REQUEST", "RRULE:FREQ=WEEKLY;COUNT=3\r\n").replace("DTSTART:20261030T140000Z", "DTSTART;VALUE=DATE:20261030").replace("DTEND:20261030T150000Z", "DTEND;VALUE=DATE:20261031");
    const [event] = parseInvitations(allDay);
    expect(event.recurring).toBe(true);
    expect(event.start?.allDay).toBe(true);
    expect(formatCalendarDate(event.start)).toContain("All day");
    expect(calendarBodies({ parts: [{ contentType: "text/calendar", body: allDay }, { contentType: "message/rfc822", parts: [{ contentType: "text/calendar", body: "Forwarded" }] }] })).toEqual([allDay]);
  });
  it("finds Exchange's inline calendar under Thunderbird's message/rfc822 root", () => {
    // messages.getFull's root is the message itself; Outlook invites carry the calendar only inline.
    const ics = calendar();
    const root = { contentType: "message/rfc822", parts: [{ contentType: "multipart/alternative", parts: [{ contentType: "text/plain", body: "Agenda" }, { contentType: "text/html", body: "<p>Agenda</p>" }, { contentType: "text/calendar", body: ics }, { contentType: "message/rfc822", parts: [{ contentType: "text/calendar", body: "Forwarded" }] }] }] };
    expect(calendarBodies(root)).toEqual([ics]);
  });
  it("reads Exchange's unterminated forwarded calendar and skips its UID-only stub event", () => {
    // Seen on a forwarded recurring Outlook meeting: a second VEVENT with just a UID, and no END:VCALENDAR.
    const source = calendar().replace("END:VCALENDAR\r\n", "BEGIN:VEVENT\r\nUID:test-event@example.org\r\n 0100\r\nEND:VEVENT\r\n");
    const events = parseInvitations(source);
    expect(events.map((e) => e.title)).toEqual(["Board review"]);
    expect(closeCalendar(source).endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(closeCalendar(calendar())).toBe(calendar());
  });
  it("displays the last occupied day of an all-day interval, excluding its DTEND", () => {
    const source = calendar().replace("DTSTART:20261030T140000Z", "DTSTART;VALUE=DATE:20261030").replace("DTEND:20261030T150000Z", "DTEND;VALUE=DATE:20261102");
    const label = formatInvitationWhen(parseInvitations(source)[0]);
    expect(label).toContain("Nov 1");
    expect(label).not.toContain("Nov 2");
  });
  it("knows when a meeting has passed, including the last occurrence of a series", () => {
    const at = (iso: string) => Date.parse(iso);
    const [single] = parseInvitations(calendar(), new Set(), at("2026-10-30T14:30:00Z"));
    expect(single.passed).toBe(false);
    expect(single.next).toEqual({ start: at("2026-10-30T14:00:00Z"), end: at("2026-10-30T15:00:00Z") });
    expect(parseInvitations(calendar(), new Set(), at("2026-10-30T15:00:01Z"))[0].passed).toBe(true);
    // A weekly series with three occurrences: past the first, the next one is a week later.
    const weekly = calendar("REQUEST", "RRULE:FREQ=WEEKLY;COUNT=3\r\n");
    const [series] = parseInvitations(weekly, new Set(), at("2026-10-31T00:00:00Z"));
    expect(series.passed).toBe(false);
    expect(series.next?.start).toBe(at("2026-11-06T14:00:00Z"));
    expect(parseInvitations(weekly, new Set(), at("2026-11-14T00:00:00Z"))[0].passed).toBe(true);
    expect(parseInvitations(calendar("REQUEST", "RRULE:FREQ=DAILY\r\n"), new Set(), at("2031-01-01T00:00:00Z"))[0].passed).toBe(false);
    // Named zone without a VTIMEZONE: the wall time is read in that zone.
    const named = calendar().replace("DTSTART:20261030T140000Z", "DTSTART;TZID=America/New_York:20261030T100000").replace("DTEND:20261030T150000Z", "DTEND;TZID=America/New_York:20261030T110000");
    expect(parseInvitations(named, new Set(), 0)[0].next).toEqual({ start: at("2026-10-30T14:00:00Z"), end: at("2026-10-30T15:00:00Z") });
  });
  it("finds the join link Teams, Zoom and Meet put in the calendar", () => {
    const teams = "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%7d";
    expect(parseInvitations(calendar("REQUEST", `X-MICROSOFT-SKYPETEAMSMEETINGURL:${teams}\r\n`))[0].join).toEqual({ url: teams, label: "Teams" });
    const zoom = calendar().replace("DESCRIPTION:Review the deck\\nBring the budget.", "DESCRIPTION:Join Zoom Meeting\\nhttps://northwind.zoom.us/j/123456789?pwd=abc>\\n\\nMeeting ID: 123");
    expect(parseInvitations(zoom)[0].join).toEqual({ url: "https://northwind.zoom.us/j/123456789?pwd=abc", label: "Zoom" });
    expect(parseInvitations(calendar().replace("LOCATION:Room 4B", "LOCATION:https://meet.google.com/abc-defg-hij"))[0].join?.label).toBe("Google Meet");
    expect(parseInvitations(calendar())[0].join).toBeNull();
    expect(findJoinLink("Docs: https://docs.zoom.us/j/123 and host link https://x.zoom.us/s/999")).toBeNull();
    const safe = "https://nam12.safelinks.protection.outlook.com/?url=" + encodeURIComponent("https://teams.microsoft.com/meet/123?p=xyz") + "&data=1";
    expect(findJoinLink(`Join: <${safe}>`)).toEqual({ url: "https://teams.microsoft.com/meet/123?p=xyz", label: "Teams" });
  });
  it("reads who replied and how", () => {
    const reply = calendar("REPLY").replace("ATTENDEE;CN=Merritt;PARTSTAT=TENTATIVE:mailto:me@work.org", "ATTENDEE;CN=Chris Okafor;PARTSTAT=DECLINED:mailto:chris@work.org\r\nCOMMENT:Out that week");
    const [event] = parseInvitations(reply);
    expect(event.replier).toEqual({ name: "Chris Okafor", email: "chris@work.org", response: "DECLINED" });
    expect(event.comment).toBe("Out that week");
  });
  it("recognizes response subjects and tallies them", () => {
    expect(responseSubject("Accepted: Last day in office")).toEqual({ response: "ACCEPTED", title: "Last day in office" });
    expect(responseSubject("Tentative: Weekly sync")).toEqual({ response: "TENTATIVE", title: "Weekly sync" });
    expect(responseSubject("Declined with comment: Team sync")).toEqual({ response: "DECLINED", title: "Team sync" });
    expect(responseSubject("Accepted: Team sync @ Wed Oct 28, 2026 1pm - 2pm (EDT) (merritt@example.org)")?.title).toBe("Team sync");
    expect(responseSubject("Re: Accepted: offer letter")).toBeNull();
    expect(responseSubject("Last day in office")).toBeNull();
    expect(responseTally(["Accepted: A", "Declined: A", "Accepted: A", "Tentative: A"])).toBe("2 accepted · 1 maybe · 1 declined");
    expect(inviteTitle("Updated invitation: Team sync @ Wed Oct 28, 2026 1pm - 2pm (EDT) (merritt@example.org)")).toBe("Team sync");
    expect(inviteTitle("FW: Language Data Standardization")).toBe("Language Data Standardization");
  });
  it("rejects malformed/oversized calendars for the native fallback", () => {
    expect(() => parseInvitations("Not a calendar")).toThrow();
    expect(() => parseInvitations("x".repeat(1024 * 1024 + 1))).toThrow("too large");
  });
});
