// The background's part of links that open an email (mail-links.ts): it runs Thunderbird's link listener while
// Settings → Links to emails is on (storage `mailLinkStatus` says how it went, for Settings and the MCP bridge), and
// when a link is clicked (or an agent asks, MCP open_email) it finds the email and shows it in Ember, in front.
import { aiKey } from "./ai-sort";
import { bestCopy, linkCode, readKept } from "./mail-links";
import type { MessageHeader } from "./types";

export interface MailLinkStatus { url?: string; error?: string }

export class MailLinkService {
  constructor(private native: any, private deps: {
    headers(): Promise<MessageHeader[]>;
    /** Show this email in Ember (opening Ember if needed). */
    show(id: number): Promise<unknown>;
    /** Ember couldn't find the email: open Ember, which says so. */
    missing(): Promise<unknown>;
  }) {}

  /** Listen for links or stop, to match Settings. */
  async configure(): Promise<MailLinkStatus | null> {
    const links = this.native.sparkMailLinks;
    if (!links) return null;
    const { emailLinks } = await this.native.storage.local.get({ emailLinks: true });
    let status: MailLinkStatus | null = null;
    if (emailLinks) {
      try { status = { url: (await links.start()).url }; }
      catch (error: any) { status = { error: error?.message || String(error) }; }
    } else await links.stop().catch(() => {});
    await this.native.storage.local.set({ mailLinkStatus: status });
    return status;
  }

  /** The email a link's code stands for (the copy to show), or null. */
  async find(code: string): Promise<MessageHeader | null> {
    const kept = readKept((await this.native.storage.local.get({ mailLinks: {} })).mailLinks)[code]?.[0];
    const saved = await this.deps.headers().catch(() => [] as MessageHeader[]);
    const key = kept ?? saved.map((m) => aiKey(m)).find((k) => !!k && linkCode(k) === code);
    return key ? this.current(key, saved) : null;
  }

  /** The email with this Message-ID as Thunderbird has it now. Ember's saved copy only names it: its id may be
   *  out of date (Thunderbird renumbers a folder it rebuilds), and the wrong email would open. */
  private async current(key: string, saved: MessageHeader[]): Promise<MessageHeader | null> {
    const found = await Promise.resolve(this.native.messages.query({ headerMessageId: key })).catch(() => null);
    return bestCopy<MessageHeader>(found?.messages || []) ?? bestCopy(saved.filter((m) => aiKey(m) === key));
  }

  /** A link was clicked: show its email in Ember, in front. */
  async open(code: string): Promise<boolean> {
    const message = await this.find(code).catch(() => null);
    if (message) await this.deps.show(message.id); else await this.deps.missing();
    await Promise.resolve(this.native.sparkMailLinks?.activate()).catch(() => {});
    return !!message;
  }

  /** An agent asked to show an email (its Message-ID): like a click. */
  async openEmail(messageId: string): Promise<{ opened: boolean; subject?: string }> {
    const key = aiKey({ headerMessageId: String(messageId || "") });
    const message = key ? await this.current(key, await this.deps.headers().catch(() => [] as MessageHeader[])) : null;
    if (!message) return { opened: false };
    await this.deps.show(message.id);
    await Promise.resolve(this.native.sparkMailLinks?.activate()).catch(() => {});
    return { opened: true, subject: message.subject };
  }
}
