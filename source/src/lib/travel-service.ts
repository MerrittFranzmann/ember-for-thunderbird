// The background's side of Trips (trips.ts): looks at received mail that could be about travel, reads its
// bookings (schema.org markup; else Workers AI, only with AI sorting on), once per email, and keeps them in
// storage (travelAnswers by Message-ID; travelBookings merged, for the Ember window). A booking a new email
// changes (gate, time, cancelled) is announced, even in quiet hours, and check-in opening is a reminder.
import { extractBodies, htmlToText } from "./body";
import { buildTrips, changeText, checkInTimes, markupBookings, mergeBookings, timeText, travelAnswer, travelHint, travelRequest, travelText, bookingTitle, type Booking } from "./trips";
import type { MessageHeader, MessagePart } from "./types";

/** One email's answer: its date, its bookings, and how they were read ("noai": not asked yet, no AI). */
export interface TravelRecord { d: number; b: Booking[]; src: "markup" | "ai" | "none" | "noai" }
export interface TravelStatus { state: "idle" | "running" | "error"; checked: number; trips: number; error?: string; at: number;
  /** Why emails can't be read with AI ("off": AI sorting is off; "unavailable": this Thunderbird lacks it), or "" when it can. */
  ai?: "" | "off" | "unavailable" }
const SETTINGS = { travel: true, aiSort: false, clefAccount: "", clefToken: "" };
const SKIP_ROLES = ["sent", "drafts", "templates", "outbox", "trash", "junk"];
const CHECKIN = "spark-travel-checkin:";
const TRIP = "spark-trip:";
const RETRY_MS = 15 * 60000;
const KEEP_MS = 150 * 86400000;
const mid = (m: Pick<MessageHeader, "headerMessageId">) => (m.headerMessageId || "").replace(/^<|>$/g, "");

