import { withDeadline } from "./async";
import { mimeBytes } from "./memory-cache";
import type { MessageAttachment, MessagePart } from "./types";
export interface LoadedMessage { full: MessagePart; atts: MessageAttachment[]; attachmentError?: string; attachmentsPending?: boolean; }
type Entry = { body: Promise<MessagePart>; result?: Promise<LoadedMessage>; latest?: LoadedMessage; bytes: number };
export class MessageLoader {
  private entries = new Map<number, Entry>();
  constructor(private hold: () => () => void = () => () => {}, private maxEntries = 64, private maxBytes = 24 * 1024 * 1024) {}
  forget(id: number) { this.entries.delete(id); }
  /** Drop every loaded message (Ember hidden for a while; anything on screen keeps its own copy). */
  clear() { this.entries.clear(); }
  private trim() {
    let bytes = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (this.entries.size > this.maxEntries || bytes > this.maxBytes) { const first = this.entries.keys().next().value; if (first === undefined) break; bytes -= this.entries.get(first)!.bytes; this.entries.delete(first); }
  }
  private entry(api: any, id: number): Entry {
    let entry = this.entries.get(id);
    if (entry) { this.entries.delete(id); this.entries.set(id, entry); return entry; }
    const release = this.hold();
    const body = (async () => {
      for (let attempt = 0; ; attempt++) {
        try { return await withDeadline<MessagePart>(api.messages.getFull(id), 20000, undefined, "Message body"); }
        catch (error: any) { if (attempt >= 2 || !/Error reading message|Timeout|stream/i.test(error?.message || "")) throw error; await new Promise((resolve) => setTimeout(resolve, attempt ? 4000 : 1500)); }
      }
    })().finally(release);
    entry = { body, bytes: 0 }; this.entries.set(id, entry); const value = entry;
    body.then((full) => { value.latest = { full, atts: [], attachmentsPending: true }; value.bytes = mimeBytes(full); this.trim(); }, () => { if (this.entries.get(id) === value) this.entries.delete(id); });
    this.trim(); return entry;
  }
  body(api: any, id: number) { return this.entry(api, id).body; }
  load(api: any, id: number, onBody?: (message: LoadedMessage) => void): Promise<LoadedMessage> {
    const entry = this.entry(api, id);
    if (onBody) void entry.body.then(() => onBody(entry.latest!)).catch(() => {});
    if (!entry.result) entry.result = entry.body.then(async (full) => {
      let attachmentError: string | undefined;
      const atts = await withDeadline<MessageAttachment[]>(api.messages.listAttachments(id), 15000, undefined, "Attachment list").catch((error: any) => { attachmentError = error?.message || String(error); return []; });
      return entry.latest = { full, atts, attachmentError, attachmentsPending: false };
    });
    return entry.result;
  }
}
