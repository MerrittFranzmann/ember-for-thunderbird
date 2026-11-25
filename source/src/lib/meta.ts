// Lazily fetched, persistently cached per-message metadata (category, snippet,
// threading references). Keyed by Message-ID so it survives restarts and moves
// (Thunderbird's numeric message ids are session-scoped).
//
// Two levels:
//   "h" — headers only (messages.getHeaders on TB 147+, else getFull): category + refs.
//   "f" — full message (messages.getFull): also the snippet.
// Visible rows are fetched at "f" with high priority; the rest of the inbox is
// classified in the background at "h" with low priority.

import { messageKey } from "./local-mail-cache";
import { api, env, mailCache } from "./api";
import { classify } from "./classify";
import { HeaderInterner } from "./intern";
import { extractBodies, makeSnippet } from "./body";
import { perf } from "./perf-recorder";
import type { MessageHeader, MessageMeta, MessagePart } from "./types";

const DB_NAME = "spark-meta";
const STORE = "meta";
const VERSION = 1;
const META_SCHEMA = 3; // bump to invalidate cached classifications

function keyOf(m: MessageHeader): string {
  return m.headerMessageId ? m.headerMessageId : `envelope:${messageKey(m)}`;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export function parseRefs(headers: Record<string, string[] | undefined>): string[] {
  const raw = [...(headers["references"] || []), ...(headers["in-reply-to"] || [])].join(" ");
  const out = raw.match(/<[^<>\s]+>/g) || [];
  return Array.from(new Set(out.map((s) => s.slice(1, -1))));
}

function lower(h: Record<string, any> | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!h) return out;
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = Array.isArray(v) ? v.map(String) : [String(v)];
  return out;
}

function partHasAttachment(p: MessagePart | undefined): boolean {
  if (!p) return false;
  const disp = (p.headers?.["content-disposition"]?.[0] || "").toLowerCase();
  if (disp.startsWith("attachment")) return true;
  if (p.name && !(p.contentType || "").startsWith("text/") && !disp.startsWith("inline")) return true;
  return (p.parts || []).some(partHasAttachment);
}

type Job = { msg: MessageHeader; level: "h" | "f" | "c"; prio: number };

export class MetaCache {
  private mem = new Map<string, MessageMeta>();
  /** Thread references repeat in every reply of a thread (up to 20 per email): keep one copy of each. */
  private interner = new HeaderInterner();
  private shareStrings(meta: MessageMeta): MessageMeta {
    if (meta.refs?.length) meta.refs = meta.refs.map((ref) => this.interner.string(ref));
    if (meta.listUnsubscribe) meta.listUnsubscribe = this.interner.string(meta.listUnsubscribe);
    return meta;
  }
  private db: IDBDatabase | null = null;
  private queues: Job[][] = [[], [], []];
  private pendingJobs = new Map<string, Job>();
  private inflight = new Set<string>();
  private running = 0;
  private dirty: [string, MessageMeta][] = [];
  private flushTimer: any = null;
  private notifyTimer: any = null;
  private groupingChanged = false;
  private threadingChanged = false;
  private notificationPending = false;
  me: Set<string> = new Set();
  /** groupingChanged: categories, threading references or attachment flags changed (lists regroup);
   *  threadingChanged: only categories or references (what conversation threading itself reads). */
  onChange: (groupingChanged?: boolean, threadingChanged?: boolean) => void = () => {};

  async init() {
    this.db = await openDb();
    if (!this.db) return;
    // Two bulk reads instead of a cursor: one round trip per request rather than per record
    // (tens of thousands of records at start-up).
    await new Promise<void>((resolve) => {
      const store = this.db!.transaction(STORE, "readonly").objectStore(STORE);
      const keys = store.getAllKeys(), values = store.getAll();
      values.onsuccess = () => {
        const all = values.result as (MessageMeta & { v?: number })[];
        const ids = keys.result; // same key order as the values
        if (ids?.length === all.length) for (let i = 0; i < all.length; i++) if (all[i]?.v === META_SCHEMA) this.mem.set(String(ids[i]), this.shareStrings(all[i]));
        resolve();
      };
      values.onerror = () => resolve();
    });
  }

