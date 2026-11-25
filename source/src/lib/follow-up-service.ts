// Follow-up reminders in the background. The composer registers a sent email ("spark:follow-up");
// at its due time (an alarm) and every 30 minutes Ember looks for a reply: someone else's email since
// it was sent whose In-Reply-To/References names its Message-ID. With none by the due time it becomes
// "due": a notification, and Ember lists it under No reply yet until a reply comes or it's dismissed.
import { followUpMessage, mightReply, repliesTo, type FollowUp } from "./follow-ups";
import type { MessageHeader } from "./types";

const PREFIX = "spark-follow:";
const SWEEP = "spark-followups";
const KEY = "followUps";

/** Ember's saved mail (cache-service.ts): lets a sweep skip Thunderbird's search of every folder. */
export interface SavedMail {
  recentMail(since: number): Promise<MessageHeader[] | null>;
  cache: { body(id: number): Promise<{ headers?: Record<string, string[]> } | undefined>; resolve(id: number): Promise<number> };
}

export class FollowUpService {
  constructor(private native: any, private openMessage: (id: number) => Promise<unknown>, private saved?: SavedMail) {}

  private async all(): Promise<Record<string, FollowUp>> { return (await this.native.storage.local.get({ [KEY]: {} }))[KEY]; }
  private async save(list: Record<string, FollowUp>) { await this.native.storage.local.set({ [KEY]: list }); }

  async start() {
    const list = await this.all();
    if (!Object.keys(list).length) return;
    if (!(await this.native.alarms.get(SWEEP))) await this.native.alarms.create(SWEEP, { periodInMinutes: 30 });
    const now = Date.now();
    for (const f of Object.values(list)) if (f.state === "waiting" && f.dueAt > now) await this.native.alarms.create(PREFIX + f.mid, { when: f.dueAt });
    await this.sweep();
  }

  async add(f: FollowUp) {
    await this.save({ ...(await this.all()), [f.mid]: f });
    if (!(await this.native.alarms.get(SWEEP))) await this.native.alarms.create(SWEEP, { periodInMinutes: 30 });
    await this.native.alarms.create(PREFIX + f.mid, { when: f.dueAt });
  }

  async cancel(mid: string) {
    const list = await this.all();
    delete list[mid];
    await this.save(list);
    await this.native.alarms.clear(PREFIX + mid);
    void Promise.resolve(this.native.notifications?.clear(PREFIX + mid)).catch(() => {});
  }

  /** Returns true when the alarm was a follow-up's. */
  async alarm(name: string): Promise<boolean> {
    if (name === SWEEP) { await this.sweep(); return true; }
    if (!name.startsWith(PREFIX)) return false;
    await this.sweep(name.slice(PREFIX.length));
    return true;
  }

  /** Drop the ones that got a reply; the rest past their time become due (and notify once). */
  async sweep(only?: string) {
    const list = await this.all();
    const open = Object.values(list).filter((f) => !only || f.mid === only);
    if (!open.length) { if (!Object.keys(list).length) await this.native.alarms.clear(SWEEP); return; }
    const { found: replied, saved } = await this.replied(open, true);
    const now = Date.now();
    // Saved mail can miss a reply read elsewhere (no new-mail event) until the next inventory: ask
    // Thunderbird before anything turns due.
    const turning = open.filter((f) => !replied.has(f.mid) && f.state === "waiting" && f.dueAt <= now);
    if (saved && turning.length) for (const mid of (await this.replied(turning, false)).found) replied.add(mid);
    for (const f of open) {
      if (replied.has(f.mid)) { delete list[f.mid]; void Promise.resolve(this.native.notifications?.clear(PREFIX + f.mid)).catch(() => {}); continue; }
      if (f.state === "waiting" && f.dueAt <= now) {
        list[f.mid] = { ...f, state: "due" };
        await Promise.resolve(this.native.notifications?.create(PREFIX + f.mid, { type: "basic", title: f.subject || "(no subject)", message: followUpMessage(f, now) })).catch(() => {});
      }
    }
    // Saved last: a reminder cancelled meanwhile stays cancelled.
    const current = await this.all();
    for (const mid of Object.keys(list)) if (current[mid]) current[mid] = list[mid];
    for (const f of open) if (!list[f.mid]) delete current[f.mid];
    await this.save(current);
  }

