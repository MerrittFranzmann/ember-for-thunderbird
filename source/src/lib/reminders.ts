// Meeting reminders: which of the next day's meetings get a notification, and when. Pure; unit-tested.
// The background (src/background.ts) turns the plan into alarms and notifications.
import { agendaItems, findJoinLink, type CalendarEvent } from "./meeting-status";

/** The setting: minutes before a meeting, 0 for off, -1 for "as set in Outlook". */
export type ReminderSetting = number;
export interface Reminder {
  key: string;
  /** When to notify (ms). */
  at: number;
  subject: string;
  start: number;
  end: number;
  location: string;
  join: { url: string; label: string } | null;
}

/** A reminder that fires this late after the meeting started is no longer useful. */
export const LATE_LIMIT = 10 * 60000;

export function planReminders(events: CalendarEvent[], now: number, setting: ReminderSetting): Reminder[] {
  if (!setting) return [];
  const plan: Reminder[] = [];
  for (const event of agendaItems(events, now)) {
    if (event.allDay) continue;
    const start = Date.parse(event.start), end = Date.parse(event.end);
    if (!(start > now - LATE_LIMIT)) continue;
    // "As set in Outlook": the meeting's own reminder (none if it has none); 15 min when Exchange didn't say.
    const minutes = setting > 0 ? setting : event.reminder === -1 ? -1 : event.reminder ?? 15;
    if (minutes < 0) continue;
    plan.push({
      key: `${event.uid || event.id}|${event.start}`,
      at: start - minutes * 60000,
      subject: event.subject || "Meeting",
      start, end,
      location: event.location,
      join: findJoinLink(event.location, event.body || ""),
    });
  }
  return plan;
}

/** The notification text: "Starts at 1:30 PM (in 5 min) · Room 2", and how to join. */
export function reminderMessage(reminder: Reminder, now: number): string {
  const time = new Date(reminder.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const minutes = Math.round((reminder.start - now) / 60000);
  const when = minutes > 0 ? `Starts at ${time} (in ${minutes} min)` : minutes === 0 ? `Starts now (${time})` : `Started ${-minutes} min ago (${time})`;
  const where = reminder.location && !/^https?:\/\//i.test(reminder.location) ? ` · ${reminder.location}` : "";
  return `${when}${where}\n${reminder.join ? `Click to join on ${reminder.join.label}` : "Click to open Ember"}`;
}