  get(m: MessageHeader): MessageMeta | undefined {
    return this.mem.get(keyOf(m));
  }

  has(m: MessageHeader, level: "h" | "f" | "c"): boolean {
    const v = this.mem.get(keyOf(m));
    if (!v) return false;
    return level === "h" ? !!v.lvl : v.lvl === "f";
  }

  /** Queue a fetch. prio: 0 = visible now, 1 = selected-soon, 2 = background. */
  requestCached(m: MessageHeader) { this.request(m, "c", 2); }

  request(m: MessageHeader, level: "h" | "f" | "c", prio = 2) {
    if (this.has(m, level)) return;
    const k = keyOf(m) + level;
    if (this.inflight.has(k)) return;
    const existing = this.pendingJobs.get(k);
    if (existing && existing.prio <= prio) return;
    const job: Job = { msg: m, level, prio };
    this.pendingJobs.set(k, job);
    this.queues[prio].push(job);
    this.pump();
  }

  /** Resolves once every message has this level of meta (or failed), or after `timeout` ms. */
  settled(msgs: MessageHeader[], level: "h" | "f" | "c", timeout: number): Promise<void> {
    const ready = () => msgs.every((m) => this.has(m, level) || (!this.inflight.has(keyOf(m) + level) && !this.pendingJobs.has(keyOf(m) + level)));
    if (ready()) return Promise.resolve();
    return new Promise((resolve) => {
      const check = () => { if (ready()) finish(); };
      const finish = () => { clearTimeout(timer); this.settleWaiters.delete(check); resolve(); };
      const timer = setTimeout(finish, timeout);
      this.settleWaiters.add(check);
    });
  }
  private settleWaiters = new Set<() => void>();

  /** Deliver a pending change notification now, so the caller's own update lands in the same regroup. */
  notifyPending() { if (this.notifyTimer && !this.holds) this.notify(); }

  /** Drop low-priority background jobs (e.g. when the view changes). */
  clearBackground() {
    for (const j of this.queues[2]) {
      const k = keyOf(j.msg) + j.level;
      if (this.pendingJobs.get(k) === j) this.pendingJobs.delete(k);
    }
    this.queues[2] = [];
  }

  /** Drop previews for rows that have scrolled away; in-flight reads may finish. */
  clearVisible() {
    for (const job of this.queues[0]) {
      const key = keyOf(job.msg) + job.level;
      if (this.pendingJobs.get(key) === job) this.pendingJobs.delete(key);
    }
    this.queues[0] = [];
  }

  private next(allowBackground: boolean): Job | undefined {
    for (const q of allowBackground ? this.queues : this.queues.slice(0, 2)) {
      while (q.length) {
        const job = q.shift()!;
        const k = keyOf(job.msg) + job.level;
        if (this.pendingJobs.get(k) !== job) continue; // superseded
        this.pendingJobs.delete(k);
        return job;
      }
    }
    return undefined;
  }

