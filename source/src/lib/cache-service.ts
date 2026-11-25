import { CACHE_CHANNEL, DIRECT_COMMANDS } from "./cache-channel";
import { packFolders } from "./intern";
import { LocalMailCache, messageKey, type CacheStatus, type WarmOptions } from "./local-mail-cache";
import { perf } from "./perf-recorder";
/** A full 90-day inventory blocks Thunderbird's main thread for seconds on large mailboxes. */
export const INVENTORY_INTERVAL_MS = 30 * 60000;
import type { MessagePart, MessageHeader, MessageList } from "./types";
/** One cache owner for the whole extension, including when all app tabs are closed. */
export class CacheService {
  cache: LocalMailCache;
  private ready: Promise<void>;
  private publishTimer?: ReturnType<typeof setTimeout>;
  private fillTimer?: ReturnType<typeof setTimeout>;
  private pendingWarm?: WarmOptions;
  private invalidationTimer?: ReturnType<typeof setTimeout>;
  private previousPhase = "idle";
  private savedStatus?: CacheStatus;
  private closed = false;
  private accountNames = new Map<string, string>();
  private paging = new Map<string, { keys: string[]; epoch: string; revision: number; reset?: boolean }>();
  constructor(private native: any, cache?: LocalMailCache) {
    this.cache = cache || new LocalMailCache(native);
    this.cache.onChange = (status) => {
      if (this.previousPhase === "index" && status.phase !== "index") this.invalidate();
      this.previousPhase = status.phase;
      if (!this.publishTimer) this.publishTimer = setTimeout(() => { this.publishTimer = undefined; void this.publish(); }, 150);
    };
    this.ready = this.initialize();
    this.listenDirect();
  }
  /**
   * Read requests from Ember pages over a BroadcastChannel (cache-client.ts). runtime.sendMessage between
   * the page and this background passes through Thunderbird's main process, which is busiest exactly when
   * Ember starts (accounts, folders, connections): the 14 snapshot round trips took 4–5 s at a cold start
   * against ~1 s on a reload. The channel doesn't wait for Thunderbird's main thread.
   */
  private listenDirect() {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(CACHE_CHANNEL);
    channel.onmessage = (event: MessageEvent) => {
      const data = event.data;
      if (data?.kind === "ping" && typeof data.from === "string") { channel.postMessage({ kind: "pong", to: data.from }); return; }
      if (data?.kind !== "request" || typeof data.id !== "string" || !DIRECT_COMMANDS.has(data.message?.command)) return;
      void this.request(data.message).then((response) => channel.postMessage({ kind: "response", id: data.id, response }));
    };
  }
  private async initialize() {
    const saved = await this.native.storage.local.get({ cachePaused: false, cacheStatus: undefined });
    await this.cache.init();
    for (const account of await this.native.accounts?.list().catch(() => []) || []) this.accountNames.set(account.id, account.name);
    // An empty database with a saved status: it was cleared or evicted (storage.local outlives it). Claiming a
    // recent inventory would serve views from a near-empty cache and skip re-listing mail for hours.
    if (saved.cacheStatus && !this.cache.empty) {
      const previous = saved.cacheStatus as CacheStatus;
      Object.assign(this.cache.status, { total: previous.total, done: previous.done, failed: previous.failed, accounts: previous.accounts, lastCompletedAt: previous.lastCompletedAt, lastInventoryAt: previous.lastInventoryAt, failures: previous.failures });
      // A background restart (Thunderbird can suspend it) mustn't redo a recent inventory.
      if (previous.lastInventoryAt) this.cache.lastInventoryAt = previous.lastInventoryAt;
    }
    if (saved.cachePaused) this.cache.setPaused(true);
    await this.publish();
  }
  close() { this.closed = true; clearTimeout(this.publishTimer); clearTimeout(this.fillTimer); clearTimeout(this.invalidationTimer); this.cache.close(); }
  private snapshotStatus(): CacheStatus { return { ...this.cache.status, accounts: Object.fromEntries(Object.entries(this.cache.status.accounts || {}).map(([id, progress]) => [id, { ...progress, name: this.accountNames.get(id) }])) }; }
  private async publish() {
    this.savedStatus = this.snapshotStatus();
    await this.native.storage.local.set({ cacheStatus: this.savedStatus }).catch(() => {});
  }
  private invalidate() {
    clearTimeout(this.invalidationTimer);
    this.invalidationTimer = setTimeout(() => { void this.native.runtime.sendMessage({ type: "spark:cache-invalidated" }).catch(() => {}); }, 150);
  }
  /** Saved mail since a time, or null when the cache may not be current (not loaded, paused, or no
   *  inventory in the last 2 hours): callers then ask Thunderbird. */
  async recentMail(since: number): Promise<MessageHeader[] | null> {
    await this.ready;
    const now = Date.now();
    if (this.cache.status.phase === "paused" || now - (this.cache.lastInventoryAt || 0) > 2 * 3600000 || since < now - 89 * 86400000) return null;
    return this.cache.all().filter((m) => +new Date(m.date) >= since);
  }
  /** Every saved header (for "Before your meeting" counts). */
  async headers(): Promise<MessageHeader[]> { await this.ready; return this.cache.all(); }
  /** An email's saved content, if it's saved (AI sorting). */
  async saved(id: number): Promise<MessagePart | undefined> { await this.ready; return this.cache.body(id); }
  async start() { await this.ready; this.schedule({ inventory: Date.now() - (this.cache.lastInventoryAt || 0) >= INVENTORY_INTERVAL_MS, whenIdle: true }); }
  /** Periodic wake-up: inventory only when the last one is old; otherwise just finish pending bodies. */
  tick() { this.schedule({ inventory: Date.now() - (this.cache.lastInventoryAt || 0) >= INVENTORY_INTERVAL_MS, whenIdle: true }); }
  schedule(options: WarmOptions = { inventory: false }) {
    if (this.closed) return;
    clearTimeout(this.fillTimer);
    const queued = this.pendingWarm;
    this.pendingWarm = queued ? { inventory: !!(queued.inventory || options.inventory), whenIdle: !!(queued.whenIdle && options.whenIdle) } : options;
    this.fillTimer = setTimeout(() => {
      const warm = this.pendingWarm; this.pendingWarm = undefined;
      void this.ready.then(() => perf.track("cache-owner.pass", this.cache.warm(warm), { inventory: !!warm?.inventory, whenIdle: !!warm?.whenIdle })).then(() => this.publish()).catch(() => {});
    }, 500);
  }
  private async drain(first: MessageList): Promise<MessageHeader[]> {
    const messages: MessageHeader[] = []; let page = first;
    while (page) { messages.push(...page.messages); if (!page.id) break; page = await this.native.messages.continueList(page.id); }
    return messages;
  }
  async received(first: MessageList) { await this.ready; this.cache.register(await this.drain(first), true); await this.cache.flush(); this.invalidate(); this.schedule(); }
  async changed(message: MessageHeader, changes: Partial<MessageHeader>) { await this.ready; this.cache.changed(message, changes); await this.cache.flush(); this.invalidate(); if (changes.flagged !== undefined) this.schedule(); }
  async moved(first: MessageList, second: MessageList) { await this.ready; const [originals, moved] = await Promise.all([this.drain(first), this.drain(second)]); this.cache.remove(originals); this.cache.register(moved, true); await this.cache.flush(); this.invalidate(); this.schedule(); }
  async deleted(first: MessageList) { await this.ready; this.cache.remove(await this.drain(first)); await this.cache.flush(); this.invalidate(); }
  reader(port: any) {
    let disconnected = false; let release: (() => void) | undefined;
    port.onDisconnect.addListener(() => { disconnected = true; release?.(); });
    void this.ready.then(() => { if (!disconnected) release = this.cache.hold(); });
  }
  async request(message: any): Promise<{ ok: boolean; value?: any; error?: string }> {
    if (message.command === "perf") return { ok: true, value: perf.recent() };
    const end = perf.span(`cache-owner.${message.command}`);
    try {
      await this.ready;
      const ref = message.ref;
      let id: number | undefined;
      if (ref) {
        if (ref.header?.id >= 0 && messageKey(ref.header) === ref.key) this.cache.register([ref.header]);
        id = typeof ref.id === "number" && ref.id >= 0 ? ref.id : this.cache.idForKey(ref.key);
        if (id === undefined && !["body", "files", "headers"].includes(message.command)) throw new Error("This saved email was moved or deleted. Refresh the mailbox.");
      }
      let value: any;
      switch (message.command) {
        case "snapshot": {
          if (!message.limit) { value = { ...this.cache.changesSince(-1), status: this.snapshotStatus() }; break; }
          // Paged: one structured clone of every header blocks the shared extension thread (~140 ms
          // for 3,000); pages keep each task short. The client catches up from `revision` afterwards.
          const offset = Number(message.offset) || 0, limit = Number(message.limit);
          let paging = this.paging.get(message.token);
          if (!paging && offset > 0) { value = { expired: true }; break; }
          if (!paging || offset === 0) { paging = this.cache.snapshotKeys(); this.paging.set(message.token, paging); }
          const end = offset + limit;
          const next = end < paging.keys.length ? end : null;
          const headers = this.cache.headersFor(paging.keys.slice(offset, end));
          value = { epoch: paging.epoch, revision: paging.revision, reset: true, ...(message.compact ? packFolders(headers) : { headers }), removed: [], next, status: this.snapshotStatus() };
          if (next === null) this.paging.delete(message.token);
          while (this.paging.size > 4) this.paging.delete(this.paging.keys().next().value!);
          break;
        }
        case "changes": {
          if (!message.limit) { value = { ...this.cache.changesSince(Number(message.since), message.epoch), status: this.snapshotStatus() }; break; }
          // Paged like the snapshot: a large catch-up (thousands of new headers) in one clone stalls the page.
          const offset = Number(message.offset) || 0, limit = Number(message.limit), token = `changes:${message.token}`;
          let paging = this.paging.get(token) as ReturnType<LocalMailCache["changedKeys"]> | undefined;
          if (!paging && offset > 0) { value = { expired: true }; break; }
          if (!paging || offset === 0) { paging = this.cache.changedKeys(Number(message.since), message.epoch); this.paging.set(token, paging); }
          const end = offset + limit, next = end < paging.keys.length ? end : null;
          const { headers, removed } = this.cache.splitKeys(paging.keys.slice(offset, end));
          value = { epoch: paging.epoch, revision: paging.revision, reset: paging.reset, ...(message.compact ? packFolders(headers) : { headers }), removed: paging.reset ? [] : removed, next, status: this.snapshotStatus() };
          if (next === null) this.paging.delete(token);
          while (this.paging.size > 4) this.paging.delete(this.paging.keys().next().value!);
          break;
        }
        case "refresh": this.cache.clearFailures(); this.schedule({ inventory: true }); value = this.snapshotStatus(); break;
        case "pause": await this.native.storage.local.set({ cachePaused: !!message.paused }); this.cache.setPaused(!!message.paused); await this.publish(); if (!message.paused) this.schedule({ inventory: true, whenIdle: true }); value = this.snapshotStatus(); break;
        // New or changed headers a page listed (e.g. mail that arrived already read): fetch and index their bodies
        // soon, not at the next periodic pass.
        case "register": this.cache.register(message.messages.filter((header: MessageHeader) => header.id >= 0), !!message.revive); this.schedule({ inventory: false, whenIdle: true }); break; // keeps a pending inventory waiting for idle
        case "changed": { const current = message.message.id >= 0 ? message.message : this.cache.header(messageKey(message.message)); if (current) this.cache.changed(current, message.changes); break; }
        case "remove": this.cache.removeKeys(message.messages.map(messageKey)); break;
        case "headers": value = id === undefined ? undefined : (await this.cache.body(id))?.headers; break;
        case "body": value = id === undefined ? undefined : await this.cache.body(id); break;
        case "files": value = id === undefined ? undefined : await this.cache.files(id); break;
        case "message": { const full = await this.cache.fetch("bodies", id!, message.args || []); value = { full, atts: await this.cache.files(id!) }; break; }
        case "fetch": if (!["bodies", "files"].includes(message.store)) throw new Error("Unknown cached content."); value = await this.cache.fetch(message.store, id!, message.args || []); break;
        case "resolve": value = await this.cache.resolve(id!); break;
        case "attachmentIndex": value = await this.cache.attachmentIndex(); break;
        case "attachmentKeys": value = await this.cache.attachmentKeys(); break;
        case "linkIndex": value = await this.cache.linkIndex(); break;
        case "search": {
          const result = await this.cache.search(String(message.query || ""), message.filters || {});
          // Pages mirror every saved header: keys are enough (thousands of full headers took ~0.3 s to pass over).
          value = message.keysOnly ? { keys: result.messages.map(messageKey), indexed: result.indexed, cached: result.cached } : result;
          break;
        }
        case "headersFor": value = this.cache.headersFor(Array.isArray(message.keys) ? message.keys : []); break;
        default: throw new Error("Unknown cache request.");
      }
      end({ items: Array.isArray(value) ? value.length : Array.isArray(value?.headers) ? value.headers.length : undefined });
      return { ok: true, value };
    } catch (error: any) { end({ failed: true }); return { ok: false, error: error?.message || String(error) }; }
  }
}
