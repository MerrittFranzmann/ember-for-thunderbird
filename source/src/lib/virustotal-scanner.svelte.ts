// The Ember window's VirusTotal checks (virustotal.ts): an attachment's SHA-256 is worked out here and looked
// up through the sparkScan Experiment, one request at a time within the free key's 4 a minute. Answers are kept
// by fingerprint in storage (`virusTotalResults`), so the same file in another email isn't asked about again.
// Uploading happens only from the user's click, then the analysis is followed until VirusTotal is done.
import { api } from "./api";
import { store } from "./store.svelte";
import type { MessageAttachment } from "./types";
import { BUSY, RateLimit, fresh, pruneResults, scanStats, threatName, validKey, verdict, type ScanResult } from "./virustotal";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
const POLL_MS = 20000;
const POLL_TRIES = 45; // about 15 minutes

class Scanner {
  /** By `${messageId}:${partName}`. */
  byPart = $state<Record<string, ScanResult>>({});
  private saved: Record<string, ScanResult> | null = null;
  private limit = new RateLimit(4);
  private line: Promise<unknown> = Promise.resolve();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  get key() { return String(store.settings.virusTotalKey || "").trim(); }
  get on() { return validKey(this.key) && typeof (api as any)?.sparkScan?.lookup === "function"; }
  result(messageId: number, a: MessageAttachment): ScanResult | undefined { return this.byPart[`${messageId}:${a.partName}`]; }

  private watching = false;
  private async load() {
    if (!this.watching) {
      this.watching = true;
      // Answers cleared or changed elsewhere (another window, Settings) aren't kept from memory.
      api.storage.onChanged?.addListener((changes: any, area: string) => {
        if (area === "local" && changes.virusTotalResults && !this.saveTimer) this.saved = changes.virusTotalResults.newValue || {};
      });
    }
    if (!this.saved) this.saved = (await api.storage.local.get({ virusTotalResults: {} })).virusTotalResults || {};
    return this.saved!;
  }
  private remember(r: ScanResult) {
    if (!r.sha256 || !this.saved) return;
    this.saved[r.sha256] = r;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saved = pruneResults(this.saved || {}, Date.now());
      void Promise.resolve(api.storage.local.set({ virusTotalResults: this.saved })).catch(() => {}).finally(() => { this.saveTimer = null; });
    }, 1000);
  }

  /** One VirusTotal request at a time, at most 4 a minute ("waiting" while held back), retried once on 429. */
  private request(part: string, ask: () => Promise<any>): Promise<any> {
    const run = this.line.then(async () => {
      for (let attempt = 0; ; attempt++) {
        for (let wait = this.limit.wait(); wait > 0; wait = this.limit.wait()) {
          if (this.byPart[part]?.status === "checking") this.byPart[part] = { ...this.byPart[part], status: "waiting" };
          await sleep(wait);
        }
        if (this.byPart[part]?.status === "waiting") this.byPart[part] = { ...this.byPart[part], status: "checking" };
        this.limit.take();
        const reply = await ask();
        if (reply.status !== 429 || attempt) return reply;
        this.limit.full();
      }
    });
    this.line = run.catch(() => {});
    return run;
  }

  private async fingerprint(messageId: number, a: MessageAttachment): Promise<{ file: File; sha256: string }> {
    const file: File = await api.messages.getAttachmentFile(messageId, a.partName);
    return { file, sha256: hex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())) };
  }

  /** Look an attachment up (its fingerprint only). Skips one being checked, or answered unless `force`. */
  async check(messageId: number, a: MessageAttachment, { force = false } = {}) {
    const part = `${messageId}:${a.partName}`;
    const now = this.byPart[part];
    if (!this.on || (now && BUSY.includes(now.status)) || (now && !force && now.status !== "error")) return;
    this.byPart[part] = { status: "hashing" };
    try {
      const { sha256 } = await this.fingerprint(messageId, a);
      const known = (await this.load())[sha256];
      if (!force && fresh(known, Date.now())) { this.byPart[part] = known; return; }
      this.byPart[part] = { status: "checking", sha256 };
      const reply = await this.request(part, () => (api as any).sparkScan.lookup(this.key, sha256));
      let result: ScanResult;
      if (reply.status === 404) result = { status: "unknown", sha256, at: Date.now() };
      else if (reply.status !== 200) result = { status: "error", sha256, error: reply.error, at: Date.now() };
      else {
        const stats = scanStats(reply.stats);
        result = stats && stats.total ? { status: verdict(stats), sha256, stats, threat: threatName(reply.flagged), at: Date.now() } : { status: "unknown", sha256, at: Date.now() };
      }
      this.byPart[part] = result;
      this.remember(result);
    } catch (error: any) {
      this.byPart[part] = { status: "error", error: String(error?.message || error) };
    }
  }

  /** Upload an attachment for VirusTotal to scan (the user asked, after the warning), and wait for the answer. */
  async upload(messageId: number, a: MessageAttachment) {
    const part = `${messageId}:${a.partName}`;
    if (!this.on || BUSY.includes(this.byPart[part]?.status as any)) return;
    this.byPart[part] = { status: "uploading", sha256: this.byPart[part]?.sha256 };
    try {
      const { file, sha256 } = await this.fingerprint(messageId, a);
      this.byPart[part] = { status: "uploading", sha256 };
      const sent = await this.request(part, () => (api as any).sparkScan.upload(this.key, file, a.name || file.name || "attachment"));
      if (!sent.analysis) throw new Error(sent.error || "VirusTotal didn't take the file.");
      this.byPart[part] = { status: "analysing", sha256 };
      for (let i = 0; i < POLL_TRIES; i++) {
        await sleep(i ? POLL_MS : POLL_MS / 2);
        const reply = await this.request(part, () => (api as any).sparkScan.analysis(this.key, sent.analysis));
        if (reply.status !== 200) throw new Error(reply.error || `VirusTotal answered ${reply.status}.`);
        if (reply.state !== "completed") continue;
        const stats = scanStats(reply.stats);
        const result: ScanResult = stats && stats.total ? { status: verdict(stats), sha256, stats, threat: threatName(reply.flagged), at: Date.now() } : { status: "unknown", sha256, at: Date.now() };
        this.byPart[part] = result;
        await this.load();
        this.remember(result);
        return;
      }
      throw new Error("VirusTotal is still scanning it. Check again later.");
    } catch (error: any) {
      this.byPart[part] = { status: "error", sha256: this.byPart[part]?.sha256, error: String(error?.message || error) };
    }
  }

  /** Settings → Test key: the EICAR test file's fingerprint (VirusTotal flags it), nothing else is sent. */
  async test(key: string, sha256: string): Promise<{ ok: boolean; text: string }> {
    try {
      const reply = await (api as any).sparkScan.lookup(key, sha256);
      if (reply.status === 200) {
        const stats = scanStats(reply.stats);
        return { ok: true, text: `Works: VirusTotal's test file is flagged by ${stats?.malicious ?? 0} of ${stats?.total ?? 0} scanners.` };
      }
      return { ok: false, text: reply.error || `VirusTotal answered ${reply.status}.` };
    } catch (error: any) { return { ok: false, text: String(error?.message || error) }; }
  }
}

export const scanner = new Scanner();
