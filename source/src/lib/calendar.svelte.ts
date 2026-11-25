// The Calendar page's state: which calendars Ember can reach (Exchange, and Thunderbird's own calendars such as
// Google's, through the sparkCalendar Experiment),
// the events of the range on screen, the open event's details, and answering invitations. CalendarPage.svelte
// and CalendarSide.svelte draw it; calendar-grid.ts does the geometry.
import { api, mailCache } from "./api";
import { splitAddrs } from "./format";
import { errorLog } from "./error-log";
import { calendarErrorText, exchangeConfirmed, mergeAgenda, shownOnCalendar, type CalendarError, type CalendarEvent } from "./meeting-status";
import { addDays, CALENDAR_COLORS, eventKey, firstWeekday, rangeFor, startOfDay, step, type CalendarMode } from "./calendar-grid";
import { store } from "./store.svelte";
import type { PersonBusy } from "./find-time";
import { draftChanges, draftProblem, localTime, toEwsEvent, windowsZone, type EventDraft } from "./calendar-edit";

/** A calendar Ember can reach: an Exchange account's main one (accountId: the account), or one of Thunderbird's own
 *  calendars ("thunderbird": Google and other CalDAV calendars, subscriptions, local ones; accountId "cal:…"). */
export interface CalendarInfo { accountId: string; name: string; email: string; kind?: "exchange" | "thunderbird"; group?: string; color?: string; readOnly?: boolean; google?: boolean }
/** A mail account (not Exchange) whose calendars Thunderbird could connect. */
export interface Connectable { accountId: string; name: string; email: string; google: boolean; connected: boolean }
/** A calendar besides an account's main one: an extra calendar in the user's mailbox ("folder"), or a person's or
 *  group's calendar ("person": from the Outlook calendar list, or `added` here). Read-only on the page. */
export interface OtherCalendar { key: string; accountId: string; kind: "folder" | "person"; name: string; email?: string; folderId?: string; group?: string; added?: boolean }
interface SharedAnswer { events: CalendarEvent[]; errors: { key: string; message: string }[]; access: Record<string, "full" | "busy"> }
export interface Attendee { name: string; email: string; role?: string; response?: string }
export type EventDetails = CalendarEvent & { body: string; attendees: Attendee[]; changeKey?: string; type?: string; isMeeting?: boolean };
export type Response = "accept" | "tentative" | "decline";

/** A range read this long ago is shown at once and read again in the background. */
const FRESH_MS = 2 * 60000;
const RETRY_MS = 60000;

/** A person's name as their saved email shows it ("" when none does). */
export function nameFromMail(email: string): string {
  const wanted = email.toLowerCase();
  for (const m of mailCache.all()) {
    for (const raw of [m.author, ...(m.recipients || []), ...(m.ccList || [])]) for (const a of splitAddrs(raw)) if (a.name && a.email.toLowerCase() === wanted) return a.name;
  }
  return "";
}

class CalendarState {
  readonly available = typeof api?.sparkCalendar?.calendarView === "function";
  /** The calendars Ember can reach (each Exchange account's, then Thunderbird's own). */
  calendars = $state<CalendarInfo[]>([]);
  calendarsLoaded = $state(false);
  mode = $state<CalendarMode>("week");
  /** A local midnight inside what's shown. */
  anchor = $state(startOfDay(Date.now()).getTime());
  readonly firstDay = firstWeekday();
  /** The shown range's events (every calendar; the page leaves out hidden ones). */
  events = $state<CalendarEvent[]>([]);
  loading = $state(false);
  /** What went wrong reading the calendars ("" when all could be read), and whether none could. */
  error = $state("");
  failed = $state(false);
  /** Ticks every 30 s while the page is visible (the red "now" line). */
  now = $state(Date.now());
  /** The open event (eventKey) and its details as Exchange gives them. */
  selected = $state<string | null>(null);
  details = $state<Record<string, EventDetails | { error: string }>>({});
  /** The answer being sent for the open event. */
  answering = $state<Response | "">("");
  private ranges = new Map<string, { events: CalendarEvent[]; own: CalendarEvent[]; shared: CalendarEvent[]; at: number; failed: boolean }>();
  private token = 0;