  /**
   * Pause starting new fetches while the reader loads a message. Every getFull /
   * getHeaders streams the whole message (IMAP: a server fetch), Thunderbird
   * keeps ~5 connections per server, and TB fails a stream that hasn't started
   * within 20s ("Error reading message N") — so the reader must not queue behind us.
   */
  hold(): () => void {
    this.holds++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.holds--;
      if (!this.holds && this.notificationPending) this.notify();
      this.pump();
    };
  }
  private holds = 0;
  private bgRunning = 0;

  private pump() {
    const MAX = 3; // well under TB's per-server IMAP connection limit, leaves room for the reader
    const MAX_BG = 1; // background classification trickles, one message at a time
    while (this.running < MAX && this.holds === 0) {
      const job = this.next(this.bgRunning < MAX_BG);
      if (!job) break;
      if (this.has(job.msg, job.level)) continue;
      const k = keyOf(job.msg) + job.level;
      const bg = job.prio === 2;
      this.inflight.add(k);
      this.running++;
      if (bg) this.bgRunning++;
      this.run(job)
        .catch(() => {
          if (job.level === "c") return;
          // Unreadable right now (server busy/timeout, offline IMAP body, deleted…):
          // remember it for this session only — never persisted, so it's retried
          // next time instead of being stuck with an empty preview forever.
          const prev = this.mem.get(keyOf(job.msg)) || {};
          this.mem.set(keyOf(job.msg), { ...prev, cat: prev.cat ?? classify(job.msg.author, undefined, this.me, job.msg.subject), lvl: "f", snippet: prev.snippet ?? "", v: META_SCHEMA } as MessageMeta);
          this.groupingChanged = this.threadingChanged = true;
          this.scheduleNotification();
        })
        .finally(() => {
          this.inflight.delete(k);
          this.running--;
          if (bg) this.bgRunning--;
          for (const check of [...this.settleWaiters]) check();
          this.pump();
        });
    }
  }

  private async run(job: Job) {
    const done = perf.span("spark.preview", { level: job.level });
    try { await this.fetchJob(job); } finally { done(); }
  }

  private async fetchJob(job: Job) {
    const m = job.msg;
    if (job.level === "c") { const full = await mailCache.body(m.id); if (full) this.prime(m, full); return; }
    if (job.level === "h" && env.hasGetHeaders) {
      const raw = await api.messages.getHeaders(m.id);
      const headers = lower(raw);
      const ct = (headers["content-type"]?.[0] || "").toLowerCase();
      const prev = this.mem.get(keyOf(m));
      this.put(m, {
        ...prev,
        cat: classify(m.author, headers, this.me, m.subject),
        refs: parseRefs(headers),
        replyTo: headers["reply-to"]?.[0],
        listUnsubscribe: headers["list-unsubscribe"]?.[0],
        hasAtt: prev?.hasAtt ?? ct.startsWith("multipart/mixed"),
        lvl: prev?.lvl === "f" ? "f" : "h",
      });
      return;
    }
    const full: MessagePart = await api.messages.getFull(m.id);
    this.prime(m, full);
  }

  prime(m: MessageHeader, full: MessagePart) {
    if (this.has(m, "f")) return;
    const headers = lower(full.headers);
    const bodies = extractBodies(full);
    this.put(m, {
      cat: classify(m.author, headers, this.me, m.subject),
      refs: parseRefs(headers),
      replyTo: headers["reply-to"]?.[0],
      listUnsubscribe: headers["list-unsubscribe"]?.[0],
      hasAtt: partHasAttachment(full),
      snippet: makeSnippet(bodies),
      lvl: "f",
    });
  }

  put(m: MessageHeader, meta: MessageMeta) {
    const k = keyOf(m);
    const previous = this.mem.get(k);
    const threading = !previous || previous.cat !== meta.cat || JSON.stringify(previous.refs || []) !== JSON.stringify(meta.refs || []);
    this.groupingChanged ||= threading || !!previous.hasAtt !== !!meta.hasAtt;
    this.threadingChanged ||= threading;
    const v = this.shareStrings({ ...meta, v: META_SCHEMA } as MessageMeta);
    this.mem.set(k, v);
    this.dirty.push([k, v]);
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), 800);
    this.scheduleNotification();
  }

  private scheduleNotification() {
    if (!this.notifyTimer) this.notifyTimer = setTimeout(() => this.notify(), 120);
  }

  private notify() {
    clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    if (this.holds) { this.notificationPending = true; return; }
    this.notificationPending = false;
    const groupingChanged = this.groupingChanged, threadingChanged = this.threadingChanged;
    this.groupingChanged = this.threadingChanged = false;
    this.onChange(groupingChanged, threadingChanged);
  }

  private flush() {
    this.flushTimer = null;
    if (!this.db || !this.dirty.length) return;
    const batch = this.dirty;
    this.dirty = [];
    try {
      const tx = this.db.transaction(STORE, "readwrite");
      const st = tx.objectStore(STORE);
      for (const [k, v] of batch) st.put(v, k);
    } catch {
      /* best effort */
    }
  }

  get pending() {
    return this.pendingJobs.size + this.running;
  }
}
