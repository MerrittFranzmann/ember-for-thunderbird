// An Ember page's view of the Touch ID lock (lock.ts): locked or not, from the lock Experiment, which tells every
// page when it changes. Until the first answer the page counts as covered, so mail never shows before it's known.
import { api } from "./api";
import type { LockReason, LockState } from "./lock";

type Snapshot = LockState & { available?: boolean; config?: { idleMinutes?: number } };

class PageLock {
  ready = $state(false);
  locked = $state(false);
  reason = $state<LockReason | undefined>(undefined);
  available = $state(false);
  idleMinutes = $state(15);
  /** Asking macOS now; and whether the last try failed (cancelled or wrong). */
  asking = $state(false);
  failed = $state(false);
  /** Covered: locked, or not known yet. */
  covering = $derived(!this.ready || this.locked);
  private started = false;

  private get experiment() { return (api as any)?.sparkLock; }

  private apply = (s: Snapshot | null) => {
    this.locked = !!s?.locked;
    this.reason = s?.reason;
    this.available = !!s?.available;
    this.idleMinutes = s?.config?.idleMinutes ?? this.idleMinutes;
    if (!this.locked) this.failed = false;
    this.ready = true;
  };

  async init() {
    if (this.started) return;
    this.started = true;
    const experiment = this.experiment;
    if (!experiment) { this.apply(null); return; }
    experiment.onChanged.addListener(this.apply);
    this.apply(await experiment.state().catch(() => null));
  }

  async unlock() {
    if (!this.experiment || this.asking) return;
    this.asking = true;
    this.failed = false;
    try { this.failed = !(await this.experiment.unlock())?.unlocked; }
    catch { this.failed = true; }
    finally { this.asking = false; }
  }

  async lockNow() { await this.experiment?.lock().catch(() => {}); }

  /** Touch ID (or the Mac's password) to change the lock itself. macOS shows "Thunderbird is trying to <prompt>." */
  async verify(prompt: string): Promise<boolean> {
    if (!this.experiment) return true;
    return !!(await this.experiment.verify(prompt).catch(() => false));
  }
}

export const lock = new PageLock();
