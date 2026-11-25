// The background's side of the Touch ID lock (lock.ts): passes the settings to the lock Experiment, and tells it
// whether the Mac is on a trusted network each time Focus has looked at the network (start-up, a network
// change, the Mac waking). The Experiment does the watching and the asking.
import { LOCK_DEFAULTS, lockConfig, trustedNetwork, type LockSettings } from "./lock";

export class LockService {
  constructor(private native: any) {}

  private get experiment() { return this.native.sparkLock; }

  private async settings(): Promise<LockSettings> {
    return { ...LOCK_DEFAULTS, ...(await this.native.storage.local.get(LOCK_DEFAULTS)) };
  }

  async enabled(): Promise<boolean> { return !!this.experiment && (await this.settings()).lockEnabled; }

  async configure() {
    if (!this.experiment) return;
    await this.experiment.configure(lockConfig(await this.settings())).catch(() => {});
  }

  /** The network now (Focus's key for it; null when unknown, which isn't trusted). */
  async network(key: string | null | undefined) {
    if (!this.experiment) return;
    await this.experiment.setTrusted(!!trustedNetwork(await this.settings(), key)).catch(() => {});
  }

  /** While locked, Ember doesn't hand over to Thunderbird's own window (it shows the same mail). */
  async locked(): Promise<boolean> {
    if (!this.experiment) return false;
    return !!(await this.experiment.state().catch(() => null))?.locked;
  }
}
