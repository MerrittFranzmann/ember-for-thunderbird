// Failures Ember noticed but nobody may have seen: script errors, unhandled rejections, failed saves and sends,
// error toasts. The performance recorder only keeps five minutes (and only while it's on); this keeps the last
// ERROR_LIMIT distinct failures (by text) in storage.local "errorLog" across restarts, from Ember's window,
// Settings and the background, so they can be read later (the agent connection's status, performance reports).

export interface ErrorEntry { text: string; where: string; count: number; first: number; last: number; stack?: string }

export const ERROR_LIMIT = 50;
const KEY = "errorLog";
const SAVE_MS = 2000;

/** Stored and new entries together: same text adds up, newest first, at most ERROR_LIMIT. */
export function mergeErrors(stored: ErrorEntry[], added: ErrorEntry[]): ErrorEntry[] {
  const byText = new Map(stored.map((entry) => [entry.text, { ...entry }]));
  for (const entry of added) {
    const old = byText.get(entry.text);
    byText.set(entry.text, old
      ? { ...old, where: entry.where, count: old.count + entry.count, first: Math.min(old.first, entry.first), last: Math.max(old.last, entry.last), stack: entry.stack || old.stack }
      : { ...entry });
  }
  return [...byText.values()].sort((a, b) => b.last - a.last).slice(0, ERROR_LIMIT);
}

export class ErrorLog {
  private pending = new Map<string, ErrorEntry>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();

  /** `storage` is the unwrapped storage.local: a failed save here must not be logged as a failure again. */
  constructor(private storage: () => any, private where: string, private now = () => Date.now()) {}

  add(text: string, stack?: string) {
    const t = this.now();
    const old = this.pending.get(text);
    this.pending.set(text, old ? { ...old, count: old.count + 1, last: t } : { text, where: this.where, count: 1, first: t, last: t, ...(stack ? { stack } : {}) });
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, SAVE_MS);
  }

  /** Save what's pending (merged with what other Ember pages saved). */
  flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    const added = [...this.pending.values()];
    this.pending.clear();
    this.saving = this.saving.then(async () => {
      const storage = this.storage();
      if (!added.length || !storage) return;
      try {
        const stored = (await storage.get(KEY))?.[KEY];
        await storage.set({ [KEY]: mergeErrors(Array.isArray(stored) ? stored : [], added) });
      } catch { /* nowhere left to report it */ }
    });
    return this.saving;
  }

  async read(): Promise<ErrorEntry[]> {
    await this.flush();
    try {
      const stored = (await this.storage()?.get(KEY))?.[KEY];
      return Array.isArray(stored) ? stored : [];
    } catch { return []; }
  }
}

const native: any = (globalThis as any).messenger ?? (globalThis as any).browser;
const page = String((globalThis as any).location?.pathname || "");
export const errorLog = new ErrorLog(() => native?.storage?.local, page.endsWith("app.html") ? "window" : page.endsWith("settings.html") ? "settings" : "background");