  range(mode = this.mode, anchor = this.anchor) { return rangeFor(mode, anchor, this.firstDay); }

  async loadCalendars() {
    if (!this.available || typeof api.sparkCalendar.calendars !== "function") { this.calendarsLoaded = true; return; }
    try { this.calendars = await api.sparkCalendar.calendars(); }
    catch (e: any) { errorLog.add(`calendar: list: ${String(e?.message || e)}`); }
    finally { this.calendarsLoaded = true; }
    void this.loadOthers();
    void this.loadConnectable();
  }
  /** Exchange calendars (shared calendars and availability of colleagues go through them). */
  get exchange(): CalendarInfo[] { return this.calendars.filter((c) => c.kind !== "thunderbird"); }
  /** Calendars new events can go on. */
  get writable(): CalendarInfo[] { return this.calendars.filter((c) => !c.readOnly); }
  isThunderbird(key: string) { return key.startsWith("cal:"); }

  // ---- Connecting a mail account's calendars (Google's, or another provider's CalDAV) ----
  connectable = $state<Connectable[]>([]);
  connecting = $state("");
  async loadConnectable() {
    if (typeof api?.sparkCalendar?.connectable !== "function") return;
    try { this.connectable = await api.sparkCalendar.connectable(); }
    catch (e: any) { errorLog.add(`calendar: accounts: ${String(e?.message || e)}`); }
  }
  /** Find the account's calendars and add them to Thunderbird (Google asks to sign in when it hasn't yet). */
  async connect(accountId: string): Promise<{ ok: boolean; message: string }> {
    if (this.connecting) return { ok: false, message: "" };
    this.connecting = accountId;
    const name = this.connectable.find((a) => a.accountId === accountId)?.name || "this account";
    try {
      const result: { added: string[]; found: number } = await api.sparkCalendar.connectCalendars(accountId);
      await this.loadCalendars();
      this.changed();
      if (result.added.length) return { ok: true, message: `Added ${result.added.length === 1 ? `“${result.added[0]}”` : `${result.added.length} calendars`} from ${name}` };
      return { ok: true, message: `${name}'s calendars are already in Thunderbird` };
    } catch (e: any) {
      const message = String(e?.message || e);
      // Nothing to find there (a provider without calendars): stop offering it.
      if (/none were found/.test(message)) await this.hideConnect(accountId);
      return { ok: false, message };
    } finally { this.connecting = ""; }
  }
  /** Accounts still offered "Connect calendars": not connected, not put away. */
  get toConnect(): Connectable[] {
    const hidden = new Set(store.settings.calendarConnectHidden || []);
    return this.connectable.filter((a) => !a.connected && !hidden.has(a.accountId));
  }
  async hideConnect(accountId: string) {
    const hidden = store.settings.calendarConnectHidden || [];
    if (!hidden.includes(accountId)) await store.setSetting("calendarConnectHidden", [...hidden, accountId]);
  }

