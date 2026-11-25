// Today's meetings (sparkCalendar Experiment), shared by Today in the sidebar and the "Before your
// meeting" strip above the inbox. Agenda.svelte decides when to read them.
import { api } from "./api";
import { errorLog } from "./error-log";
import { calendarErrorText, mergeAgenda, type CalendarError, type CalendarEvent } from "./meeting-status";

/** Read again sooner after a failure (one Exchange hiccup shouldn't leave "Couldn't read" for five minutes). */
export const RETRY_MS = 60000;
export const REFRESH_MS = 5 * 60000;

class AgendaState {
  readonly available = typeof api?.sparkCalendar?.calendarView === "function";
  accounts = $state(0);
  events = $state<CalendarEvent[]>([]);
  /** No calendar could be read this time (the events shown, if any, are from before). */
  failed = $state(false);
  /** What went wrong, for the tooltip ("" when all could be read). */
  error = $state("");
  loaded = $state(false);
  /** Ticks every 30 s while Ember is visible (Agenda.svelte). */
  now = $state(Date.now());
  /** Briefs the user closed above the inbox (meeting keys), this session. */
  dismissed = $state<string[]>([]);
  day = "";
  last = 0;
  private pending = false;

  /** Due for another read: five minutes after a good one, one minute after a failed one, and at midnight. */
  stale(now = this.now) {
    return now - this.last > (this.failed || this.error ? RETRY_MS : REFRESH_MS) || new Date(now).toDateString() !== this.day;
  }

  async load() {
    if (!this.available || this.pending) return;
    this.pending = true;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(start); end.setDate(end.getDate() + 2); // today and tomorrow
    const sameDay = this.day === start.toDateString();
    try {
      const view = await api.sparkCalendar.calendarView(start.toISOString(), end.toISOString(), { details: true });
      const errors: CalendarError[] = view.errors || [];
      this.accounts = view.accounts;
      this.events = sameDay ? mergeAgenda(this.events, view.events, errors) : view.events;
      this.failed = view.accounts > 0 && errors.length >= view.accounts;
      this.error = calendarErrorText(errors);
      // Kept for later (ember_status, performance reports): the reason was invisible before.
      if (errors.length) errorLog.add(`calendar: ${this.error}`);
    } catch (e: any) {
      this.failed = true;
      this.error = String(e?.message || e);
      errorLog.add(`calendar: ${this.error}`);
    } finally { this.pending = false; this.loaded = true; this.last = Date.now(); this.day = start.toDateString(); }
  }
}

export const agenda = new AgendaState();
