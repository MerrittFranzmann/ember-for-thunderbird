// The background's AI sorting (ai-sort.ts): asks Clef about each Inbox email of the saved 90 days that has
// no answer yet, newest first, two at a time, and again after new mail. Answers go to storage
// (aiCategories, saved every 25), progress to aiSortStatus for Settings. Stops on a refused token or
// account; after Cloudflare's rate limit or a network failure it tries again in ten minutes.
import { AI_ANSWER_LENGTH, aiKey, clefAnswer, clefError, clefGroup, clefRequest, hasGroupAnswer, savedAnswer, unsorted, type AiAnswers, type AiGroups, type InboxAsk } from "./ai-sort";
import { DEFAULT_IMPORTANT, inboxOf, type InboxId } from "./inboxes";
import { perf } from "./perf-recorder";
import { readFeedback, spamQuestion } from "./spam";
import type { MessageHeader, MessagePart } from "./types";

export interface AiSortStatus { state: "off" | "idle" | "running" | "error"; sorted: number; total: number; error?: string; at: number }
export interface AiSettings {
  aiSort: boolean; clefAccount: string; clefToken: string; clefModel: "clef" | "clef-flash";
  /** Work and Personal inboxes (inboxes.ts): each email is also sorted into its inbox's groups. */
  workAccounts: string[]; inboxImportant: Partial<Record<InboxId, string>>;
}
const DEFAULTS: AiSettings = { aiSort: false, clefAccount: "", clefToken: "", clefModel: "clef-flash", workAccounts: [], inboxImportant: {} };
const RETRY_MS = 10 * 60000;

/** A made-up email for "Test connection" (nothing of the user's is sent). */
const SAMPLE: MessageHeader = { id: -1, date: new Date(), author: "Ada Lovelace <ada@example.org>", subject: "Lunch on Friday?", flagged: false, recipients: ["you@example.org"], ccList: [], bccList: [], headerMessageId: "sample@spark", size: 1, tags: [] };
const SAMPLE_BODY: MessagePart = { contentType: "text/plain", body: "Hi! Are you free for lunch on Friday? I'd love to hear how the project is going. — Ada", headers: {} };

export class AiSorter {
  private running = false;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  /** `onSpam`: Clef's spam answers from each run (spam-service.ts moves the sure ones). */
  constructor(private native: any, private source: { headers(): Promise<MessageHeader[]>; full(message: MessageHeader): Promise<MessagePart | undefined> },
    private onSpam?: (items: { message: MessageHeader; spam: number | null }[]) => Promise<unknown>) {}

  private async settings(): Promise<AiSettings> { return { ...DEFAULTS, ...(await this.native.storage.local.get(DEFAULTS)) }; }
  private ready(s: AiSettings) { return s.aiSort && !!s.clefAccount && !!s.clefToken && typeof this.native.sparkAI?.clef === "function"; }
  private status(status: Omit<AiSortStatus, "at">) { return this.native.storage.local.set({ aiSortStatus: { ...status, at: Date.now() } }); }
  private async me(): Promise<Set<string>> {
    const accounts = await Promise.resolve(this.native.accounts?.list?.()).catch(() => []) || [];
    return new Set(accounts.flatMap((a: any) => (a.identities || []).map((i: any) => String(i.email || "").toLowerCase())).filter(Boolean));
  }

