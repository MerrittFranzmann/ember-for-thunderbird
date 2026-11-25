// Meeting reminders in the background: every 15 minutes (and when the setting or an answer changes)
// read the next day of the user's Exchange calendars (Thunderbird reminds of its own), set an alarm per reminder, and show a
// notification when it fires. Clicking it joins the call, or opens Ember when there's no link.
import { LATE_LIMIT, planReminders, reminderMessage, type Reminder } from "./reminders";
import { briefMail, briefSummary, planBriefs, startsIn, type MeetingBrief } from "./meeting-brief";
import type { MessageHeader } from "./types";
import { errorLog } from "./error-log";
import { calendarErrorText } from "./meeting-status";

const PREFIX = "spark-remind:";
/** "Before your meeting" (meeting-brief.ts): ten minutes before, recent email with the people in it. */
const BRIEF = "spark-brief:";
const REFRESH = "spark-reminders";
const DAY = 86400000;

export class ReminderService {
  constructor(private native: any, private openApp: () => Promise<unknown>, private mail: () => Promise<MessageHeader[]> = async () => []) {}

  private get available() { return typeof this.native.sparkCalendar?.calendarView === "function" && !!this.native.notifications; }
  private async read<T>(key: string, fallback: T): Promise<T> { return ((await this.native.storage.local.get({ [key]: fallback })) as any)[key]; }

  /** Each background start: keep the 15-minute refresh, and refresh unless one ran in the last 10 minutes
   *  (Thunderbird wakes the background every few minutes). */
  async start() {
    if (!this.available) return;
    if (!(await this.native.alarms.get(REFRESH))) await this.native.alarms.create(REFRESH, { periodInMinutes: 15 });
    if (Date.now() - await this.read("reminderRefreshedAt", 0) > 10 * 60000) await this.refresh();
  }

  async refresh() {
    if (!this.available) return;
    const setting = await this.read("meetingReminder", 5);
    const briefs = await this.read("meetingBrief", true);
    const now = Date.now();
    await this.native.storage.local.set({ reminderRefreshedAt: now });
    let plan: Reminder[] = [];
    let events: any[] = [];
    if (setting || briefs) {
      try {
        const view = await this.native.sparkCalendar.calendarView(new Date(now - LATE_LIMIT).toISOString(), new Date(now + DAY).toISOString(), { details: true });
        if (view.errors?.length) errorLog.add(`calendar: ${calendarErrorText(view.errors)}`);
        // No calendar could be read: keep the alarms already set rather than dropping them.
        if (view.accounts && view.errors.length >= view.accounts) return;
        events = view.events;
        // Thunderbird's own calendars (Google's and others) already have Thunderbird's reminders: not twice.
        plan = planReminders(events.filter((e: any) => !String(e.accountId || "").startsWith("cal:")), now, setting);
      } catch (e: any) { errorLog.add(`calendar: ${e?.message || e}`); return; }
    }
    await this.planBriefs(briefs ? planBriefs(events, now, await this.myAddresses()) : [], now);
    const shown = await this.read<Record<string, number>>("reminderShown", {});
    const next: Record<string, Reminder> = Object.fromEntries(plan.map((reminder) => [reminder.key, reminder]));
    await this.native.storage.local.set({ reminderPlan: next });
    for (const alarm of await this.native.alarms.getAll()) {
      if (alarm.name.startsWith(PREFIX) && !next[alarm.name.slice(PREFIX.length)]) await this.native.alarms.clear(alarm.name);
    }
    for (const reminder of plan) {
      if (shown[reminder.key]) continue;
      // Already due (Ember started late, or the meeting was just added): remind now.
      if (reminder.at <= now) await this.notify(reminder);
      else await this.native.alarms.create(PREFIX + reminder.key, { when: reminder.at });
    }
    // Forget reminders shown more than two days ago.
    const kept = Object.fromEntries(Object.entries(await this.read<Record<string, number>>("reminderShown", {})).filter(([, at]) => now - at < 2 * DAY));
    await this.native.storage.local.set({ reminderShown: kept });
  }

