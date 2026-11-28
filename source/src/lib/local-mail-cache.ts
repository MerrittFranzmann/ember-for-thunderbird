import { fingerprint, HeaderInterner } from "./intern";
import type { MessageAttachment, MessageHeader, MessagePart } from "./types";
import { searchDocument, searchTerms, searchPhrases, headerSearchText, matchesSearchHeader, matchesSearchText, type SearchFilters, type SearchDocument, type SearchResult } from "./mail-search";
import { RequestTimeout, withDeadline } from "./async";
import { perf } from "./perf-recorder";
import { isFileAttachment } from "./attachments";
import { messageLinks, type FoundLink } from "./link-library";

const DAY = 86400000;
/** Background inventories wait this long after the last reading/scrolling activity. */
export const INVENTORY_IDLE_MS = 5000;
/** Between full inventories, a pass re-lists only folders whose counts changed (see fill). */
export const FULL_INVENTORY_MS = 6 * 3600000;
/** Options for a cache pass. `inventory` re-queries 90 days of mail across every folder (expensive in
 * Thunderbird); without it only known headers missing bodies are fetched. `whenIdle` defers the
 * inventory until the user is idle and abandons it as soon as they read or scroll again. */
export interface WarmOptions { inventory?: boolean; whenIdle?: boolean }
const STORES = ["headers", "bodies", "files", "search", "links"] as const;
type StoreName = typeof STORES[number];
export interface AccountCacheStatus { name?: string; total: number; done: number; failed: number; }
export type CacheStatus = { phase: "idle" | "index" | "bodies" | "ready" | "error" | "paused"; accounts?: Record<string, AccountCacheStatus>; lastCompletedAt?: number; lastInventoryAt?: number; total: number; done: number; failed: number; saved: number; error?: string;
  /** Why recent emails couldn't be saved ("account /folder: error"), newest first: diagnostics only. */
  failures?: string[] };
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
/** Folder + immutable envelope distinguish copies without persisting Thunderbird's session IDs. */
export function messageKey(message: MessageHeader): string {
  return JSON.stringify([message.folder?.id || "", (message.headerMessageId || "").replace(/^<|>$/g, ""), +new Date(message.date), message.author, message.subject, message.size]);
}
/** Headers changed since a tab's last sync; `reset` means the tab must replace its copy. */
export interface HeaderChanges { epoch: string; revision: number; reset: boolean; headers: MessageHeader[]; removed: string[] }
export function keepMessage(message: MessageHeader, now = Date.now()): boolean {
  return !!message.flagged || +new Date(message.date) >= now - 90 * DAY;
}


/** Conservative shortcut: only ordinary, fully parsed text MIME can prove there are no files. */
export function hasOnlyInlineText(part: MessagePart, root = true): boolean {
  const type = (part.contentType || "").toLowerCase().split(";")[0].trim();
  const headers = Object.fromEntries(Object.entries(part.headers || {}).map(([key, values]) => [key.toLowerCase(), values]));
  const disposition = (headers["content-disposition"] || []).join(" ").toLowerCase();
  if (part.name || /attachment|filename\*?\s*=/i.test(disposition) || /\bname\*?\s*=/i.test((headers["content-type"] || []).join(" ")) || headers["content-id"]?.length || (part as any).decryptionStatus === "fail") return false;
  if (part.parts?.length) {
    if (!(type.startsWith("multipart/") || (root && type === "message/rfc822"))) return false;
    return part.parts.every((child) => hasOnlyInlineText(child, false));
  }
  return (type === "text/plain" || type === "text/html") && typeof part.body === "string";
}

/** Persistent headers, MIME bodies and attachment metadata. Attachment bytes stay on demand. */
export class LocalMailCache {
  private db?: IDBDatabase;
  private opening?: Promise<void>;
  private headers = new Map<string, MessageHeader>();
  private handles = new Map<number, string>();
  private liveIds = new Map<string, number>();
  private synthetic = new Map<string, number>();
  private sequence = -1;
  private writing = Promise.resolve();
  private warming?: Promise<void>;
  private generation = 0;
  /** When each saved email was first added this session: an inventory never removes one added after it began
   *  (new mail arriving in a folder the inventory had already passed isn't in what it found). */
  private addedAt = new Map<string, number>();
  private tombstones = new Set<string>();
  private updates = new Map<string, Partial<MessageHeader>>();
  private requests = new Map<string, Promise<any>>();
  private bodyKeys = new Set<string>();
  private fileKeys = new Set<string>();
  private searchKeys = new Set<string>();
  private paused = false;
  /** Fingerprint of each header as saved on disk, to write only real changes (a full JSON copy per
   *  header used to be kept for this). 0: rewrite next time. */
  private headerValues = new Map<string, number>();
  private interner = new HeaderInterner();
  private foregroundHolds = 0;
  private foregroundWaiters = new Set<() => void>();
  private repeatWarm: WarmOptions | undefined;
  private attachmentKeySet?: Set<string>;
  private lastActivity = 0;
  lastInventoryAt = 0;
  /** Nothing was saved on disk at start-up (first run, or the database was cleared or evicted): saved
   *  inventory state (storage.local outlives the database) must not be trusted. */
  empty = false;
  /** Each folder's counts at the last inventory ("total:unread:new"), and when the last full one ran. */
  private folderMarks = new Map<string, string>();
  private lastFullInventoryAt = 0;

  /** Folder counts survive a background restart (Thunderbird suspends idle backgrounds). */
  private async saveFolderMarks() {
    await Promise.resolve(this.backend.storage?.local?.set({ cacheFolderMarks: { at: this.lastFullInventoryAt || Date.now(), full: this.lastFullInventoryAt, marks: Object.fromEntries(this.folderMarks) } })).catch(() => {});
  }
  private async loadFolderMarks() {
    try {
      const { cacheFolderMarks } = await this.backend.storage.local.get("cacheFolderMarks");
      if (!cacheFolderMarks?.marks) return;
      this.folderMarks = new Map(Object.entries(cacheFolderMarks.marks));
      this.lastFullInventoryAt = Number(cacheFolderMarks.full) || 0;
    } catch { /* full inventory next time */ }
  }

