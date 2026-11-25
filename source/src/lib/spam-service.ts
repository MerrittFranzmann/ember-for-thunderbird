// The background's part of spam you teach Ember (spam.ts): new Inbox mail from a sender you marked goes to Spam
// right away, and so does mail Clef is sure is spam (the AI sorter hands over its answers). Each move is told to the
// page (storage spamMoved) so it can say so, with "Show". Ember's own moves don't train Thunderbird's junk filter
// (only your marks do), so a wrong guess never teaches it. Nothing is deleted.
import { emailOf } from "./format";
import { readFeedback, spamVerdict, isSpamSender, type SpamFeedback } from "./spam";
import type { MessageHeader } from "./types";

export interface SpamMoved { at: number; reason: "sender" | "ai"; items: { subject: string; from: string }[] }

const inInbox = (m: MessageHeader) => !!m.folder?.specialUse?.includes("inbox") && !m.junk;

export class SpamService {
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private native: any, private source: { headers(): Promise<MessageHeader[]> }) {}

  async feedback(): Promise<SpamFeedback> { return readFeedback((await this.native.storage.local.get({ spamFeedback: null })).spamFeedback); }

  private async me(): Promise<Set<string>> {
    const accounts = await Promise.resolve(this.native.accounts?.list?.()).catch(() => []) || [];
    return new Set(accounts.flatMap((a: any) => (a.identities || []).map((i: any) => String(i.email || "").toLowerCase())).filter(Boolean));
  }

  /** Everyone you've sent mail to (from the saved Sent folders). */
  private async written(): Promise<Set<string>> {
    const out = new Set<string>();
    for (const m of await this.source.headers()) {
      if (!m.folder?.specialUse?.includes("sent")) continue;
      for (const a of [...(m.recipients || []), ...(m.ccList || []), ...(m.bccList || [])]) { const e = emailOf(a).toLowerCase(); if (e) out.add(e); }
    }
    return out;
  }

  /** The account's Spam folder (Thunderbird's junk folder), or null when it has none. */
  private async junkFolder(accountId: string): Promise<string | null> {
    try {
      const found = await this.native.folders.query({ accountId, specialUse: ["junk"] });
      if (found?.[0]?.id) return found[0].id;
    } catch { /* older query: walk the account */ }
    try {
      const account = await this.native.accounts.get(accountId, true);
      const walk = (folders: any[] = []): string | null => { for (const f of folders) { if (f.specialUse?.includes("junk")) return f.id; const inner = walk(f.subFolders); if (inner) return inner; } return null; };
      return walk(account?.rootFolder?.subFolders || account?.folders);
    } catch { return null; }
  }

  /** Moves emails to their account's Spam folder and tells the page. One move at a time. */
  private move(messages: MessageHeader[], reason: SpamMoved["reason"]) {
    const run = async () => {
      const byAccount = new Map<string, MessageHeader[]>();
      for (const m of messages) { const id = m.folder?.accountId; if (id) byAccount.set(id, [...(byAccount.get(id) || []), m]); }
      const moved: MessageHeader[] = [];
      for (const [accountId, list] of byAccount) {
        const folder = await this.junkFolder(accountId);
        if (!folder) continue; // no Spam folder on this account: left where it is
        try { await this.native.messages.move(list.map((m) => m.id), folder); moved.push(...list); }
        catch (error) { console.warn("Ember: couldn't move to Spam", error); }
      }
      if (moved.length) await this.native.storage.local.set({ spamMoved: { at: Date.now(), reason, items: moved.map((m) => ({ subject: m.subject || "", from: m.author || "" })) } satisfies SpamMoved });
      return moved.length;
    };
    const next = this.busy.then(run, run);
    this.busy = next.catch(() => 0);
    return next;
  }

  /** New mail: Inbox emails from senders you marked as spam go to Spam. */
  async received(messages: MessageHeader[]): Promise<number> {
    const feedback = await this.feedback();
    if (!Object.keys(feedback.senders).length) return 0;
    const me = await this.me();
    const spam = messages.filter((m) => inInbox(m) && !me.has(emailOf(m.author).toLowerCase()) && isSpamSender(feedback, m.author));
    return spam.length ? this.move(spam, "sender") : 0;
  }

  /** Clef's spam answers for Inbox emails (probability 0–1): the sure ones on recent mail go to Spam. */
  async answered(items: { message: MessageHeader; spam: number | null }[], now = Date.now()): Promise<number> {
    const candidates = items.filter((i) => i.spam !== null && i.spam >= 0.9 && inInbox(i.message));
    if (!candidates.length) return 0;
    const [feedback, me, written] = await Promise.all([this.feedback(), this.me(), this.written()]);
    const sure = candidates.filter((i) => spamVerdict(i.spam, i.message, { me, written, feedback, now }) === "move").map((i) => i.message);
    return sure.length ? this.move(sure, "ai") : 0;
  }
}