  schedule(delay = 5000) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), delay);
  }

  async run() {
    if (this.running) { this.again = true; return; }
    const s = await this.settings();
    if (!this.ready(s)) { await this.status({ state: "off", sorted: 0, total: 0 }); return; }
    this.running = true;
    try {
      const stored = await this.native.storage.local.get({ aiCategories: {}, aiGroups: {}, spamFeedback: null });
      // The spam question carries the user's own marks as examples (Clef keeps nothing between requests).
      const spam = spamQuestion(readFeedback(stored.spamFeedback));
      const spamAnswers: { message: MessageHeader; spam: number | null }[] = [];
      const answers: AiAnswers = stored.aiCategories || {};
      const groups: AiGroups = stored.aiGroups || {};
      const askOf = (m: MessageHeader): InboxAsk | undefined => {
        const inbox = inboxOf(m.folder?.accountId, s.workAccounts || []);
        return inbox ? { inbox, important: s.inboxImportant?.[inbox] ?? DEFAULT_IMPORTANT[inbox] } : undefined;
      };
      const todo = unsorted(await this.source.headers(), answers, await this.me(), (m) => { const ask = askOf(m); return !ask || hasGroupAnswer(groups, m, ask.inbox); });
      const pending = new Set(todo.map(aiKey));
      let sorted = Object.entries(answers).filter(([key, answer]) => answer.length >= AI_ANSWER_LENGTH && !pending.has(key)).length;
      const total = sorted + todo.length;
      // Cloudflare refused the group question (one 400 that the plain request didn't get): plain requests from then on.
      let groupsRefused = false;
      if (!todo.length) { await this.status({ state: "idle", sorted, total }); return; }
      await this.status({ state: "running", sorted, total });
      let next = 0, unsaved = 0;
      const halt: { stop: { error: string; retry: boolean } | null } = { stop: null };
      const save = async () => { unsaved = 0; await this.native.storage.local.set({ aiCategories: answers, aiGroups: groups }); await this.status({ state: "running", sorted, total }); };
      const worker = async () => {
        while (!halt.stop && next < todo.length) {
          const message = todo[next++];
          const full = await this.source.full(message).catch(() => undefined);
          const ask = groupsRefused ? undefined : askOf(message);
          const send = (with_: InboxAsk | undefined) => this.native.sparkAI.clef(s.clefAccount, s.clefToken, s.clefModel, clefRequest(message, full, with_, spam))
            .catch((error: any) => ({ status: 0, body: null, error: error?.message || String(error) }));
          let reply = await send(ask);
          if (reply.status === 400 && ask) {
            const plain = await send(undefined);
            if (plain.status === 200) {
              groupsRefused = true;
              perf.record("error", { text: `AI sorting: Cloudflare refused the inbox group question (${clefError(400, reply.body)}); sorting without groups`.slice(0, 300) });
            }
            reply = plain;
          }
          if (reply.status === 200) {
            const answer = clefAnswer(reply.body);
            if (!answer) continue; // an answer Ember can't read: leave this email to the rules
            const group = ask && !groupsRefused ? clefGroup(reply.body, ask.inbox) : null;
            if (group) groups[aiKey(message)] = group;
            answers[aiKey(message)] = savedAnswer(answer);
            spamAnswers.push({ message, spam: answer.signals.spam });
            sorted++;
            if (++unsaved >= 25) await save();
          } else if (reply.status === 0) halt.stop = { error: reply.error || "Couldn't reach Cloudflare.", retry: true };
          else if (reply.status === 429) halt.stop = { error: clefError(429, reply.body), retry: true };
          else if ([400, 401, 403, 404].includes(reply.status) && !(reply.status === 400 && next > 2)) halt.stop = { error: clefError(reply.status, reply.body), retry: false };
          // Anything else (a server error, one email it couldn't take): skip it; the rules decide for it.
        }
      };
      await Promise.all([worker(), worker()]);
      if (unsaved) await this.native.storage.local.set({ aiCategories: answers, aiGroups: groups });
      if (spamAnswers.length && this.onSpam) await this.onSpam(spamAnswers).catch((error) => console.warn("Ember: spam moves failed", error));
      const stop = halt.stop;
      await this.status(stop ? { state: "error", sorted, total, error: stop.error } : { state: "idle", sorted, total });
      if (stop?.retry) this.schedule(RETRY_MS);
    } finally {
      this.running = false;
      if (this.again) { this.again = false; this.schedule(1000); }
    }
  }

  /** "Test connection" in Settings, with the values typed there (before they're saved): one made-up email. */
  async test(settings: Partial<AiSettings>): Promise<{ ok: boolean; error?: string; answer?: string; confidence?: number; ms: number }> {
    const s = { ...DEFAULTS, ...settings };
    const start = Date.now();
    if (typeof this.native.sparkAI?.clef !== "function") return { ok: false, error: "This Thunderbird can't run Ember's AI sorting.", ms: 0 };
    try {
      const reply = await this.native.sparkAI.clef(s.clefAccount.trim(), s.clefToken.trim(), s.clefModel, clefRequest(SAMPLE, SAMPLE_BODY));
      const ms = Date.now() - start;
      if (reply.status !== 200) return { ok: false, error: clefError(reply.status, reply.body), ms };
      const answer = clefAnswer(reply.body);
      return answer ? { ok: true, answer: answer.cat, confidence: answer.confidence, ms } : { ok: false, error: "Cloudflare answered, but not in the form Ember expects.", ms };
    } catch (error: any) { return { ok: false, error: error?.message || String(error), ms: Date.now() - start }; }
  }
}
