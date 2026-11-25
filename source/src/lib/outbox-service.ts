// The background's side of Ember's outbox (outbox.ts): sends each waiting email at its time (an alarm per
// email, set again whenever the background starts), one at a time. A sent email leaves the outbox (and gets
// its follow-up reminder); one Thunderbird couldn't send stays, marked, with a notification. An email that
// was being sent when Thunderbird quit is never sent again by itself: it may have gone.
import { OutboxStore } from "./outbox-store";
import { closeComposeTab, openComposeTab, sendThreaded, windowFree } from "./delivery";
import { followUpFor, type FollowUp } from "./follow-ups";
import type { QueuedEmail } from "./outbox";

const PREFIX = "spark-send:";
const DRAFTS = "drafts";
/** A copy in Drafts (a sent draft keeps its Message-ID: the other copies are the sent email). */
const isDraftCopy = (m: any) => (m.folder?.specialUse || []).includes(DRAFTS) || m.folder?.type === DRAFTS;

export class OutboxService {
  private chain: Promise<unknown> = Promise.resolve();
  /** Emails this background is sending (a "sending" one that isn't was cut off). */
  private sending = new Set<string>();

  constructor(private native: any, private addFollowUp: (f: FollowUp) => Promise<unknown>, private store = new OutboxStore(native)) {}

  async start() {
    const now = Date.now();
    for (const email of await this.store.all()) {
      if (email.state === "sending" && !this.sending.has(email.id)) await this.store.update(email.id, { state: "failed", error: "Thunderbird closed while it was being sent. Check Sent before trying again." });
    }
    await this.schedule(now);
  }

  /** An alarm for each waiting email; the ones due already go now. */
  async schedule(now = Date.now()) {
    const emails = await this.store.all();
    for (const email of emails) {
      if (email.state !== "waiting") continue;
      if (email.sendAt <= now) void this.send(email.id);
      else await this.native.alarms.create(PREFIX + email.id, { when: email.sendAt });
    }
  }

  /** Returns true when the alarm was an outbox email's. */
  async alarm(name: string): Promise<boolean> {
    if (!name.startsWith(PREFIX)) return false;
    await this.send(name.slice(PREFIX.length));
    return true;
  }

  /** The page's requests: "schedule" (an email was added), "send-now" (also Try again). */
  async request(message: { action: string; id?: string }) {
    if (message.action === "schedule") return this.schedule();
    if (message.action === "send-now" && message.id) {
      await this.store.update(message.id, { state: "waiting", sendAt: Date.now(), error: undefined }, (email) => email.state !== "sending");
      await this.native.alarms.clear(PREFIX + message.id).catch(() => {});
      return this.send(message.id);
    }
  }

  /** Whether an email is being sent or goes within three minutes (updates wait for it). */
  async busy(now = Date.now()): Promise<boolean> {
    const emails = await this.store.all().catch(() => []);
    return emails.some((email) => email.state === "sending" || (email.state === "waiting" && email.sendAt < now + 180000));
  }

  /** Send one email if it's still waiting and due; one at a time (each may open Thunderbird's composer). */
  send(id: string): Promise<void> {
    const run = async () => {
      const email = await this.store.claim(id);
      if (!email) return;
      this.sending.add(email.id);
      try {
        const sent = await this.deliver(email);
        await this.store.remove(email.id);
        let reminder = "";
        if (email.followUp && sent?.headerMessageId) {
          await this.addFollowUp(followUpFor(sent.headerMessageId, email.subject, email.to, Date.now(), email.followUp)).then(
            () => { reminder = ` · reminder in ${email.followUp === 1 ? "1 day" : `${email.followUp} days`} if no reply`; },
            () => { reminder = " · couldn't set the reminder"; });
        }
        await this.event(email, true, `Sent “${email.subject || "(no subject)"}”${reminder}`);
      } catch (error: any) {
        const text = String(error?.message || error);
        await this.store.update(email.id, { state: "failed", error: text });
        await this.event(email, false, `Couldn't send “${email.subject || "(no subject)"}”: ${text}`);
        await Promise.resolve(this.native.notifications?.create(PREFIX + email.id, {
          type: "basic", title: "Ember couldn't send an email", message: `“${email.subject || "(no subject)"}”: ${text}. It's waiting in Ember's outbox.`,
        })).catch(() => {});
      } finally { this.sending.delete(email.id); }
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  private event(email: QueuedEmail, ok: boolean, text: string) {
    return Promise.resolve(this.native.storage.local.set({ outboxEvent: { id: email.id, ok, text, at: Date.now() } })).catch(() => {});
  }

  /** An email by Message-ID (a draft: the copy in Drafts). */
  private async find(mid: string | undefined, draft: boolean): Promise<any | undefined> {
    if (!mid) return undefined;
    const found = await this.native.messages.query({ headerMessageId: mid }).catch(() => null);
    const copies: any[] = (found?.messages || []).filter((m: any) => !m.junk);
    return draft ? copies.find(isDraftCopy) ?? copies[0] : copies[0];
  }

  private async deliver(email: QueuedEmail): Promise<{ headerMessageId?: string } | undefined> {
    const native = this.native;
    const { minimizeCompose } = await native.storage.local.get({ minimizeCompose: true });
    const related = await this.find(email.related?.mid, email.mode === "draft");
    if (email.mode === "forward" && !related) throw new Error("the forwarded email isn't in Thunderbird any more");
    let sent: any;
    if (windowFree(email.mode, email.threaded) && typeof native.messages.sendMessage === "function") {
      sent = await native.messages.sendMessage(email.details, { mode: "sendNow" });
    } else if (related && (sent = await sendThreaded(native, email.mode, related.id, email.details, email.threaded))) {
      // Sent without Thunderbird's composer (no window over whatever the user is doing).
    } else {
      // Without the email it answers, a reply still goes (as a new email with the same text and subject).
      const tab = await openComposeTab(native, related ? email.mode : "new", related?.id, email.details, email.threaded, minimizeCompose);
      try { sent = await native.compose.sendMessage(tab.id, { mode: "sendNow" }); }
      catch (error) { await closeComposeTab(native, tab); throw error; }
    }
    // A draft that was sent: its old copy goes (as when sending from the composer).
    if (email.mode === "draft" && related && isDraftCopy(related)) await native.messages.delete([related.id], { deletePermanently: true }).catch(() => native.messages.delete([related.id], true)).catch(() => {});
    return sent;
  }
}
