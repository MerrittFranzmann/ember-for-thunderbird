import { CACHE_CHANNEL, DIRECT_COMMANDS } from "./cache-channel";
import { HeaderInterner, unpackFolders } from "./intern";
import { MemoryCache, mimeBytes } from "./memory-cache";
import { keepMessage, messageKey, type CacheStatus } from "./local-mail-cache";
import type { MessageAttachment, MessageHeader, MessagePart } from "./types";
import type { SearchFilters, SearchResult } from "./mail-search";
import { perf } from "./perf-recorder";
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
/** The first page (newest mail) is small so lists draw at once; later pages are larger (fewer round
 *  trips) but still short tasks, now that folders travel once per page (packFolders). */
const SNAPSHOT_PAGE = 400;
const LATER_PAGE = 1000;
/** Channel requests that can legitimately take long (whole-cache scans); others fall back after 6 s. */
const SLOW_COMMANDS = new Set(["search", "attachmentIndex", "attachmentKeys", "linkIndex"]);
/** Changes that can move a message between conversations or in/out of lists (vs. read state, tags). */
function structural(a: MessageHeader, b: MessageHeader) {
  return a.folder?.id !== b.folder?.id || !!a.junk !== !!b.junk || !!a.flagged !== !!b.flagged || a.subject !== b.subject || a.headerMessageId !== b.headerMessageId;
}
/** Tab-local handles refer to immutable keys, so background-page restarts cannot reuse them. */
export class CacheClient {
  private headers = new Map<string, MessageHeader>();
  private byId = new Map<number, MessageHeader>();
  private handles = new Map<number, string>();
  private liveIds = new Map<string, number>();
  private synthetic = new Map<string, number>();
  private sequence = -1;
  private bodies = new MemoryCache<MessagePart>(64, 24 * 1024 * 1024, mimeBytes);
  private fileLists = new MemoryCache<MessageAttachment[]>(128, 2 * 1024 * 1024);
  private requests = new Map<string, Promise<any>>();
  private revisions = new Map<string, number>();
  private key(id: number) { return this.handles.get(id) || `live:${id}`; }
  forget(id: number) { const key = this.key(id); this.bodies.delete(key); this.fileLists.delete(key); this.revisions.set(key, (this.revisions.get(key) || 0) + 1); for (const prefix of ["cached:", "files:", "message:", "fetch-files:"]) this.requests.delete(prefix + key); }
  private remember<T>(key: string, revision: number, memory: MemoryCache<T>, value: T | undefined) { if (value !== undefined && revision === (this.revisions.get(key) || 0)) memory.set(key, value); return value; }
  private share<T>(key: string, work: () => Promise<T>): Promise<T> { let request = this.requests.get(key); if (!request) { request = work().finally(() => { if (this.requests.get(key) === request) this.requests.delete(key); }); this.requests.set(key, request); } return request; }

  private opening?: Promise<void>;
  private refreshing?: Promise<void>;
  private epoch?: string;
  /** Changes whenever cached header content changes; lets callers memoize work over all(). */
  version = 0;
  /** Session ids already given to the background, so unchanged list pages aren't re-sent. */
  private sentIds = new Map<string, number>();
  private revision = 0;
  private pending = Promise.resolve();
  status: CacheStatus = { phase: "idle", total: 0, done: 0, failed: 0, saved: 0 };
  onChange?: (status: CacheStatus) => void;
  onBody?: (message: MessageHeader, body: MessagePart) => void;
  /** The first snapshot page (the newest mail) is available; the rest is still arriving. */
  onPartial?: () => void;
  constructor(private native: any) {}
  /** Headers arrive as structured clones: share their repeated folders, senders and recipient lists. */
  private interner = new HeaderInterner();