  /** Message-IDs (of `open`) that have a reply: one query for mail since the oldest, then headers of likely replies. */
  private async replied(open: FollowUp[], useSaved: boolean): Promise<{ found: Set<string>; saved: boolean }> {
    const found = new Set<string>();
    const me = await this.myAddresses();
    const since = new Date(Math.min(...open.map((f) => f.sentAt)) - 60000);
    // Saved mail first: the query below reads every folder's headers (~0.6 s at 13k emails, each sweep).
    const recent = useSaved ? await this.saved?.recentMail(+since).catch(() => null) : null;
    if (recent) {
      const seen = new Set<string>();
      for (const m of recent) {
        if (m.headerMessageId && seen.has(m.headerMessageId)) continue;
        if (m.headerMessageId) seen.add(m.headerMessageId);
        const candidates = open.filter((f) => !found.has(f.mid) && mightReply(f, m, me));
        if (!candidates.length) continue;
        const headers = (await this.saved!.cache.body(m.id).catch(() => undefined))?.headers
          ?? await this.saved!.cache.resolve(m.id).then((id) => this.headers(id), () => ({}));
        for (const f of candidates) if (repliesTo(headers, f.mid)) found.add(f.mid);
        if (found.size === open.length) break;
      }
      return { found, saved: true };
    }
    let page: any;
    try { page = await this.native.messages.query({ fromDate: since }); } catch { return { found, saved: false }; }
    const seen = new Set<string>();
    for (let pages = 0; page && pages < 20; pages++) {
      for (const m of page.messages || []) {
        if (m.headerMessageId && seen.has(m.headerMessageId)) continue;
        if (m.headerMessageId) seen.add(m.headerMessageId);
        const candidates = open.filter((f) => !found.has(f.mid) && mightReply(f, m, me));
        if (!candidates.length) continue;
        const headers = await this.headers(m.id);
        for (const f of candidates) if (repliesTo(headers, f.mid)) found.add(f.mid);
      }
      if (found.size === open.length || !page.id) break;
      page = await this.native.messages.continueList(page.id).catch(() => null);
    }
    if (page?.id) void Promise.resolve(this.native.messages.abortList?.(page.id)).catch(() => {});
    return { found, saved: false };
  }

  private async headers(id: number): Promise<Record<string, string[]>> {
    try {
      if (typeof this.native.messages.getHeaders === "function") return await this.native.messages.getHeaders(id);
      return (await this.native.messages.getFull(id))?.headers || {};
    } catch { return {}; }
  }

  private async myAddresses(): Promise<Set<string>> {
    const accounts = await this.native.accounts.list(false).catch(() => []);
    return new Set(accounts.flatMap((a: any) => (a.identities || []).map((i: any) => String(i.email || "").toLowerCase())).filter(Boolean));
  }

  /** A follow-up notification was clicked: open the sent email in Ember. Returns true when it was one. */
  async clicked(id: string): Promise<boolean> {
    if (!id.startsWith(PREFIX)) return false;
    void this.native.notifications.clear(id);
    const mid = id.slice(PREFIX.length);
    // Saved mail first (the sent email usually is): Thunderbird's Message-ID search walks every folder.
    const f = (await this.all())[mid];
    const saved = f && await this.saved?.recentMail(f.sentAt - 60000).catch(() => null);
    // A saved email's id is the background's stand-in; the page needs Thunderbird's own.
    const local = saved?.find((m) => (m.headerMessageId || "").replace(/^<|>$/g, "") === mid);
    const liveId = local && (local.id >= 0 ? local.id : await this.saved!.cache.resolve(local.id).catch(() => undefined));
    const message = liveId !== undefined ? { id: liveId } : (await this.native.messages.query({ headerMessageId: mid }).catch(() => null))?.messages?.[0];
    if (message) await this.openMessage(message.id);
    return true;
  }
}
