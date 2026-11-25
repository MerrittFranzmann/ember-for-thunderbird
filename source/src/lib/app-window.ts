// Ember as its own window: a Thunderbird "popup" window has no tab bar, address bar or
// unified toolbar, so Ember fills it alone. The regular Thunderbird window stays one
// shortcut away (toggle), and Ember tabs opened elsewhere hand over to the window.
//
// windows.create/update({ focused }) can stay pending in Thunderbird (e.g. while another
// app is frontmost), so they are started, never awaited.

export interface WindowBounds { left: number; top: number; width: number; height: number }
/** The hidden main window's size in Ember-only mode (public/experiments/window: HIDDEN_SIZE). */
const HIDDEN_MAIN = [240, 180];
const DEFAULT_SIZE = { width: 1100, height: 800 };

export class AppWindow {
  constructor(private native: any, private appUrl: string) {}
  /** windows.create isn't awaited (it can stay pending); don't start a second one meanwhile. */
  private creating = 0;

  /** Ember-only mode (window Experiment): Thunderbird's own window stays hidden while Ember is shown. */
  private get only() { return this.native.sparkWindow; }

  private isApp(url: string | undefined) { return !!url && url.startsWith(this.appUrl); }

  /** The Ember popup window, if open (found by its page, so it survives background restarts). */
  async sparkWindow(): Promise<any | undefined> {
    const windows = await this.native.windows.getAll({ populate: true, windowTypes: ["popup"] }).catch(() => []);
    return windows.find((w: any) => w.tabs?.some((t: any) => this.isApp(t.url)));
  }

  private async mainWindow(): Promise<any | undefined> {
    const windows = await this.native.windows.getAll({ windowTypes: ["normal"] }).catch(() => []);
    return windows.find((w: any) => w.focused) || windows[0];
  }

  private focus(window: any) {
    void Promise.resolve(this.native.windows.update(window.id, { focused: true, ...(window.state === "minimized" ? { state: "normal" } : {}) })).catch(() => {});
  }

  /** `minimized`: reopen it minimized (after an update, when it was). */
  async showSpark({ minimized = false } = {}) {
    const existing = await this.sparkWindow();
    // One Ember at a time: tabs (e.g. from the Spaces button) hand over to the window.
    const tabs = await this.native.tabs.query({}).catch(() => []);
    const strays = tabs.filter((t: any) => this.isApp(t.url) && t.windowId !== existing?.id).map((t: any) => t.id);
    if (strays.length) await this.native.tabs.remove(strays).catch(() => {});
    void Promise.resolve(this.only?.hideThunderbird()).catch(() => {});
    if (existing) {
      if (this.only) void Promise.resolve(this.only.focusSpark()).catch(() => this.focus(existing));
      else this.focus(existing);
      return;
    }
    if (Date.now() - this.creating < 5000) return;
    this.creating = Date.now();
    const { sparkWindowBounds } = await this.native.storage.local.get("sparkWindowBounds");
    const main = await this.mainWindow();
    // Thunderbird's window, unless it's the small one Ember-only mode keeps hidden (the window Experiment's
    // HIDDEN_SIZE): then a usual size where it is.
    const shrunk = main && main.width <= HIDDEN_MAIN[0] && main.height <= HIDDEN_MAIN[1];
    const bounds: Partial<WindowBounds> = sparkWindowBounds || (main ? { left: main.left, top: main.top, ...(shrunk ? DEFAULT_SIZE : { width: main.width, height: main.height }) } : {});
    // A new window can't be created minimized together with its bounds: minimize it once it exists.
    void Promise.resolve(this.native.windows.create({ type: "popup", url: this.appUrl, ...bounds }))
      .then((win: any) => { if (minimized && win?.id) return this.native.windows.update(win.id, { state: "minimized" }); })
      .catch(() => {});
  }

  async showThunderbird() {
    if (this.only) { await this.only.showThunderbird(); return; }
    const main = await this.mainWindow();
    if (main) this.focus(main);
  }

  async toggle() {
    const spark = await this.sparkWindow();
    if (spark?.focused) await this.showThunderbird(); else await this.showSpark();
  }
}