  // Read requests go over a BroadcastChannel to the background (see cache-service.ts listenDirect):
  // runtime messaging waits on Thunderbird's main thread, which is busy at start-up. The channel is used
  // once the background has answered a ping on it; until then, and for any request it doesn't answer in
  // time (the background suspended), requests go the usual way, which also wakes the background.
  private channel?: BroadcastChannel;
  private waiting = new Map<string, (response: any) => void>();
  private direct = false;
  private pingedAt = 0;
  private directSeq = 0;
  private readonly directId = Math.random().toString(36).slice(2);
  private openChannel(): BroadcastChannel {
    if (!this.channel) {
      this.channel = new BroadcastChannel(CACHE_CHANNEL);
      this.channel.onmessage = (event: MessageEvent) => {
        const data = event.data;
        if (data?.kind === "pong" && data.to === this.directId) { this.direct = true; return; }
        if (data?.kind !== "response") return;
        const done = this.waiting.get(data.id);
        if (done) { this.waiting.delete(data.id); done(data.response); }
      };
    }
    return this.channel;
  }
  private transport(message: { command: string }): Promise<any> {
    const usable = typeof BroadcastChannel !== "undefined" && DIRECT_COMMANDS.has(message.command);
    if (!usable || !this.direct) {
      if (usable && Date.now() - this.pingedAt > 30000) { this.pingedAt = Date.now(); this.openChannel().postMessage({ kind: "ping", from: this.directId }); }
      return this.native.runtime.sendMessage(message);
    }
    const id = `${this.directId}:${++this.directSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // No answer yet (the background suspended, or an email still downloading): ask the usual way too,
        // which wakes it. Whichever answers first counts; only a slow-way win turns the channel off.
        Promise.resolve(this.native.runtime.sendMessage(message)).then((response) => {
          if (!this.waiting.delete(id)) return;
          this.direct = false; this.pingedAt = Date.now(); // try the channel again in 30 s
          resolve(response);
        }, (error) => { if (this.waiting.delete(id)) reject(error); });
      }, SLOW_COMMANDS.has(message.command) ? 30000 : 6000);
      this.waiting.set(id, (response) => { clearTimeout(timer); resolve(response); });
      this.openChannel().postMessage({ kind: "request", id, message });
    });
  }
  private async call(command: string, args: any = {}): Promise<any> {
    const response: any = await perf.track(`cache.${command}`, this.transport({ type: "spark:cache", command, ...plain(args) }));
    if (!response?.ok) throw new Error(response?.error || "The background cache is unavailable. Try again.");
    return response.value;
  }
  private update(status: CacheStatus) { this.status = status; this.onChange?.(status); }
  async init(): Promise<void> {
    if (this.opening) return this.opening;
    this.opening = (async () => {
      this.native.storage.onChanged.addListener((changes: any, area: string) => { if (area === "local" && changes.cacheStatus?.newValue) this.update(changes.cacheStatus.newValue); });
      this.native.runtime.onMessage.addListener((message: any) => { if (message?.type === "spark:cache-invalidated") void this.refresh().catch(() => {}); });
      await this.refresh();
    })();
    return this.opening;
  }
  private adopt(message: MessageHeader): MessageHeader {
    const key = messageKey(message);
    let id = this.liveIds.get(key) ?? this.synthetic.get(key);
    if (id === undefined) { id = this.sequence--; this.synthetic.set(key, id); }
    const value = this.interner.header({ ...message, date: new Date(message.date), id });
    this.handles.set(id, key); this.byId.set(id, value);
    return value;
  }
  /** Drop remembered bodies and attachment lists (Ember hidden for a while); the background still has them. */
  trimMemory() { this.bodies.clear(); this.fileLists.clear(); }
  private refreshAgain = false;
  /** The current saved header for a key (the object lists hold), for callers that kept an older one. */
  current(key: string): MessageHeader | undefined { return this.headers.get(key); }
  refresh(): Promise<void> {
    // A request during a refresh runs once more afterwards: changes logged meanwhile aren't dropped.
    if (this.refreshing) { this.refreshAgain = true; return this.refreshing; }
    this.refreshing = (async () => {
     do {
      this.refreshAgain = false;
      // After the first snapshot only changed headers cross the process boundary.
      const snapshot = this.epoch ? await this.pagedChanges(this.revision, this.epoch) : await this.pagedSnapshot();
      const reset = !this.epoch || snapshot.reset !== false;
      if (reset || snapshot.removed.length) this.version++;
      if (reset) this.sentIds.clear(); // a new background owner knows nothing yet
      if (reset) this.headers = snapshot.adopted ?? new Map(snapshot.headers.map((header: MessageHeader) => { const message = this.adopt(header); return [messageKey(message), message]; }));
      else {
        for (const key of snapshot.removed) this.headers.delete(key);
        for (const header of snapshot.headers) {
          const key = messageKey(header), previous = this.headers.get(key);
          // Read/tag changes update the header in place: grouping (and the related index) stays valid.
          if (previous && !structural(previous, header)) { Object.assign(previous, this.interner.header({ ...header, id: previous.id, date: previous.date })); continue; }
          this.headers.set(key, this.adopt(header)); this.version++;
        }
      }
      this.epoch = snapshot.epoch; this.revision = snapshot.revision || 0;
      this.update(snapshot.status);
     } while (this.refreshAgain);
    })().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }
  all() { return [...this.headers.values()].filter((header) => keepMessage(header)); }
  /** Changes since a log position, in pages (each a short task). An unpaged answer passes through. */
  private async pagedChanges(since: number, epoch: string) {
    const token = Math.random().toString(36).slice(2);
    let page = unpackFolders(await this.call("changes", { since, epoch, offset: 0, limit: SNAPSHOT_PAGE, token, compact: true }));
    if (!page || page.next === undefined) return page;
    const headers = [...page.headers], removed = [...page.removed];
    while (page.next !== null) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      page = unpackFolders(await this.call("changes", { since, epoch, offset: page.next, limit: LATER_PAGE, token, compact: true }));
      if (page.expired) return this.pagedChanges(since, epoch);
      headers.push(...page.headers); removed.push(...page.removed);
    }
    return { ...page, headers, removed };
  }
  /** The first snapshot in pages (each a short task), then the changes made while paging. */
  private async pagedSnapshot(): Promise<any> {
    const token = Math.random().toString(36).slice(2);
    let page = unpackFolders(await this.call("snapshot", { offset: 0, limit: SNAPSHOT_PAGE, token, compact: true }));
    const first = page;
    if (first.next === undefined) return first; // an unpaged answer (older background owner)
    // Each header is adopted once, as its page arrives (the whole snapshot used to be adopted again at the end).
    const adopted = new Map<string, MessageHeader>();
    const add = (headers: MessageHeader[]) => { for (const header of headers) { const message = this.adopt(header); adopted.set(messageKey(message), message); } };
    add(page.headers);
    if (page.next) {
      // Pages arrive newest first: let lists draw their top while older mail streams in. The status
      // comes first, so a list knows it can be served from the cache.
      this.headers = new Map(adopted);
      this.version++;
      this.update(page.status);
      this.onPartial?.();
    }
    while (page.next !== null && page.next !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      page = unpackFolders(await this.call("snapshot", { offset: page.next, limit: LATER_PAGE, token, compact: true }));
      if (page.expired) return this.pagedSnapshot(); // the owner lost this paging session: start over
      add(page.headers);
    }
    const caught = await this.pagedChanges(first.revision, first.epoch).catch(() => undefined);
    if (caught?.reset) return caught;
    if (caught) { for (const key of caught.removed) adopted.delete(key); add(caught.headers); }
    return { epoch: first.epoch, revision: caught ? caught.revision : first.revision, reset: true, adopted, headers: [], removed: [], status: caught ? caught.status : page.status };
  }
  private mutation(command: string, args: any) {
    this.pending = this.pending.then(() => this.call(command, args)).then(() => {}).catch((error) => this.update({ ...this.status, phase: "error", error: error.message }));
  }
  register(messages: MessageHeader[], revive = false) {
    // Every list page passes through here; only new or changed headers need the round trip.
    const send: MessageHeader[] = [];
    for (const original of messages) {
      const message = { ...plain(original), date: new Date(original.date) };
      const key = messageKey(message);
      // A list page fetched before a move or delete still carries the old copy; don't restore it.
      if (!revive && (this.removedAt.get(key) ?? -Infinity) > Date.now() - 60000) continue;
      if (revive) this.removedAt.delete(key);
      this.handles.set(message.id, key); this.byId.set(message.id, message);
      if (message.id >= 0) this.liveIds.set(key, message.id);
      const previous = this.headers.get(key);
      let changed = false;
      if (keepMessage(message)) {
        changed = !previous || previous.read !== message.read || previous.flagged !== message.flagged || previous.junk !== message.junk || JSON.stringify(previous.tags) !== JSON.stringify(message.tags);
        this.headers.set(key, message);
      } else changed = this.headers.delete(key);
      if (changed) this.version++;
      if (revive || changed || (message.id >= 0 && this.sentIds.get(key) !== message.id)) {
        send.push(original);
        if (message.id >= 0) this.sentIds.set(key, message.id);
      }
    }
    if (send.length) this.mutation("register", { messages: send, revive });
  }
  changed(message: MessageHeader, changes: Partial<MessageHeader>) {
    const key = messageKey({ ...message, ...changes }), previous = this.headers.get(key);
    // A late change (e.g. the end of a long mark-all-read batch) for mail just moved away or deleted
    // must not put the old copy back.
    if (!previous && this.removedAt.has(key)) { this.mutation("changed", { message, changes }); return; }
    const next = { ...message, ...changes };
    const keep = keepMessage(next);
    // In place for read/tags (same object the lists and the related index hold); new version otherwise.
    const header = previous && keep && !structural(previous, next) ? Object.assign(previous, changes) : next;
    if (header !== previous) this.version++;
    this.byId.set(message.id, header);
    if (keep) this.headers.set(key, header); else this.headers.delete(key);
    // Native events are authoritative; the owner also hears them while this tab is closed.
    this.mutation("changed", { message, changes });
  }
  /** Keys moved away or deleted (10 min): stale list pages (60 s) and late changes don't restore them; a revive clears. */
  private removedAt = new Map<string, number>();
  remove(messages: MessageHeader[]) { this.version++; const now = Date.now(); for (const [key, at] of this.removedAt) if (now - at > 600000) this.removedAt.delete(key); for (const message of messages) { const key = messageKey(message); this.removedAt.set(key, now); this.bodies.delete(key); this.fileLists.delete(key); this.revisions.set(key, (this.revisions.get(key) || 0) + 1); this.headers.delete(key); } this.mutation("remove", { messages }); }
  private ref(id: number) {
    const header = this.byId.get(id);
    return { id: id >= 0 ? id : undefined, key: this.handles.get(id), header: id >= 0 ? header : undefined };
  }
  getCachedHeaders(id: number): Promise<Record<string, string[]> | undefined> { const cached = this.bodies.get(this.key(id)); return cached?.headers ? Promise.resolve(cached.headers) : this.call("headers", { ref: this.ref(id) }); }
  body(id: number): Promise<MessagePart | undefined> {
    const key = this.key(id); const saved = this.bodies.get(key); if (saved !== undefined) return Promise.resolve(saved);
    const revision = this.revisions.get(key) || 0;
    return this.share(`cached:${key}`, async () => this.remember(key, revision, this.bodies, await this.call("body", { ref: this.ref(id) })));
  }
  files(id: number): Promise<MessageAttachment[] | undefined> {
    const key = this.key(id); const saved = this.fileLists.get(key); if (saved !== undefined) return Promise.resolve(saved);
    const revision = this.revisions.get(key) || 0;
    return this.share(`files:${key}`, async () => this.remember(key, revision, this.fileLists, await this.call("files", { ref: this.ref(id) })));
  }
  async fetch(store: "bodies" | "files", id: number, args: any[] = []) {
    const key = this.key(id); const revision = this.revisions.get(key) || 0;
    const memory = store === "bodies" ? this.bodies : this.fileLists; const saved = memory.get(key);
    if (saved !== undefined) return saved;
    if (store === "bodies") return this.share(`message:${key}`, async () => {
      const cached = this.requests.get(`cached:${key}`); const full = cached ? await cached : undefined;
      if (full !== undefined) return full;
      const value = await this.call("message", { ref: this.ref(id), args });
      this.remember(key, revision, this.bodies, value.full); this.remember(key, revision, this.fileLists, value.atts);
      const header = this.byId.get(id); if (header) this.onBody?.(header, value.full);
      return value.full;
    });
    return this.share(`fetch-files:${key}`, async () => this.remember(key, revision, this.fileLists, await this.call("fetch", { store, ref: this.ref(id), args })));
  }
  resolve(id: number): Promise<number> { return id >= 0 ? Promise.resolve(id) : this.call("resolve", { ref: this.ref(id) }); }
  async attachmentIndex(): Promise<{ message: MessageHeader; files: MessageAttachment[] }[]> {
    return (await this.call("attachmentIndex")).map((record: any) => ({ ...record, message: this.adopt(record.message) }));
  }
  attachmentKeys(): Promise<string[]> { return this.call("attachmentKeys"); }
  async linkIndex(): Promise<{ message: MessageHeader; links: import("./link-library").FoundLink[] }[]> {
    return (await this.call("linkIndex")).map((record: any) => ({ ...record, message: this.adopt(record.message) }));
  }
  async search(query: string, filters: SearchFilters = {}): Promise<SearchResult> {
    const result = await this.call("search", { query, filters, keysOnly: true });
    if (!Array.isArray(result.keys)) return { ...result, messages: result.messages.map((header: MessageHeader) => this.adopt(header)) };
    // This page's own copies; only headers it hasn't received yet are fetched (not mail it just removed:
    // the search may have run before the owner applied that).
    result.keys = result.keys.filter((key: string) => this.headers.has(key) || !((this.removedAt.get(key) ?? -Infinity) > Date.now() - 60000));
    const missing = result.keys.filter((key: string) => !this.headers.has(key));
    const fetched = new Map<string, MessageHeader>();
    if (missing.length) for (const header of await this.call("headersFor", { keys: missing }) || []) fetched.set(messageKey(header), this.adopt(header));
    const messages = result.keys.map((key: string) => this.headers.get(key) ?? fetched.get(key)).filter(Boolean) as MessageHeader[];
    return { indexed: result.indexed, cached: result.cached, messages };
  }
  async warm() { const status = await this.call("refresh"); this.update(status); }
  async setPaused(paused: boolean) { this.update(await this.call("pause", { paused })); }
  hold(): () => void {
    const port = Promise.resolve(this.native.runtime.connect({ name: "spark:cache-reader" })).catch(() => undefined);
    let released = false;
    return () => { if (released) return; released = true; void port.then((value: any) => value?.disconnect()); };
  }
}