  // ---- Other calendars (shared with the user, and their own extra ones) ----
  /** Found in the user's mailboxes (their extra calendars, and their Outlook calendar list). */
  found = $state<OtherCalendar[]>([]);
  othersLoaded = $state(false);
  /** How much of each shown other calendar Exchange lets the user see, and what went wrong reading one. */
  access = $state<Record<string, "full" | "busy">>({});
  otherErrors = $state<Record<string, string>>({});
  private othersLoading: Promise<void> | null = null;
  get canShare() { return typeof api?.sparkCalendar?.sharedView === "function"; }
  loadOthers(): Promise<void> {
    if (!this.canShare || typeof api.sparkCalendar.otherCalendars !== "function") { this.othersLoaded = true; return Promise.resolve(); }
    this.othersLoading ||= (async () => {
      try {
        const answer: { calendars: OtherCalendar[]; errors: string[] } = await api.sparkCalendar.otherCalendars();
        this.found = answer.calendars || [];
        for (const error of answer.errors || []) errorLog.add(`calendar: other calendars: ${error}`);
      } catch (e: any) { errorLog.add(`calendar: other calendars: ${String(e?.message || e)}`); }
      finally { this.othersLoaded = true; }
      // Shown ones found just now are read with the range.
      if (this.shownOthers().length) void this.load(true);
    })();
    return this.othersLoading;
  }
  /** Every other calendar: those found, then the people the user added (each once). */
  get others(): OtherCalendar[] {
    const added: OtherCalendar[] = (store.settings.calendarPeople || []).map((p) => ({ key: `${p.accountId}|${p.email.toLowerCase()}`, accountId: p.accountId, kind: "person", name: p.name || p.email, email: p.email.toLowerCase(), added: true }));
    const keys = new Set(this.found.map((c) => c.key));
    return [...this.found, ...added.filter((c) => !keys.has(c.key))];
  }
  shownOthers(): OtherCalendar[] {
    const shown = new Set(store.settings.calendarShown || []);
    return this.others.filter((c) => shown.has(c.key));
  }
  /** Calendars not drawn: main ones the user unticked, and other ones they haven't ticked. */
  hiddenKeys(): Set<string> {
    const shown = new Set(store.settings.calendarShown || []);
    return new Set([...(store.settings.calendarHidden || []), ...this.others.filter((c) => !shown.has(c.key)).map((c) => c.key)]);
  }
  isShown(key: string): boolean {
    return this.calendars.some((c) => c.accountId === key) ? !(store.settings.calendarHidden || []).includes(key) : (store.settings.calendarShown || []).includes(key);
  }
  async toggle(key: string) {
    if (this.calendars.some((c) => c.accountId === key)) {
      const hidden = store.settings.calendarHidden || [];
      await store.setSetting("calendarHidden", hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key]);
      return;
    }
    const shown = store.settings.calendarShown || [];
    await store.setSetting("calendarShown", shown.includes(key) ? shown.filter((k) => k !== key) : [...shown, key]);
    void this.load();
  }
  /** Add a person's (or group's) calendar by address, read through the account it best belongs with. */
  async addPerson(email: string, name: string): Promise<string> {
    const address = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(address)) throw new Error("Type an email address.");
    if (!this.calendarsLoaded) await this.loadCalendars();
    const domain = address.split("@")[1];
    const accountId = this.exchange.find((c) => c.email.toLowerCase().endsWith(`@${domain}`))?.accountId || this.exchange[0]?.accountId;
    if (!accountId) throw new Error("Ember reads shared calendars through an Exchange account, and none is set up in Thunderbird.");
    const key = `${accountId}|${address}`;
    const people = $state.snapshot(store.settings.calendarPeople || []);
    if (!people.some((p) => `${p.accountId}|${p.email.toLowerCase()}` === key) && !this.found.some((c) => c.key === key)) {
      await store.setSetting("calendarPeople", [...people, { accountId, email: address, name: name.trim() || nameFromMail(address) }]);
    }
    const shown = store.settings.calendarShown || [];
    if (!shown.includes(key)) await store.setSetting("calendarShown", [...shown, key]);
    void this.load();
    return key;
  }
  /** Take a calendar the user added off the list. */
  async removePerson(key: string) {
    const people = $state.snapshot(store.settings.calendarPeople || []);
    await store.setSetting("calendarPeople", people.filter((p) => `${p.accountId}|${p.email.toLowerCase()}` !== key));
    await store.setSetting("calendarShown", (store.settings.calendarShown || []).filter((k) => k !== key));
    this.events = this.events.filter((e) => e.calendarId !== key);
  }
  /** A calendar's colour: main calendars by their account's place (like the sidebar's account dots), Thunderbird's
   *  in the colour Thunderbird gives them, the others after. */
  colorOf(key: string): string {
    const own = this.isThunderbird(key) ? this.calendars.find((c) => c.accountId === key) : undefined;
    if (own?.color && /^#[0-9a-f]{3,8}$/i.test(own.color)) return own.color;
    if (own) return CALENDAR_COLORS[(store.accounts.length + this.calendars.indexOf(own)) % CALENDAR_COLORS.length];
    const account = store.accounts.findIndex((a) => a.account.id === key);
    if (account >= 0) return CALENDAR_COLORS[account % CALENDAR_COLORS.length];
    const other = this.others.findIndex((c) => c.key === key);
    if (other < 0) return CALENDAR_COLORS[0];
    return CALENDAR_COLORS[(store.accounts.length + other) % CALENDAR_COLORS.length];
  }
  /** "Work" for a main calendar, "Priya Shah" for a shared one, "Family" for one of Thunderbird's. */
  nameOf(key: string): string {
    if (this.isThunderbird(key)) return this.calendars.find((c) => c.accountId === key)?.name || "Calendar";
    return this.others.find((c) => c.key === key)?.name || store.accountName(key) || "Calendar";
  }
  /** The name to pick a calendar by: the account for an Exchange calendar, "Family (Gmail)" for Thunderbird's. */
  pickName(key: string): string {
    const c = this.calendars.find((x) => x.accountId === key);
    if (c?.kind === "thunderbird") return c.group && c.group !== c.name ? `${c.name} (${c.group})` : c.name;
    return store.accountName(key) || c?.name || "Calendar";
  }

  /** Read the range on screen: a saved copy shows at once; the calendars are asked again when it's older than two minutes. */
  async load(force = false) {
    if (!this.available) return;
    if (this.mode === "year") { this.loading = false; return; }
    const { start, end } = this.range();
    // Other calendars are read only while they're ticked (each one is a request).
    const others = this.canShare ? this.shownOthers().map((c) => ({ key: c.key, accountId: c.accountId, folderId: c.folderId || "", email: c.email || "" })) : [];
    const key = `${start.getTime()}|${end.getTime()}|${others.map((c) => c.key).sort().join(",")}`;
    const saved = this.ranges.get(key);
    if (saved) this.events = saved.events;
    if (saved && !force && Date.now() - saved.at < (saved.failed ? RETRY_MS : FRESH_MS)) return;
    const token = ++this.token;
    this.loading = true;
    try {
      const failedShared = (e: any): SharedAnswer => ({ events: [], errors: others.map((c) => ({ key: c.key, message: String(e?.message || e) })), access: {} });
      const [view, shared]: [any, SharedAnswer] = await Promise.all([
        api.sparkCalendar.calendarView(start.toISOString(), end.toISOString(), { details: false }),
        others.length ? api.sparkCalendar.sharedView(others, start.toISOString(), end.toISOString()).catch(failedShared) : Promise.resolve({ events: [], errors: [], access: {} }),
      ]);
      const errors: CalendarError[] = view.errors || [];
      // Keep what a calendar showed before when it can't be read this time.
      const own: CalendarEvent[] = saved ? mergeAgenda(saved.own, view.events, errors) : view.events;
      const unread = new Set(shared.errors.map((e) => e.key));
      const sharedEvents = [...shared.events, ...(saved ? saved.shared.filter((e) => unread.has(e.calendarId || "")) : [])];
      const events = [...own, ...sharedEvents];
      const failed = view.accounts > 0 && errors.length >= view.accounts;
      this.ranges.set(key, { events, own, shared: sharedEvents, at: Date.now(), failed: !!errors.length || !!shared.errors.length });
      if (token !== this.token) return;
      this.events = events;
      this.failed = failed;
      this.error = calendarErrorText(errors);
      this.access = { ...this.access, ...shared.access };
      this.otherErrors = Object.fromEntries(shared.errors.map((e) => [e.key, e.message]));
      if (errors.length) errorLog.add(`calendar: ${this.error}`);
      for (const e of shared.errors) errorLog.add(`calendar: ${this.nameOf(e.key)}: ${e.message}`);
    } catch (e: any) {
      if (token !== this.token) return;
      this.failed = true;
      this.error = String(e?.message || e);
      errorLog.add(`calendar: ${this.error}`);
    } finally {
      if (token === this.token) this.loading = false;
    }
  }

  /** Something changed on a calendar (an answer here, in the agenda or on an invitation): read again. */
  changed() {
    this.ranges.clear();
    this.details = {};
    void this.load(true);
  }

  show(mode: CalendarMode, anchor = this.anchor) {
    this.mode = mode;
    this.anchor = startOfDay(anchor).getTime();
    this.selected = null;
    void this.load();
  }
  move(direction: 1 | -1) { this.show(this.mode, step(this.mode, this.anchor, direction)); }
  today() { this.show(this.mode, Date.now()); }

  get selectedEvent(): CalendarEvent | undefined {
    return this.selected ? this.events.find((e) => eventKey(e) === this.selected) : undefined;
  }
  select(event: CalendarEvent | null) {
    this.selected = event ? eventKey(event) : null;
    if (event && !event.busyOnly) void this.loadDetails(event);
  }
  async loadDetails(event: CalendarEvent) {
    const key = eventKey(event);
    if (this.details[key] && !("error" in this.details[key])) return;
    if (typeof api.sparkCalendar.eventDetails !== "function") return;
    try {
      const details: EventDetails = await api.sparkCalendar.eventDetails(event.accountId, event.id);
      this.details = { ...this.details, [key]: details };
    } catch (e: any) {
      this.details = { ...this.details, [key]: { error: String(e?.message || e) } };
    }
  }

  /** Answer an invitation from its calendar entry; the organizer is told (by Exchange, Google or Thunderbird). */
  async answer(event: CalendarEvent, response: Response): Promise<{ ok: boolean; message: string }> {
    if (this.answering) return { ok: false, message: "" };
    this.answering = response;
    try {
      const result = await api.sparkCalendar.respondEvent(event.accountId, event.id, response);
      // Declining takes the meeting off the calendar.
      if (response === "decline") this.selected = null;
      // Show the answer at once; the next read confirms it.
      this.events = this.events.map((e) => eventKey(e) === eventKey(event) ? { ...e, response } : e);
      window.dispatchEvent(new Event("spark:calendar-changed"));
      if (!exchangeConfirmed(response, result?.verified)) return { ok: false, message: `Your calendar still shows ${shownOnCalendar(result.verified)}` };
      return { ok: true, message: "" };
    } catch (e: any) {
      return { ok: false, message: String(e?.message || e) };
    } finally { this.answering = ""; }
  }

  // ---- Making and changing events ----
  /** The event editor while it's open (CalendarEditor.svelte, shown over any page). */
  editor = $state<EventDraft | null>(null);
  saving = $state(false);
  /** Whether the page can make events (a calendar to put them on). */
  get canCreate() { return typeof api?.sparkCalendar?.createEvent === "function"; }
  /** The calendar new events go on: the first one shown. */
  defaultCalendar(hidden: ReadonlySet<string> = new Set()): string {
    const writable = this.writable;
    return (writable.find((c) => !hidden.has(c.accountId)) || writable[0])?.accountId || "";
  }
  /** The calendar for an email's account: its Exchange calendar, else a Thunderbird calendar of the same address
   *  (Google's main calendar is named after it), else the default. */
  calendarForAccount(accountId: string | undefined): string {
    const writable = this.writable;
    if (accountId && writable.some((c) => c.accountId === accountId)) return accountId;
    const emails = new Set(store.identities.filter((i) => i.accountId === accountId).map((i) => i.email.toLowerCase()));
    const mine = writable.filter((c) => c.kind === "thunderbird" && emails.has(c.email.toLowerCase()));
    return (mine.find((c) => emails.has(c.name.toLowerCase())) || mine[0])?.accountId || this.defaultCalendar(new Set(store.settings.calendarHidden));
  }
  async openEditor(draft: EventDraft) {
    if (!this.calendarsLoaded) await this.loadCalendars();
    if (!draft.accountId) draft.accountId = this.defaultCalendar();
    this.editor = draft;
  }
  /** Make or change the event; its calendar's server (or Thunderbird) invites or updates its attendees. Returns what to say. */
  async save(draft: EventDraft): Promise<{ ok: boolean; message: string; start?: number }> {
    const problem = draftProblem(draft);
    if (problem) return { ok: false, message: problem };
    if (this.saving) return { ok: false, message: "" };
    this.saving = true;
    try {
      const zone = windowsZone();
      let message: string;
      if (draft.mode === "new") {
        const event = toEwsEvent(draft, zone);
        await api.sparkCalendar.createEvent(draft.accountId, event);
        message = event.attendees.length ? `Invitation sent for “${event.subject}”` : `Added “${event.subject}”`;
      } else {
        const { changes, send } = draftChanges(draft, zone);
        if (!Object.keys(changes).length) { this.editor = null; return { ok: true, message: "" }; }
        await api.sparkCalendar.updateEvent(draft.accountId, draft.itemId, changes, { changeKey: draft.changeKey || "", send });
        message = send ? `Updated “${draft.title || "the event"}” and told the invitees` : `Saved “${draft.title || "the event"}”`;
      }
      this.editor = null;
      this.selected = null;
      window.dispatchEvent(new Event("spark:calendar-changed"));
      return { ok: true, message, start: draft.allDay ? localTime(draft.startDate) : localTime(draft.startDate, draft.startTime) };
    } catch (e: any) {
      return { ok: false, message: String(e?.message || e) };
    } finally { this.saving = false; }
  }
  /** Delete an event the user owns, or take a cancelled meeting off the calendar. A meeting with attendees is
   *  cancelled (they're told, with the note); `series` deletes every occurrence. */
  async remove(event: CalendarEvent, options: { series?: boolean; cancel?: boolean; note?: string; changeKey?: string } = {}): Promise<{ ok: boolean; message: string }> {
    if (this.saving) return { ok: false, message: "" };
    this.saving = true;
    try {
      await api.sparkCalendar.deleteEvent(event.accountId, event.id, { series: !!options.series, cancel: !!options.cancel, note: options.note || "", changeKey: options.changeKey || "" });
      this.selected = null;
      // Off the page at once (a series: every occurrence of it); the next read confirms.
      const gone = (e: CalendarEvent) => eventKey(e) === eventKey(event) || (!!options.series && !!event.uid && !e.shared && e.uid === event.uid && e.accountId === event.accountId);
      this.events = this.events.filter((e) => !gone(e));
      window.dispatchEvent(new Event("spark:calendar-changed"));
      return { ok: true, message: "" };
    } catch (e: any) {
      return { ok: false, message: String(e?.message || e) };
    } finally { this.saving = false; }
  }

  // ---- Find a time ----
  private availabilityCache = new Map<string, { at: number; people: PersonBusy[] }>();
  get canFindTime() { return typeof api?.sparkCalendar?.availability === "function"; }
  /** The user's address on a calendar's account. */
  emailOf(accountId: string) { return this.calendars.find((c) => c.accountId === accountId)?.email || ""; }
  /** Busy times of these people (the user first, by the calendar's address) from the calendar's server; kept two minutes. */
  async availability(accountId: string, emails: string[], from: number, to: number): Promise<PersonBusy[]> {
    const me = this.emailOf(accountId);
    const people = [...new Set([me, ...emails].map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const key = `${accountId}|${people.join(",")}|${from}|${to}`;
    const saved = this.availabilityCache.get(key);
    if (saved && Date.now() - saved.at < FRESH_MS) return saved.people;
    const answer: { email: string; busy: { start: string; end: string }[]; error?: string }[] = await api.sparkCalendar.availability(accountId, people, new Date(from).toISOString(), new Date(to).toISOString());
    const result = answer.map((p) => ({ email: p.email, busy: p.busy.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })), ...(p.error ? { unknown: true } : {}) }));
    this.availabilityCache.set(key, { at: Date.now(), people: result });
    return result;
  }

  /** Events from a month before to a month after the shown day, for search (one read, kept two minutes). */
  private searchPool: { key: string; at: number; events: CalendarEvent[] } | null = null;
  async searchRange(): Promise<CalendarEvent[]> {
    const start = addDays(startOfDay(this.anchor), -30), end = addDays(startOfDay(this.anchor), 31);
    const key = `${start.getTime()}`;
    if (this.searchPool?.key === key && Date.now() - this.searchPool.at < FRESH_MS) return this.searchPool.events;
    const view = await api.sparkCalendar.calendarView(start.toISOString(), end.toISOString(), { details: false });
    this.searchPool = { key, at: Date.now(), events: view.events || [] };
    return this.searchPool.events;
  }
}

export const calendar = new CalendarState();
