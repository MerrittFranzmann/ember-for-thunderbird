import { describe, expect, it } from "vitest";
import ICAL from "ical.js";
import { buildReply, invitedAddress, replySubject, replyText } from "../src/lib/rsvp";

const invite = [
  "BEGIN:VCALENDAR", "METHOD:REQUEST", "PRODID:Microsoft Exchange Server 2010", "VERSION:2.0",
  "BEGIN:VTIMEZONE", "TZID:Eastern Standard Time", "BEGIN:STANDARD", "DTSTART:16010101T020000", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11", "END:STANDARD", "BEGIN:DAYLIGHT", "DTSTART:16010101T020000", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3", "END:DAYLIGHT", "END:VTIMEZONE",
  "BEGIN:VTIMEZONE", "TZID:Unused Zone", "BEGIN:STANDARD", "DTSTART:16010101T000000", "TZOFFSETFROM:+0000", "TZOFFSETTO:+0000", "END:STANDARD", "END:VTIMEZONE",
  "BEGIN:VEVENT", "ORGANIZER;CN=Dana Whitfield:mailto:dana@northwind.example",
  "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Alex Morgan:mailto:Alex.Morgan@northwind.example",
  "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Someone Else:mailto:other@northwind.example",
  "SUMMARY;LANGUAGE=en-US:Open Enrollment Event", "DTSTART;TZID=Eastern Standard Time:20271104T100000", "DTEND;TZID=Eastern Standard Time:20271104T110000",
  "UID:040000008200E00074C5B7101A82E008000000004A", "SEQUENCE:2", "LOCATION:Board Room", "DTSTAMP:20271027T172300Z", "END:VEVENT", "END:VCALENDAR", "",
].join("\r\n");

describe("calendar responses", () => {
  it("builds a standards REPLY with only the responder, the new status and the needed timezone", () => {
    const me = invitedAddress(invite, "040000008200E00074C5B7101A82E008000000004A", new Set(["alex.morgan@northwind.example"]));
    expect(me).toBe("alex.morgan@northwind.example");
    const reply = new ICAL.Component(ICAL.parse(buildReply(invite, "040000008200E00074C5B7101A82E008000000004A", "", { email: me! }, "ACCEPTED", new Date("2027-10-28T12:00:00Z"))));
    expect(reply.getFirstPropertyValue("method")).toBe("REPLY");
    expect(reply.getAllSubcomponents("vtimezone").map((z) => z.getFirstPropertyValue("tzid"))).toEqual(["Eastern Standard Time"]);
    const event = reply.getFirstSubcomponent("vevent")!;
    expect(event.getFirstPropertyValue("uid")).toBe("040000008200E00074C5B7101A82E008000000004A");
    expect(event.getFirstPropertyValue("sequence")).toBe(2);
    expect(String(event.getFirstPropertyValue("organizer"))).toBe("mailto:dana@northwind.example");
    const attendees = event.getAllProperties("attendee");
    expect(attendees).toHaveLength(1);
    expect(attendees[0].getParameter("partstat")).toBe("ACCEPTED");
    expect(attendees[0].getParameter("rsvp")).toBeUndefined();
    expect(attendees[0].getParameter("cn")).toBe("Alex Morgan");
    expect(replySubject("ACCEPTED", "Open Enrollment Event")).toBe("Accepted: Open Enrollment Event");
  });
  it("adds the responder when the invitation went to a list, and refuses an unknown event", () => {
    const reply = new ICAL.Component(ICAL.parse(buildReply(invite, "040000008200E00074C5B7101A82E008000000004A", "", { email: "list-member@northwind.example", name: "Merritt" }, "DECLINED")));
    const line = reply.getFirstSubcomponent("vevent")!.getFirstProperty("attendee")!;
    expect(String(line.getFirstValue())).toBe("mailto:list-member@northwind.example");
    expect(line.getParameter("partstat")).toBe("DECLINED");
    expect(() => buildReply(invite, "missing", "", { email: "a@b.c" }, "ACCEPTED")).toThrow();
    const noted = new ICAL.Component(ICAL.parse(buildReply(invite, "040000008200E00074C5B7101A82E008000000004A", "", { email: "a@b.c" }, "TENTATIVE", new Date(), "Running 5 min late")));
    expect(noted.getFirstSubcomponent("vevent")!.getFirstPropertyValue("comment")).toBe("Running 5 min late");
    expect(replyText("TENTATIVE", "Merritt", " Running late ")).toBe("Merritt has tentatively accepted this invitation.\n\nRunning late");
  });
});