export class TravelService {
  private running = false;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private native: any, private source: { headers(): Promise<MessageHeader[]>; full(message: MessageHeader): Promise<MessagePart | undefined> }, private openTrip: (id: string) => Promise<unknown>) {}

  schedule(delay = 8000) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), delay);
  }

  private async me(): Promise<Set<string>> {
    const accounts = await Promise.resolve(this.native.accounts?.list?.()).catch(() => []) || [];
    return new Set(accounts.flatMap((a: any) => (a.identities || []).map((i: any) => String(i.email || "").toLowerCase())).filter(Boolean));
  }

  /** Emails to look at: received, travel-looking, not answered (or answered without AI, now that there is AI). */
  todo(headers: MessageHeader[], answers: Record<string, TravelRecord>, me: Set<string>, ai: boolean): MessageHeader[] {
    const seen = new Set<string>();
    return headers.filter((m) => {
      const key = mid(m);
      if (!key || seen.has(key) || m.junk) return false;
      const answer = answers[key];
      if (answer && !(answer.src === "noai" && ai)) return false;
      if ((m.folder?.specialUse || []).some((r: string) => SKIP_ROLES.includes(r))) return false;
      const author = (/<([^>]+)>/.exec(m.author)?.[1] || m.author || "").toLowerCase();
      if (me.has(author) || !travelHint(m.author, m.subject)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => +new Date(b.date) - +new Date(a.date));
  }

  async run() {
    if (this.running) { this.again = true; return; }
    this.running = true;
    try {
      const s = { ...SETTINGS, ...(await this.native.storage.local.get(SETTINGS)) };
      if (!s.travel) return;
      const aiWhy: TravelStatus["ai"] = !(s.aiSort && s.clefAccount && s.clefToken) ? "off" : typeof this.native.sparkAI?.llm !== "function" ? "unavailable" : "";
      const ai = aiWhy === "";
      const answers: Record<string, TravelRecord> = (await this.native.storage.local.get({ travelAnswers: {} })).travelAnswers || {};
      const todo = this.todo(await this.source.headers(), answers, await this.me(), ai);
      let checked = 0, unsaved = 0, error: string | undefined, retry = false;
      if (todo.length) await this.status({ state: "running", checked, trips: 0, ai: aiWhy });
      for (const m of todo) {
        const full = await this.source.full(m).catch(() => undefined);
        if (!full) continue;
        const bodies = extractBodies(full);
        const marked = markupBookings(bodies.html, mid(m));
        const text = (bodies.text ?? (bodies.html ? htmlToText(bodies.html) : "")).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
        let record: TravelRecord;
        if (marked.length) record = { d: +new Date(m.date), b: marked, src: "markup" };
        else if (!travelText(`${m.subject}\n${text}`)) record = { d: +new Date(m.date), b: [], src: "none" };
        else if (!ai) record = { d: +new Date(m.date), b: [], src: "noai" };
        else {
          const reply = await this.native.sparkAI.llm(s.clefAccount.trim(), s.clefToken.trim(), travelRequest({ from: m.author, subject: m.subject, date: m.date, text }))
            .catch((e: any) => ({ status: 0, body: null, error: e?.message || String(e) }));
          if (reply.status === 200) record = { d: +new Date(m.date), b: travelAnswer(reply.body, mid(m)) ?? [], src: "ai" };
          else if (reply.status === 0 || reply.status === 429 || reply.status >= 500) { error = reply.error || `Cloudflare answered HTTP ${reply.status}.`; retry = true; break; }
          else if (reply.status === 401 || reply.status === 403 || reply.status === 404) { error = "Cloudflare didn't accept the AI sorting token for trips (it needs Workers AI)."; break; }
          else record = { d: +new Date(m.date), b: [], src: "none" }; // this email couldn't be read: leave it
        }
        answers[mid(m)] = record;
        checked++;
        if (++unsaved >= 10) { unsaved = 0; await this.native.storage.local.set({ travelAnswers: answers }); }
      }
      // Forget emails long past (their trips are over), keep the rest.
      const now = Date.now();
      for (const [key, r] of Object.entries(answers)) if (now - r.d > KEEP_MS && r.b.every((b) => (b.end ?? b.start).at < now - 14 * 86400000)) delete answers[key];
      await this.native.storage.local.set({ travelAnswers: answers });
      const trips = await this.publish(answers);
      await this.status(error ? { state: "error", checked, trips, error, ai: aiWhy } : { state: "idle", checked, trips, ai: aiWhy });
      if (retry) this.schedule(RETRY_MS);
    } finally {
      this.running = false;
      if (this.again) { this.again = false; this.schedule(1000); }
    }
  }

  private status(status: Omit<TravelStatus, "at">) { return this.native.storage.local.set({ travelStatus: { ...status, at: Date.now() } }); }

  /** Merge, save for the Ember window, announce new changes, set check-in reminders. Returns the number of trips. */
  async publish(answers: Record<string, TravelRecord>): Promise<number> {
    const bookings = mergeBookings(Object.entries(answers).filter(([, r]) => r.b.length).map(([key, r]) => ({ mid: key, date: r.d, bookings: r.b })));
    const { travelBookings: before } = await this.native.storage.local.get({ travelBookings: null });
    await this.native.storage.local.set({ travelBookings: bookings });
    const now = Date.now();
    const trips = buildTrips(bookings, now);
    // A change since the last look (not on the first one), from the last two days, to something still ahead
    // within three days.
    if (Array.isArray(before)) {
      const previous = new Map((before as Booking[]).map((b) => [b.key, b]));
      for (const b of bookings) {
        const old = previous.get(b.key);
        if (!old || !b.was || !b.changedAt || now - b.changedAt > 2 * 86400000) continue;
        if (old.gate === b.gate && old.start.at === b.start.at && old.status === b.status) continue;
        if ((b.end ?? b.start).at < now || b.start.at - now > 3 * 86400000) continue;
        const trip = trips.find((t) => t.bookings.some((x) => x.key === b.key));
        await this.notify(`${TRIP}${trip?.id || ""}`, changeText(b), [bookingTitle(b), b.status === "cancelled" ? "" : `${b.kind === "flight" ? "Leaves" : "Starts"} ${timeText(b.start)}`].filter(Boolean).join(" · "));
      }
    }
    await this.reminders(bookings);
    return trips.length;
  }

  private async reminders(bookings: Booking[]) {
    const due = checkInTimes(bookings, Date.now()).filter((c) => c.at - Date.now() < 30 * 86400000);
    const want = new Set(due.map((c) => CHECKIN + c.booking.key));
    const alarms: any[] = await Promise.resolve(this.native.alarms.getAll?.()).catch(() => []) || [];
    for (const a of alarms) if (a.name.startsWith(CHECKIN) && !want.has(a.name)) await this.native.alarms.clear(a.name);
    for (const c of due) if (!alarms.some((a) => a.name === CHECKIN + c.booking.key && Math.abs(a.scheduledTime - c.at) < 60000)) await this.native.alarms.create(CHECKIN + c.booking.key, { when: c.at });
  }

  /** Returns true when the alarm was a check-in reminder. */
  async alarm(name: string): Promise<boolean> {
    if (!name.startsWith(CHECKIN)) return false;
    const key = name.slice(CHECKIN.length);
    const { travelBookings } = await this.native.storage.local.get({ travelBookings: [] });
    const b = (travelBookings as Booking[]).find((x) => x.key === key);
    if (b && b.status !== "cancelled" && b.start.at > Date.now()) {
      const trip = buildTrips(travelBookings, Date.now()).find((t) => t.bookings.some((x) => x.key === key));
      await this.notify(`${TRIP}${trip?.id || ""}`, `Check-in is open: ${b.number || bookingTitle(b)}`, `${bookingTitle(b)} · leaves ${timeText(b.start)}${b.provider ? ` · check in on ${b.provider}'s site or app` : ""}`);
    }
    return true;
  }

  private notify(id: string, title: string, message: string) {
    return Promise.resolve(this.native.notifications?.create(`${id}|${Date.now()}`, { type: "basic", title, message })).catch(() => {});
  }

  /** A trip notification was clicked: that trip in Ember. True when it was one. */
  async clicked(id: string): Promise<boolean> {
    if (!id.startsWith(TRIP)) return false;
    void Promise.resolve(this.native.notifications.clear(id)).catch(() => {});
    await this.openTrip(id.slice(TRIP.length).split("|")[0]);
    return true;
  }
}