  /** Every real folder's counts: one cheap folder-info request each. */
  private async folderSignatures(): Promise<Map<string, string> | null> {
    try {
      const accounts = await this.backend.accounts.list(true);
      const ids: string[] = [];
      const walk = (folders: any[] | undefined) => { for (const f of folders || []) { if (!f.isVirtual && !f.isUnified && !f.isTag) ids.push(f.id); walk(f.subFolders); } };
      for (const account of accounts || []) walk(account.folders ?? account.rootFolder?.subFolders);
      const out = new Map<string, string>();
      for (let i = 0; i < ids.length; i += 20) {
        const batch = await Promise.all(ids.slice(i, i + 20).map((id) => Promise.resolve(this.backend.folders.getFolderInfo(id)).then(
          (info: any) => [id, `${info?.totalMessageCount}:${info?.unreadMessageCount}:${info?.newMessageCount ?? 0}`] as const,
          () => [id, ""] as const)));
        for (const [id, mark] of batch) out.set(id, mark);
      }
      return out;
    } catch { return null; }
  }

  /**
   * What an inventory must re-list. A full inventory (every 6 h, or with nothing to compare against) asks
   * Thunderbird for 90 days of mail across every folder: ~10 s and ~6 s of its main thread at 13,500 emails,
   * every 30 minutes. In between, only folders whose counts changed are listed, and only their recent mail
   * (see fill): new, moved and changed mail already reaches the cache as events, so it's a safety net.
   */
  private async inventoryPlan(): Promise<{ full: boolean; changed: Set<string>; marks: Map<string, string> }> {
    const marks = await this.folderSignatures();
    const full = !marks || !this.folderMarks.size || Date.now() - this.lastFullInventoryAt >= FULL_INVENTORY_MS;
    const changed = new Set<string>();
    if (marks && !full) for (const [id, mark] of marks) if (!mark || this.folderMarks.get(id) !== mark) changed.add(id);
    return { full, changed, marks: marks ?? new Map() };
  }
  // Tabs sync deltas from this log instead of re-cloning every header on each change.
  readonly epoch = Math.random().toString(36).slice(2);
  private revision = 0;
  private changeLog = new Map<string, number>();
  private touch(key: string) { this.changeLog.delete(key); this.changeLog.set(key, ++this.revision); }
  status: CacheStatus = { phase: "idle", total: 0, done: 0, failed: 0, saved: 0 };
  onChange?: (status: CacheStatus) => void;
  onBody?: (message: MessageHeader, body: MessagePart) => void;
  constructor(private backend: any, private name = "spark-mail-cache") {}
  private progress(update: Partial<CacheStatus>) {
    this.status = { ...this.status, ...update, saved: this.headers.size };
    this.onChange?.(this.status);
  }
  async init() {
    if (this.opening) return this.opening;
    this.opening = (async () => {
      if (typeof indexedDB === "undefined") return;
      const done = perf.span("cache-owner.init");
      const request = indexedDB.open(this.name, 3);
      request.onupgradeneeded = () => {
        for (const name of STORES) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
        const search = request.transaction!.objectStore("search");
        if (!search.indexNames.contains("terms")) search.createIndex("terms", "terms", { multiEntry: true });
      };
      this.db = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("Local cache is busy in another window."));
      });
      const [rows, bodies, files, searches] = await Promise.all([
        this.read<[string, MessageHeader][]>("headers", undefined, true), this.keys("bodies"), this.keys("files"), this.keys("search"),
      ]);
      this.bodyKeys = new Set(bodies);
      this.fileKeys = new Set(files);
      this.searchKeys = new Set(searches);
      this.db.onversionchange = () => this.close();
      for (const [key, header] of rows || []) {
        header.date = new Date(header.date);
        if (!keepMessage(header)) { this.removeKey(key); continue; }
        this.interner.header(header);
        const id = this.sequence--;
        header.id = id;
        this.synthetic.set(key, id);
        this.handles.set(id, key);
        this.headers.set(key, header);
      }
      this.empty = !rows?.length;
      if (!this.empty) await this.loadFolderMarks(); // else the first inventory is a full one
      done({ headers: this.headers.size });
      this.progress({ phase: "idle" });
    })().catch((error) => { this.progress({ phase: "error", error: String(error?.message || error) }); });
    return this.opening;
  }
  private read<T>(store: StoreName, key?: string, entries = false): Promise<T | undefined> {
    if (!this.db) return Promise.resolve(undefined);
    return new Promise((resolve, reject) => {
      const object = this.db!.transaction(store).objectStore(store);
      if (entries) {
        // Two bulk reads (keys and values come back in the same key order) instead of a cursor, which
        // costs a round trip per record: tens of thousands at start-up.
        const keys = object.getAllKeys(), values = object.getAll();
        values.onsuccess = () => {
          const all = values.result, ids = keys.result;
          if (!ids || ids.length !== all.length) { reject(new Error("Local cache changed while reading")); return; }
          resolve(all.map((value, i) => [String(ids[i]), value]) as T);
        };
        values.onerror = () => reject(values.error);
        keys.onerror = () => reject(keys.error);
      } else {
        const request = object.get(key!);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }
    });
  }
  private keys(store: StoreName): Promise<string[]> {
    if (!this.db) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const request = this.db!.transaction(store).objectStore(store).getAllKeys();
      request.onsuccess = () => resolve(request.result.map(String));
      request.onerror = () => reject(request.error);
    });
  }
  private writeMany(store: StoreName, rows: [string, unknown][]) {
    if (!this.db || !rows.length) return Promise.resolve();
    const data = rows.map(([key, value]) => [key, value === undefined ? undefined : plain(value)] as const);
    const task = this.writing.then(() => new Promise<void>((resolve, reject) => {
      const transaction = this.db!.transaction(store, "readwrite");
      const object = transaction.objectStore(store);
      for (const [key, value] of data) { if (value === undefined) object.delete(key); else object.put(value, key); }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error("Local cache write interrupted"));
    }));
    this.writing = task.catch((error) => this.progress({ phase: "error", error: String(error?.message || error) }));
    return task;
  }
  private write(store: StoreName, key: string, value: unknown) { return this.writeMany(store, [[key, value]]); }
  async flush() { await this.writing; }
  register(messages: MessageHeader[], revive = false) {
    if (!this.backend?.messages) return;
    const changed: [string, unknown][] = [];
    for (const original of messages) {
      const message = { ...original, ...this.updates.get(messageKey(original)) };
      const key = this.handles.get(message.id) && message.id < 0 ? this.handles.get(message.id)! : messageKey(message);
      if (revive) this.tombstones.delete(key);
      if (this.tombstones.has(key)) continue;
      this.handles.set(message.id, key);
      if (message.id >= 0) this.liveIds.set(key, message.id);
      if (keepMessage(message)) {
        const existing = this.headers.get(key);
        if (!existing) this.addedAt.set(key, Date.now());
        const header = this.interner.header({ ...plain(message), date: new Date(message.date) });
        this.headers.set(key, header);
        // Session IDs are deliberately absent on disk.
        const { id, ...persisted } = header;
        const value = fingerprint(JSON.stringify(persisted));
        // What's on disk, serialized only when first compared (not for every header at start-up).
        let previous = this.headerValues.get(key);
        if (previous === undefined && existing) { const { id: _id, ...stored } = existing; previous = fingerprint(JSON.stringify(stored)); }
        if (value !== previous) { this.headerValues.set(key, value); changed.push([key, persisted]); this.touch(key); }
      } else if (this.headers.has(key)) this.removeKey(key);
    }
    void this.writeMany("headers", changed).catch(() => { for (const [key] of changed) this.headerValues.set(key, 0); }); // rewritten next time
    this.progress({});
  }
  all(): MessageHeader[] {
    return Array.from(this.headers, ([key, header]) => {
      let id = this.liveIds.get(key) ?? this.synthetic.get(key);
      if (id === undefined) { id = this.sequence--; this.synthetic.set(key, id); this.handles.set(id, key); }
      return { ...header, date: new Date(header.date), id };
    }).filter((header) => keepMessage(header));
  }
  async files(id: number): Promise<MessageAttachment[] | undefined> {
    const key = this.handles.get(id); if (!key) return undefined;
    const value = await this.read<MessageAttachment[]>("files", key);
    if (value !== undefined) this.fileKeys.add(key);
    return value;
  }
  async body(id: number): Promise<MessagePart | undefined> {
    const key = this.handles.get(id); if (!key) return undefined;
    const value = await this.read<MessagePart>("bodies", key);
    if (value !== undefined) this.bodyKeys.add(key);
    return value;
  }
  /** Keys of cached messages whose attachment lists include real files (not inline images). */
  async attachmentKeys(): Promise<string[]> {
    await this.init();
    if (!this.attachmentKeySet) {
      this.attachmentKeysLoading ||= (async () => {
        this.attachmentKeyEdits = new Map();
        await this.flush(); // lists saved just before this started are on disk; later ones are in the edits
        const rows = await this.read<[string, MessageAttachment[]][]>("files", undefined, true) || [];
        const set = new Set(rows.filter(([, files]) => Array.isArray(files) && files.some(isFileAttachment)).map(([key]) => key));
        // File lists saved or removed while reading may not be in the read: they win.
        for (const [key, has] of this.attachmentKeyEdits) { if (has) set.add(key); else set.delete(key); }
        this.attachmentKeyEdits = undefined;
        this.attachmentKeySet = set;
      })().finally(() => { this.attachmentKeysLoading = undefined; this.attachmentKeyEdits = undefined; });
      await this.attachmentKeysLoading;
    }
    return [...(this.attachmentKeySet || [])].filter((key) => this.headers.has(key));
  }
  private attachmentKeysLoading?: Promise<void>;
  private attachmentKeyEdits?: Map<string, boolean>;
  async save(store: "files" | "bodies", id: number, data: any) {
    const key = this.handles.get(id);
    if (key && this.headers.has(key)) {
      if (store === "files") {
        const has = Array.isArray(data) && data.some(isFileAttachment);
        if (this.attachmentKeySet) { if (has) this.attachmentKeySet.add(key); else this.attachmentKeySet.delete(key); }
        else this.attachmentKeyEdits?.set(key, has);
      }
      await this.write(store, key, data);
      if (this.headers.has(key)) (store === "bodies" ? this.bodyKeys : this.fileKeys).add(key);
      // Each email's shared-file links, for Attachments → Links (extracted once, here).
      if (store === "bodies" && this.headers.has(key)) await this.write("links", key, messageLinks(data)).catch(() => {});
    }
  }
  async fetch(store: "bodies" | "files", id: number, args: any[] = []) {
    const saved = store === "bodies" ? await this.body(id) : await this.files(id);
    if (saved !== undefined) return saved;
    const key = `${store}:${this.handles.get(id) || id}`;
    let request = this.requests.get(key);
    if (!request) {
      request = (async () => {
        const current = await this.resolve(id);
        const result = await this.backend.messages[store === "bodies" ? "getFull" : "listAttachments"](current, ...args);
        await this.save(store, id, result).catch(() => {});
        const message = this.headers.get(this.handles.get(id) || "");
        if (message && !this.searchKeys.has(messageKey(message)) && this.bodyKeys.has(messageKey(message)) && this.fileKeys.has(messageKey(message))) {
          const body = store === "bodies" ? result : await this.body(id);
          const files = store === "files" ? result : await this.files(id);
          if (body && files) await this.indexMessage(message, body, files).catch(() => {});
        }
        return result;
      })().finally(() => this.requests.delete(key));
      this.requests.set(key, request);
    }
    return request;
  }
  /** Saved mail with real file attachments (not inline images), with its attachment lists. */
  async attachmentIndex(): Promise<{ message: MessageHeader; files: MessageAttachment[] }[]> {
    // Only those records: returning every email's (mostly empty) list sent ~13,500 records to the
    // page, which froze it for ~0.9 s on opening Attachments.
    await this.init();
    if (!this.db) throw new Error("Saved mail is unavailable."); // the library then asks Thunderbird
    const keys = await this.attachmentKeys();
    if (!keys.length) return [];
    const records = new Map<string, MessageAttachment[]>();
    await new Promise<void>((resolve, reject) => {
      const transaction = this.db!.transaction("files");
      const store = transaction.objectStore("files");
      for (const key of keys) { const request = store.get(key); request.onsuccess = () => { if (Array.isArray(request.result)) records.set(key, request.result); }; }
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
    });
    const now = Date.now();
    return Array.from(records, ([key, files]) => ({ message: this.allHeader(key)!, files })).filter(({ message }) => message && keepMessage(message, now));
  }
  /** Saved mail with shared-file or review links, with its links. Emails saved before links were kept are
   *  read once here (a few hundred bodies at a time) and their links saved. */
  async linkIndex(): Promise<{ message: MessageHeader; links: FoundLink[] }[]> {
    await this.init();
    if (!this.db) throw new Error("Saved mail is unavailable.");
    await this.flush();
    const saved = new Map(await this.read<[string, FoundLink[]][]>("links", undefined, true) || []);
    const missing = [...this.bodyKeys].filter((key) => this.headers.has(key) && !saved.has(key));
    for (let i = 0; i < missing.length; i += 200) {
      const chunk = missing.slice(i, i + 200);
      const bodies = new Map<string, MessagePart>();
      await new Promise<void>((resolve, reject) => {
        const transaction = this.db!.transaction("bodies");
        const object = transaction.objectStore("bodies");
        for (const key of chunk) { const request = object.get(key); request.onsuccess = () => { if (request.result) bodies.set(key, request.result); }; }
        transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
      });
      const rows: [string, FoundLink[]][] = [];
      for (const [key, body] of bodies) { const links = messageLinks(body); saved.set(key, links); rows.push([key, links]); }
      await this.writeMany("links", rows).catch(() => {});
    }
    const now = Date.now();
    const out: { message: MessageHeader; links: FoundLink[] }[] = [];
    for (const [key, links] of saved) {
      if (!links?.length || !this.headers.has(key)) continue;
      const message = this.allHeader(key);
      if (message && keepMessage(message, now)) out.push({ message, links });
    }
    return out;
  }
  private removeKey(key: string) {
    this.addedAt.delete(key);
    if (this.headers.has(key)) this.touch(key);
    this.attachmentKeySet?.delete(key); this.attachmentKeyEdits?.set(key, false);
    this.headers.delete(key);
    this.bodyKeys.delete(key); this.fileKeys.delete(key); this.searchKeys.delete(key); this.headerValues.delete(key);
    for (const store of STORES) void this.write(store, key, undefined).catch(() => {});
  }
  remove(messages: MessageHeader[]) { this.generation++; for (const message of messages) { const key = this.handles.get(message.id) || messageKey(message); this.tombstones.add(key); this.removeKey(key); } this.forgetFolderMarks(messages); this.progress({}); }
  /** A folder that lost mail may gain some and be back at the same counts (a draft replaced by a new one): its
   *  mark no longer proves it unchanged, so the next inventory (and the page's check) lists it again. */
  private forgetFolderMarks(messages: MessageHeader[]) {
    let changed = false;
    for (const message of messages) if (message.folder?.id && this.folderMarks.delete(message.folder.id)) changed = true;
    if (changed) void this.saveFolderMarks();
  }
  changed(message: MessageHeader, changes: Partial<MessageHeader>) { this.generation++; const key = this.handles.get(message.id) || messageKey(message); this.updates.set(key, { ...this.updates.get(key), ...changes }); this.register([{ ...message, ...changes }]); }
  async resolve(id: number): Promise<number> {
    if (id >= 0) return id;
    const key = this.handles.get(id);
    if (!key) throw new Error("This cached email is no longer available. Refresh the mailbox.");
    if (this.tombstones.has(key)) throw new Error("This email has been moved or deleted. Refresh the mailbox.");
    const live = this.liveIds.get(key);
    if (live !== undefined) return live;
    const message = this.headers.get(key);
    if (!message?.folder?.id) throw new Error("The original mailbox is unavailable.");
    const located = await this.locate(message);
    if (located && messageKey(located) === key) { this.register([located]); return located.id; }
    const date = +new Date(message.date);
    const query = message.headerMessageId ? { headerMessageId: message.headerMessageId.replace(/^<|>$/g, ""), folderId: message.folder.id } :
      { folderId: message.folder.id, fromDate: new Date(date - 1000), toDate: new Date(date + 1000) };
    let page = await withDeadline<any>(this.backend.messages.query(query), 20000, undefined, "Locating cached email");
    if (typeof page === "string") page = await this.backend.messages.continueList(page);
    const matches: MessageHeader[] = [];
    while (page) {
      matches.push(...page.messages.filter((candidate: MessageHeader) => messageKey(candidate) === key));
      if (!page.id) break;
      page = await withDeadline<any>(this.backend.messages.continueList(page.id), 20000, undefined, "Locating cached email");
    }
    if (matches.length !== 1) throw new Error("The original email could not be identified safely. Refresh the mailbox.");
    this.register(matches);
    return matches[0].id;
  }
  // Saved mail of folders the incremental inventory didn't re-list has no live id; a query to find one
  // scans the folder (~100 ms at 10k emails). sparkSearch.locate reads the folder's Message-ID index,
  // and lookups started together (archiving a selection, the body backfill) go in one call.
  private locating: { item: { folderId: string; headerMessageId: string }; resolve: (message: MessageHeader | null) => void }[] = [];
  private locate(message: MessageHeader): Promise<MessageHeader | null> {
    const locate = this.backend.sparkSearch?.locate;
    const headerMessageId = (message.headerMessageId || "").replace(/^<|>$/g, "");
    if (!locate || !headerMessageId || !message.folder?.id) return Promise.resolve(null);
    return new Promise((resolve) => {
      if (!this.locating.length) queueMicrotask(() => {
        const batch = this.locating; this.locating = [];
        Promise.resolve(locate(batch.map((entry) => entry.item))).then(
          (found: (MessageHeader | null)[]) => batch.forEach((entry, i) => entry.resolve(found?.[i] || null)),
          () => batch.forEach((entry) => entry.resolve(null)));
      });
      this.locating.push({ item: { folderId: message.folder!.id, headerMessageId }, resolve });
    });
  }
  header(key: string): MessageHeader | undefined { return this.allHeader(key); }
  /** A paged snapshot: the keys and change-log position to page through, then catch up from. */
  snapshotKeys(): { keys: string[]; epoch: string; revision: number } {
    // Newest first, so a client can show the top of its lists from the first page.
    const keys = Array.from(this.headers, ([key, header]) => [key, +new Date(header.date)] as const).sort((a, b) => b[1] - a[1]).map(([key]) => key);
    return { keys, epoch: this.epoch, revision: this.revision };
  }
  headersFor(keys: string[]): MessageHeader[] { return keys.flatMap((key) => { const header = this.allHeader(key); return header && keepMessage(header) ? [header] : []; }); }
  changesSince(since: number, epoch?: string): HeaderChanges {
    if (epoch !== this.epoch || since > this.revision) return { epoch: this.epoch, revision: this.revision, reset: true, headers: this.all(), removed: [] };
    const headers: MessageHeader[] = [], removed: string[] = [];
    // The log is ordered by revision (touch re-inserts), so stop at the first older entry from the end.
    const entries = Array.from(this.changeLog);
    for (let i = entries.length - 1; i >= 0 && entries[i][1] > since; i--) {
      const header = this.allHeader(entries[i][0]);
      if (header && keepMessage(header)) headers.push(header); else removed.push(entries[i][0]);
    }
    return { epoch: this.epoch, revision: this.revision, reset: false, headers, removed };
  }
  /** Keys changed since a log position (every key when the client must start over), for paging. */
  changedKeys(since: number, epoch?: string): { epoch: string; revision: number; reset: boolean; keys: string[] } {
    if (epoch !== this.epoch || since > this.revision) return { epoch: this.epoch, revision: this.revision, reset: true, keys: Array.from(this.headers.keys()) };
    const keys: string[] = [];
    const entries = Array.from(this.changeLog);
    for (let i = entries.length - 1; i >= 0 && entries[i][1] > since; i--) keys.push(entries[i][0]);
    return { epoch: this.epoch, revision: this.revision, reset: false, keys };
  }
  /** Current headers for keys, and the keys that are gone (moved out of the cache window or deleted). */
  splitKeys(keys: string[]): { headers: MessageHeader[]; removed: string[] } {
    const headers: MessageHeader[] = [], removed: string[] = [];
    for (const key of keys) { const header = this.allHeader(key); if (header && keepMessage(header)) headers.push(header); else removed.push(key); }
    return { headers, removed };
  }
  idForKey(key: string): number | undefined { return this.tombstones.has(key) ? undefined : this.liveIds.get(key) ?? this.allHeader(key)?.id; }
  removeKeys(keys: string[]) { this.generation++; for (const key of keys) { this.tombstones.add(key); this.removeKey(key); } this.progress({}); }
  private allHeader(key: string): MessageHeader | undefined {
    const header = this.headers.get(key); if (!header) return undefined;
    let id = this.liveIds.get(key) ?? this.synthetic.get(key);
    if (id === undefined) { id = this.sequence--; this.synthetic.set(key, id); this.handles.set(id, key); }
    return { ...header, id, date: new Date(header.date) };
  }
  setPaused(paused: boolean) {
    this.paused = paused;
    if (paused) { for (const wake of this.foregroundWaiters) wake(); this.foregroundWaiters.clear(); }
    this.progress({ phase: paused ? "paused" : "idle" });
  }
  private async indexMessage(message: MessageHeader, full: MessagePart, files: MessageAttachment[]) {
    const key = messageKey(message);
    if (!this.headers.has(key) || this.searchKeys.has(key)) return;
    await this.write("search", key, searchDocument(message, full, files));
    if (this.headers.has(key)) this.searchKeys.add(key);
  }
  async search(query: string, filters: SearchFilters = {}): Promise<SearchResult> {
    await this.init();
    const terms = searchTerms(query);
    let candidates: Set<string> | undefined;
    if (this.db && terms.length) {
      const postings = await Promise.all(terms.map((term) => new Promise<Set<string>>((resolve, reject) => {
        const request = this.db!.transaction("search").objectStore("search").index("terms").getAllKeys(IDBKeyRange.bound(term, term + "\uffff"));
        request.onsuccess = () => resolve(new Set(request.result.map(String)));
        request.onerror = () => reject(request.error);
      })));
      postings.sort((a, b) => a.size - b.size);
      candidates = postings.shift() || new Set();
      for (const posting of postings) candidates = new Set([...candidates].filter((key) => posting.has(key)));
    }
    const phrases = searchPhrases(query);
    // Plain words are answered by the term index (each indexed email's terms include its header text);
    // the full text is read only for quoted phrases or the attachment filter. Only matches are copied:
    // a common word used to read thousands of documents and copy every saved header (~0.5 s at 20k).
    const needsText = phrases.length > 0 || !!filters.hasAttachments;
    const now = Date.now();
    const matches: MessageHeader[] = [];
    const needed: string[] = [];
    let cached = 0;
    for (const [key, header] of this.headers) {
      if (!keepMessage(header, now)) continue;
      cached++;
      if (!matchesSearchHeader(header, filters)) continue;
      if (!this.searchKeys.has(key)) {
        // Not indexed yet: headers only.
        if (!filters.hasAttachments && matchesSearchText(headerSearchText(header), query)) matches.push(this.allHeader(key)!);
        continue;
      }
      if (terms.length && !candidates?.has(key)) continue;
      if (needsText) needed.push(key); else matches.push(this.allHeader(key)!);
    }
    if (this.db && needed.length) await new Promise<void>((resolve, reject) => {
      const transaction = this.db!.transaction("search");
      const object = transaction.objectStore("search");
      for (const key of needed) {
        const request = object.get(key);
        request.onsuccess = () => { const doc = request.result as SearchDocument | undefined; if (doc && (!filters.hasAttachments || doc.hasAttachments) && phrases.every((phrase) => doc.text.includes(phrase))) matches.push(this.allHeader(key)!); };
      }
      transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
    });
    const time = new Map(matches.map((m) => [m, +new Date(m.date)]));
    return { messages: matches.sort((a, b) => time.get(b)! - time.get(a)!), indexed: this.searchKeys.size, cached };
  }
  hold(): () => void {
    this.foregroundHolds++;
    this.lastActivity = Date.now();
    let released = false;
    return () => { if (released) return; released = true; this.lastActivity = Date.now(); if (--this.foregroundHolds === 0) { for (const wake of this.foregroundWaiters) wake(); this.foregroundWaiters.clear(); } };
  }
  // Emails whose body or attachment list couldn't be fetched wait 30 min, doubling to a day, before the
  // next try: a pass follows every new email, so one the server can't return was asked for again and
  // again (up to three failing requests, or a 20 s timeout, per new email). An explicit refresh retries now.
  private failures = new Map<string, { at: number; count: number }>();
  clearFailures() { this.failures.clear(); }
  private busy() { return this.foregroundHolds > 0 || Date.now() - this.lastActivity < INVENTORY_IDLE_MS; }
  private async waitForIdle() {
    while (!this.paused && this.busy()) await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(250, INVENTORY_IDLE_MS - (Date.now() - this.lastActivity)))));
  }
  private async waitForReader() {
    while (this.foregroundHolds > 0 && !this.paused) await new Promise<void>((resolve) => this.foregroundWaiters.add(resolve));
  }
  warm(options: WarmOptions = { inventory: true }): Promise<void> {
    if (this.paused) { this.progress({ phase: "paused" }); return Promise.resolve(); }
    if (this.warming) {
      const queued = this.repeatWarm;
      this.repeatWarm = queued ? { inventory: !!(queued.inventory || options.inventory), whenIdle: !!(queued.whenIdle && options.whenIdle) } : options;
      return this.warming;
    }
    this.warming = this.fill(options).finally(() => { this.warming = undefined; const next = this.repeatWarm; if (next) { this.repeatWarm = undefined; void this.warm(next); } });
    return this.warming;
  }
  private async fill({ inventory = true, whenIdle = false }: WarmOptions = {}) {
    await this.init();
    if (!this.db) return;
    if (inventory && whenIdle) await perf.track("cache-owner.wait-for-idle", this.waitForIdle());
    const inventoryDone = inventory ? perf.span("cache-owner.inventory") : undefined;
    if (this.paused) { this.progress({ phase: "paused" }); return; }
    const generation = this.generation;
    const startedAt = Date.now();
    const found = new Map<string, MessageHeader>();
    if (inventory) this.progress({ phase: "index", total: 0, done: 0, failed: 0, error: undefined });
    // Event-driven passes only complete what is already known (e.g. newly received mail).
    else this.progress({ done: 0, failed: 0, error: undefined });
    const plan = inventory ? await this.inventoryPlan() : undefined;
    const since = new Date(Date.now() - 90 * DAY);
    // Between full inventories a changed folder is listed only from shortly before the last pass: re-listing
    // 90 days of a busy inbox took ~6.4 s (8,900 emails), the last day ~130 ms. Older changes arrive as
    // events; the full inventory every 6 h catches anything missed.
    const recent = new Date(Math.max(since.getTime(), (this.lastInventoryAt || 0) - 10 * 60000));
    const queries: any[] = !plan ? [] : plan.full ? [{ fromDate: since }, { flagged: true }]
      : [...plan.changed].map((folderId) => ({ folderId, fromDate: recent }));
    try {
      for (const query of queries) {
        let page = await withDeadline<any>(this.backend.messages.query(query), 20000, undefined, "Caching mail index");
        if (typeof page === "string") page = await this.backend.messages.continueList(page);
        while (page) {
          if (this.paused) { if (page.id) void this.backend.messages.abortList?.(page.id); this.progress({ phase: "paused" }); return; }
          // Thunderbird searches every folder on its main thread; yield it back the moment the user is active.
          if (whenIdle && this.foregroundHolds > 0) { if (page.id) void this.backend.messages.abortList?.(page.id); inventoryDone?.({ abandoned: true }); this.progress({ phase: "idle" }); return; }
          this.register(page.messages);
          for (const header of page.messages) { const key = messageKey(header); const current = { ...header, ...this.updates.get(key) }; if (!this.tombstones.has(key) && keepMessage(current)) found.set(key, current); }
          this.progress({ total: found.size });
          if (!page.id) break;
          page = await withDeadline<any>(this.backend.messages.continueList(page.id), 20000, undefined, "Caching mail index");
        }
      }
      // A partial inventory only adds: everything saved stays, except mail of folders that no longer exist.
      if (plan && !plan.full) {
        for (const [key, header] of this.headers) {
          const folderId = header.folder?.id;
          if (!folderId || !plan.marks.has(folderId) || found.has(key) || this.tombstones.has(key)) continue;
          const current = { ...header, ...this.updates.get(key) };
          if (keepMessage(current)) found.set(key, current);
        }
      }
      // Only a complete, uninterrupted inventory may remove missing disk entries (a partial one: only those
      // of folders that no longer exist).
      if (this.paused) { this.progress({ phase: "paused" }); return; }
      if (inventory && generation === this.generation) for (const key of this.headers.keys()) if (!found.has(key) && (this.addedAt.get(key) ?? 0) < startedAt) this.removeKey(key);
      if (inventory && plan) {
        this.lastInventoryAt = Date.now();
        if (plan.full) this.lastFullInventoryAt = this.lastInventoryAt;
        if (plan.marks.size) { this.folderMarks = plan.marks; void this.saveFolderMarks(); }
        inventoryDone?.({ messages: found.size, full: plan.full, relisted: plan.full ? -1 : plan.changed.size });
      }
      // One walk over the kept mail: account totals, and only the incomplete emails are copied and sorted
      // (an event-driven pass at 20k+ emails used to copy and date-sort all of them on every new email).
      const now = Date.now();
      const accounts: Record<string, AccountCacheStatus> = {};
      const queue: { message: MessageHeader; priority: number; time: number }[] = [];
      let total = 0, deferred = 0;
      for (const [key, header] of inventory ? found : this.headers) {
        if (!inventory && this.tombstones.has(key)) continue;
        const time = +new Date(header.date);
        if (!header.flagged && time < now - 90 * DAY) continue;
        // Spam isn't shown in Ember, and Thunderbird often can't hand its emails over ("An unexpected error
        // occurred" for Gmail's Spam: all 10 of the user's never-saved emails).
        if (header.folder?.specialUse?.includes("junk")) continue;
        total++;
        const entry = accounts[header.folder?.accountId || "unknown"] ||= { total: 0, done: 0, failed: 0 }; entry.total++;
        if (this.bodyKeys.has(key) && this.fileKeys.has(key) && this.searchKeys.has(key)) { entry.done++; continue; }
        const failure = this.failures.get(key);
        if (failure && now - failure.at < Math.min(DAY, 30 * 60000 * 2 ** (failure.count - 1))) { entry.failed++; deferred++; continue; }
        const message = inventory ? header : this.allHeader(key);
        if (message) queue.push({ message, priority: time >= now - 7 * DAY ? 0 : header.flagged ? 1 : 2, time });
      }
      const pending = queue.sort((a, b) => a.priority - b.priority || b.time - a.time).map((entry) => entry.message);
      this.progress({ phase: "bodies", total, done: total - pending.length - deferred, failed: deferred, accounts, ...(inventory ? { lastInventoryAt: this.lastInventoryAt } : {}) });
      const byAccount = (message: MessageHeader) => message.folder?.accountId || "unknown";
      const active = new Map<string, number>();
      const changed = new Set<() => void>();
      const wake = () => { for (const resolve of changed) resolve(); changed.clear(); };
      let consecutiveFailures = 0;
      let stopped = false;
      const worker = async () => {
        while (!stopped && !this.paused) {
          await this.waitForReader();
          if (stopped || this.paused) return;
          const index = pending.findIndex((message) => (active.get(byAccount(message)) || 0) < 2);
          if (index < 0) {
            if (!pending.length) return;
            await new Promise<void>((resolve) => changed.add(resolve));
            continue;
          }
          const [message] = pending.splice(index, 1);
          const account = byAccount(message);
          active.set(account, (active.get(account) || 0) + 1);
          let completed = false;
          try {
            if (!this.headers.has(messageKey(message))) continue;
            const body = await perf.track("cache-owner.fetch-body", withDeadline(this.fetch("bodies", message.id), 20000, undefined, "Caching email"));
            this.onBody?.(message, body);
            let files: MessageAttachment[];
            if (!this.fileKeys.has(messageKey(message)) && hasOnlyInlineText(body)) { files = []; await this.save("files", message.id, []); }
            else files = await withDeadline(this.fetch("files", message.id), 15000, undefined, "Caching attachment list");
            await this.indexMessage(message, body, files);
            completed = true;
            consecutiveFailures = 0;
            this.failures.delete(messageKey(message));
          } catch (error) {
            const key = messageKey(message);
            this.failures.set(key, { at: Date.now(), count: (this.failures.get(key)?.count || 0) + 1 });
            accounts[account].failed++;
            const reason = `${account} ${message.folder?.path || "?"}: ${String((error as any)?.message || error).slice(0, 160)}`;
            this.progress({ failed: this.status.failed + 1, accounts, failures: [reason, ...(this.status.failures || []).filter((r) => r !== reason)].slice(0, 10) });
            if (error instanceof RequestTimeout || ++consecutiveFailures >= 3) stopped = true;
          } finally {
            if (completed) accounts[account].done++;
            this.progress({ done: this.status.done + 1, accounts });
            active.set(account, active.get(account)! - 1);
            wake();
          }
        }
      };
      // Three background jobs globally, at most two per account; the reader retains capacity.
      await Promise.all([worker(), worker(), worker()]);
      if (pending.length && !this.paused) { for (const message of pending) accounts[byAccount(message)].failed++; this.progress({ failed: this.status.failed + pending.length, accounts }); }
      await this.flush();
      if (this.paused) { this.progress({ phase: "paused" }); return; }
      // Every email was tried (or waits after failing): the pass counts as complete, so views can rely on the
      // saved attachment lists. Requiring zero failures kept a mailbox with a few emails the server never
      // returns on Thunderbird's slow attachment search (1–2 s of its main thread per page) for good.
      const finished = !stopped && !pending.length;
      if (this.status.phase !== "error") this.progress({ phase: this.status.failed ? "error" : "ready", error: this.status.failed ? `${this.status.failed} emails need another attempt. Connect and retry.` : undefined, ...(finished ? { lastCompletedAt: Date.now() } : {}), ...(finished && !this.status.failed ? { failures: undefined } : {}) });
    } catch (error: any) { this.progress({ phase: "error", error: error?.message || String(error) }); }
  }
  close() { this.db?.close(); }
}

