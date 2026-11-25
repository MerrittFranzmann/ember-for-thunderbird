// Automatic updates. Each release is published on GitHub, signed (tools/publish_update.py); the sparkUpdate
// Experiment checks the signature and installs it. Tests point the setting "updateFolder" at a local folder.
// The background checks at each start and every 10 minutes (GitHub at most hourly; Update now asks at once). A newer version installs once Ember isn't
// in use (see the page's "spark:in-use" answer); until then the sidebar offers "Update now".
// Installing restarts the add-on; the new version reopens Ember as it was (sparkResume).

const ALARM = "spark-update";
/** How long after an update the new version still reopens Ember (a restart takes seconds). */
export const RESUME_MS = 2 * 60000;

export interface UpdateStatus {
  checkedAt: number;
  current: string;
  /** A newer version in the release folder, not installed yet. */
  ready: string | null;
  installing?: boolean;
  error?: string;
}

export interface SparkOpen { open: boolean; minimized: boolean }

export class UpdateService {
  /** `busy`: something that mustn't be cut off by a restart (an email about to be sent). */
  constructor(private native: any, private sparkOpen: () => Promise<SparkOpen>, private busy: () => Promise<boolean> = async () => false) {}

  private get experiment() { return this.native.sparkUpdate; }
  get available() { return typeof this.experiment?.check === "function"; }
  handles(alarm: string) { return alarm === ALARM; }

  async start() {
    if (!this.available) return;
    if (!(await this.native.alarms.get(ALARM))) await this.native.alarms.create(ALARM, { periodInMinutes: 10 });
    await this.check();
  }

  /** Read the release folder. A newer version installs when Ember isn't in use ("auto"), or right away
   *  ("now", the sidebar's Update now). A temporarily installed (development) Ember only updates on "now". */
  check(install: "auto" | "now" | "never" = "auto"): Promise<UpdateStatus | null> {
    // The background starts several ways at once (start-up, install, wake-up): one check at a time,
    // and a check already running answers the others (except Update now, which goes next).
    if (this.running && install !== "now") return this.running;
    const next = (this.running ?? Promise.resolve(null)).catch(() => null).then(() => this.run(install));
    this.running = next;
    void next.catch(() => {}).then(() => { if (this.running === next) this.running = null; });
    return next;
  }
  private running: Promise<UpdateStatus | null> | null = null;

  private async run(install: "auto" | "now" | "never"): Promise<UpdateStatus | null> {
    if (!this.available) return null;
    const { autoUpdate, updateFolder } = await this.native.storage.local.get({ autoUpdate: true, updateFolder: "" });
    const folder = updateFolder || undefined;
    let status: UpdateStatus;
    let temporary = false;
    try {
      const result = await this.experiment.check(folder, install === "now");
      temporary = result.temporary;
      status = { checkedAt: Date.now(), current: result.current, ready: result.newer ? result.version : null };
    } catch (error: any) {
      status = { checkedAt: Date.now(), current: this.native.runtime.getManifest().version, ready: null, error: String(error?.message || error) };
    }
    await this.native.storage.local.set({ updateStatus: status });
    if (status.ready && (install === "now" || (install === "auto" && autoUpdate && !temporary && !(await this.inUse())))) {
      return this.install(status, folder);
    }
    return status;
  }

  /** The Ember page answers whether it's in use; with no Ember page open, it isn't. */
  private async inUse(): Promise<boolean> {
    if (await this.busy().catch(() => false)) return true;
    try { return !!(await this.native.runtime.sendMessage({ type: "spark:in-use" })); } catch { return false; }
  }

  private async install(status: UpdateStatus, folder: string | undefined): Promise<UpdateStatus> {
    const spark = await this.sparkOpen().catch(() => ({ open: false, minimized: false }));
    await this.native.storage.local.set({ updateStatus: { ...status, installing: true }, sparkResume: { at: Date.now(), ...spark } });
    try {
      // On success Ember restarts as the new version, so this doesn't return.
      await this.experiment.install(status.ready, folder);
      return status;
    } catch (error: any) {
      const failed = { ...status, error: String(error?.message || error) };
      await this.native.storage.local.set({ updateStatus: failed });
      await this.native.storage.local.remove("sparkResume");
      return failed;
    }
  }
}
