// Whether an email carries a calendar invitation, without loading the iCalendar parser (ical.js):
// the reader checks every email, and only those with one load InvitationCard and the parser.
import type { MessageAttachment, MessagePart } from "./types";

export function calendarBodies(root: MessagePart): string[] {
  const result: string[] = [];
  const walk = (part: MessagePart) => {
    // getFull's root is the message itself (message/rfc822); only skip forwarded messages inside it.
    if (part !== root && (part.contentType || "").toLowerCase().startsWith("message/rfc822")) return;
    if ((part.contentType || "").toLowerCase().startsWith("text/calendar") && part.body?.trim()) result.push(part.body);
    for (const child of part.parts || []) walk(child);
  };
  walk(root);
  return result;
}

export function isCalendarFile(attachment: MessageAttachment): boolean {
  return /^(text\/calendar|application\/ics)/i.test(attachment.contentType) || /\.ics$/i.test(attachment.name);
}

export function hasInvitation(full: MessagePart, attachments: MessageAttachment[]): boolean {
  return calendarBodies(full).length > 0 || attachments.some(isCalendarFile);
}
