// Calendar responses (iMIP, RFC 6047): the reply calendar Thunderbird's own Accept / Tentative /
// Decline sends for non-Exchange accounts. The calendar Experiment (public/experiments/calendar)
// sends it in Thunderbird's MIME format; Exchange mailboxes answer on the server instead.
import ICAL from "ical.js";

export type Partstat = "ACCEPTED" | "TENTATIVE" | "DECLINED";
export const PARTSTAT_LABEL: Record<Partstat, string> = { ACCEPTED: "Accepted", TENTATIVE: "Tentative", DECLINED: "Declined" };

const mailto = (value: unknown) => String(value || "").replace(/^mailto:/i, "").toLowerCase();

/** Build the METHOD:REPLY calendar for one event of an invitation. */
export function buildReply(invitationIcs: string, uid: string, recurrenceId: string, attendee: { email: string; name?: string }, partstat: Partstat, now = new Date(), comment = ""): string {
  const source = new ICAL.Component(ICAL.parse(invitationIcs));
  const event = source.getAllSubcomponents("vevent").find((e) => String(e.getFirstPropertyValue("uid")) === uid && String(e.getFirstPropertyValue("recurrence-id") || "") === recurrenceId);
  if (!event) throw new Error("This invitation's event couldn't be found.");
  const reply = new ICAL.Component(["vcalendar", [], []]);
  reply.addPropertyWithValue("prodid", "-//Ember for Thunderbird//EN");
  reply.addPropertyWithValue("version", "2.0");
  reply.addPropertyWithValue("method", "REPLY");
  // Timezone definitions the copied times refer to.
  const zones = new Set(["dtstart", "dtend", "recurrence-id"].map((name) => event.getFirstProperty(name)?.getParameter("tzid")).filter(Boolean).map(String));
  for (const tz of source.getAllSubcomponents("vtimezone")) if (zones.has(String(tz.getFirstPropertyValue("tzid")))) reply.addSubcomponent(new ICAL.Component(tz.toJSON()));
  const out = new ICAL.Component("vevent");
  for (const name of ["uid", "sequence", "recurrence-id", "dtstart", "dtend", "duration", "summary", "location", "organizer"]) {
    const property = event.getFirstProperty(name);
    if (property) out.addProperty(new ICAL.Property(property.toJSON()));
  }
  out.addPropertyWithValue("dtstamp", ICAL.Time.fromJSDate(now, true));
  // Only the responder's own attendee line, with the new participation status.
  const original = event.getAllProperties("attendee").find((p) => mailto(p.getFirstValue()) === attendee.email.toLowerCase());
  const line = original ? new ICAL.Property(original.toJSON()) : new ICAL.Property("attendee");
  if (!original) { line.setValue(`mailto:${attendee.email}`); if (attendee.name) line.setParameter("cn", attendee.name); }
  line.removeParameter("rsvp");
  line.setParameter("partstat", partstat);
  out.addProperty(line);
  if (comment.trim()) out.addPropertyWithValue("comment", comment.trim());
  reply.addSubcomponent(out);
  return reply.toString();
}

/** Which of the user's addresses the invitation was sent to (its ATTENDEE line), if any. */
export function invitedAddress(invitationIcs: string, uid: string, me: Set<string>): string | undefined {
  const source = new ICAL.Component(ICAL.parse(invitationIcs));
  for (const event of source.getAllSubcomponents("vevent")) {
    if (String(event.getFirstPropertyValue("uid")) !== uid) continue;
    for (const p of event.getAllProperties("attendee")) { const email = mailto(p.getFirstValue()); if (me.has(email)) return email; }
  }
  return undefined;
}

export function replySubject(partstat: Partstat, title: string) { return `${PARTSTAT_LABEL[partstat]}: ${title}`; }
export function replyText(partstat: Partstat, name: string, note = "") {
  const text = `${name} has ${partstat === "ACCEPTED" ? "accepted" : partstat === "DECLINED" ? "declined" : "tentatively accepted"} this invitation.`;
  return note.trim() ? `${text}\n\n${note.trim()}` : text;
}