/** Preserve the native namespaces/events while translating restored message handles. */
export type MailCacheAccess = Pick<LocalMailCache, "register" | "body" | "files" | "fetch" | "resolve"> & { getCachedHeaders?: (id: number) => Promise<Record<string, string[]> | undefined> };
export function cachedAPI(native: any, cache: MailCacheAccess): any {
  if (!native) return native;
  const messages = new Proxy(native.messages, {
    get(target, property: string) {
      const method = target[property];
      if (typeof method !== "function") return method;
      if (["query", "list", "continueList", "get"].includes(property)) return async (...args: any[]) => {
        if (property === "get") args[0] = await cache.resolve(args[0]);
        const result = await method.apply(target, args);
        if (result?.messages) cache.register(result.messages);
        else if (property === "get" && result) cache.register([result]);
        return result;
      };
      if (property === "getFull" || property === "listAttachments") return async (id: number, ...args: any[]) => {
        const store = property === "getFull" ? "bodies" : "files";
        return cache.fetch(store, id, args);
      };
      if (["getHeaders", "getRaw", "getAttachmentFile", "openAttachment", "update"].includes(property)) return async (id: number, ...args: any[]) => {
        if (property === "getHeaders") { const headers = cache.getCachedHeaders ? await cache.getCachedHeaders(id) : (await cache.body(id))?.headers; if (headers) return headers; }
        const current = await cache.resolve(id);
        const result = await method.call(target, current, ...args);
        return result;
      };
      if (["archive", "delete", "move", "copy"].includes(property)) return async (ids: number[], ...args: any[]) => method.call(target, await Promise.all(ids.map((id) => cache.resolve(id))), ...args);
      return method.bind(target);
    },
  });
  const compose = native.compose && new Proxy(native.compose, { get(target, property: string) {
    const method = target[property];
    if (typeof method !== "function") return method;
    if (["beginReply", "beginForward", "beginNew"].includes(property)) return async (...args: any[]) => {
      if (typeof args[0] === "number") args[0] = await cache.resolve(args[0]);
      return method.apply(target, args);
    };
    return method.bind(target);
  } });
  const messageDisplay = native.messageDisplay && new Proxy(native.messageDisplay, { get(target, property: string) {
    const method = target[property];
    if (property === "open") return async (options: any) => method.call(target, { ...options, ...(options.messageId === undefined ? {} : { messageId: await cache.resolve(options.messageId) }) });
    return typeof method === "function" ? method.bind(target) : method;
  } });
  const sparkCalendar = native.sparkCalendar && new Proxy(native.sparkCalendar, { get(target, property: string) {
    const method = target[property];
    if (["serverResponse", "respond", "meetingStatus", "removeFromCalendar"].includes(property)) return async (id: number, ...args: any[]) => method.call(target, await cache.resolve(id), ...args);
    return typeof method === "function" ? method.bind(target) : method;
  } });
  // Search hits join the cache's ID map, like messages.query results.
  const sparkSearch = native.sparkSearch && new Proxy(native.sparkSearch, { get(target, property: string) {
    const method = target[property];
    if (property === "search") return async (...args: any[]) => { const result = await method.apply(target, args); if (result?.messages) cache.register(result.messages); return result; };
    return typeof method === "function" ? method.bind(target) : method;
  } });
  // Archive by Thunderbird's own ids; what failed is reported under the ids Ember gave (stand-in ids included).
  const sparkArchive = native.sparkArchive && new Proxy(native.sparkArchive, { get(target, property: string) {
    const method = target[property];
    if (property === "archive") return async (ids: number[]) => {
      const resolved = await Promise.allSettled(ids.map((id) => cache.resolve(id)));
      const failed: { id: number; error: string }[] = [];
      const live = new Map<number, number>();
      resolved.forEach((r, i) => {
        if (r.status === "fulfilled") live.set(r.value, ids[i]);
        else failed.push({ id: ids[i], error: String(r.reason?.message || r.reason).replace(/\.$/, "") });
      });
      if (live.size) {
        const result = await method.call(target, [...live.keys()]);
        for (const f of result?.failed || []) failed.push({ id: live.get(f.id) ?? f.id, error: f.error });
      }
      return { failed };
    };
    return typeof method === "function" ? method.bind(target) : method;
  } });
  // Spam verdicts by Thunderbird's own ids (an email Thunderbird no longer has is counted as missing).
  const sparkJunk = native.sparkJunk && new Proxy(native.sparkJunk, { get(target, property: string) {
    const method = target[property];
    if (property === "classify") return async (ids: number[], verdict: string) => {
      const resolved = await Promise.allSettled(ids.map((id) => withDeadline(cache.resolve(id), 15000, undefined, "Finding the email")));
      const live = resolved.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const result = live.length ? await method.call(target, live, verdict) : { trained: 0, updated: 0, missing: 0 };
      return { ...result, missing: (result?.missing || 0) + ids.length - live.length };
    };
    if (property === "guesses") return async (ids: number[]) => {
      const resolved = await Promise.allSettled(ids.map((id) => withDeadline(cache.resolve(id), 15000, undefined, "Finding the email")));
      const byLive = new Map<number, number>();
      resolved.forEach((r, i) => { if (r.status === "fulfilled") byLive.set(r.value, ids[i]); });
      const found: number[] = byLive.size ? await method.call(target, [...byLive.keys()]) : [];
      return (found || []).map((id) => byLive.get(id) ?? id);
    };
    return typeof method === "function" ? method.bind(target) : method;
  } });
  // Replies sent without a window: the email they answer by Thunderbird's own id.
  const sparkSend = native.sparkSend && new Proxy(native.sparkSend, { get(target, property: string) {
    const method = target[property];
    if (property === "send") return async (details: any, options: any) => method.call(target, details, { ...options, ...(typeof options?.relatedId === "number" ? { relatedId: await cache.resolve(options.relatedId) } : {}) });
    return typeof method === "function" ? method.bind(target) : method;
  } });
  return new Proxy(native, { get(target, property) { if (property === "messages") return messages; if (property === "compose") return compose; if (property === "messageDisplay") return messageDisplay; if (property === "sparkCalendar") return sparkCalendar; if (property === "sparkSearch") return sparkSearch; if (property === "sparkArchive") return sparkArchive; if (property === "sparkSend") return sparkSend; if (property === "sparkJunk") return sparkJunk; return target[property]; } });
}