  private async myAddresses(): Promise<Set<string>> {
    const accounts = await Promise.resolve(this.native.accounts?.list?.()).catch(() => []) || [];
    return new Set(accounts.flatMap((account: any) => (account.identities || []).map((identity: any) => String(identity.email || "").toLowerCase())).filter(Boolean));
  }

  private async planBriefs(plan: (MeetingBrief & { at: number })[], now: number) {
    const next = Object.fromEntries(plan.map((brief) => [brief.key, brief]));
    await this.native.storage.local.set({ briefPlan: next });
    for (const alarm of await this.native.alarms.getAll()) {
      if (alarm.name.startsWith(BRIEF) && !next[alarm.name.slice(BRIEF.length)]) await this.native.alarms.clear(alarm.name);
    }
    const shown = await this.read<Record<string, number>>("briefShown", {});
    for (const brief of plan) {
      if (shown[brief.key]) continue;
      if (brief.at <= now) await this.brief(brief);
      else await this.native.alarms.create(BRIEF + brief.key, { when: brief.at });
    }
    await this.native.storage.local.set({ briefShown: Object.fromEntries(Object.entries(await this.read<Record<string, number>>("briefShown", {})).filter(([, at]) => now - at < 2 * DAY)) });
  }

  /** The notification, when there is recent email with the meeting's people (none: nothing to show). */
  private async brief(brief: MeetingBrief) {
    const shown = await this.read<Record<string, number>>("briefShown", {});
    if (shown[brief.key] || Date.now() >= brief.start) return;
    const now = Date.now();
    const mail = briefMail(await this.mail(), brief, now);
    await this.native.storage.local.set({ briefShown: { ...shown, [brief.key]: now } });
    if (!mail.length) return;
    const time = new Date(brief.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    await this.native.notifications.create(BRIEF + brief.key, { type: "basic", title: `Before ${brief.subject}`, message: `${startsIn(brief.start, now)} (${time})\n${briefSummary(brief, mail)}. Click to see them.` });
  }

  /** Returns true when the alarm was a reminder's. */
  async alarm(name: string): Promise<boolean> {
    if (name === REFRESH) { await this.refresh(); return true; }
    if (name.startsWith(BRIEF)) {
      const brief = (await this.read<Record<string, MeetingBrief>>("briefPlan", {}))[name.slice(BRIEF.length)];
      if (brief && await this.read("meetingBrief", true)) await this.brief(brief);
      return true;
    }
    if (!name.startsWith(PREFIX)) return false;
    const reminder = (await this.read<Record<string, Reminder>>("reminderPlan", {}))[name.slice(PREFIX.length)];
    if (reminder && Date.now() < reminder.start + LATE_LIMIT) await this.notify(reminder);
    return true;
  }

  private async notify(reminder: Reminder) {
    const shown = await this.read<Record<string, number>>("reminderShown", {});
    if (shown[reminder.key]) return;
    await this.native.storage.local.set({ reminderShown: { ...shown, [reminder.key]: Date.now() } });
    await this.native.notifications.create(PREFIX + reminder.key, { type: "basic", title: reminder.subject, message: reminderMessage(reminder, Date.now()) });
  }

  /** A notification was clicked; returns true when it was a reminder. */
  async clicked(id: string): Promise<boolean> {
    if (id.startsWith(BRIEF)) {
      const brief = (await this.read<Record<string, MeetingBrief>>("briefPlan", {}))[id.slice(BRIEF.length)];
      void this.native.notifications.clear(id);
      // Through storage, so an Ember window that is still opening picks it up too.
      if (brief) await this.native.storage.local.set({ sparkOpenBrief: { brief, at: Date.now() } });
      await this.openApp();
      return true;
    }
    if (!id.startsWith(PREFIX)) return false;
    const reminder = (await this.read<Record<string, Reminder>>("reminderPlan", {}))[id.slice(PREFIX.length)];
    void this.native.notifications.clear(id);
    if (reminder?.join && typeof this.native.windows?.openDefaultBrowser === "function") await this.native.windows.openDefaultBrowser(reminder.join.url);
    else await this.openApp();
    return true;
  }
}
