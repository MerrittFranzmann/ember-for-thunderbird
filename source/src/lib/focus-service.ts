// The background's side of Focus (focus.ts). Works out the state (quiet now? work mail hidden?) from the
// settings, the clock and the network, keeps it in storage `focusState` for the Ember window, and wakes at
// the next change (an alarm) or when the network changes. While quiet hours or work accounts are set, Ember
// announces new mail itself (Thunderbird's own alert and sound are off) and only for what should notify.
import { FOCUS_DEFAULTS, focusState, shouldNotify, sparkAnnounces, type FocusSettings, type FocusState } from "./focus";

const ALARM = "spark-focus";
const PREFIX = "spark-mail:";
/** Folders new mail in doesn't announce (Thunderbird doesn't either). */
const QUIET_FOLDERS = ["junk", "trash", "sent", "drafts", "archives", "outbox", "templates"];
const NETWORK_TTL = 10 * 60000;

type Network = { key: string | null; dns?: string[] } | null;

export class FocusService {
  private network: Network = null;
  private networkAt = 0;
  private announcing: boolean | null = null;

  constructor(private native: any, private openMessage: (id: number) => Promise<unknown>, private openApp: () => Promise<unknown>) {}

  private get experiment() { return this.native.sparkFocus; }

  private async settings(): Promise<FocusSettings> {
    return { ...FOCUS_DEFAULTS, ...(await this.native.storage.local.get(FOCUS_DEFAULTS)) };
  }

  /** Work out the state again (`network`: ask which network first) and save it. */
  async refresh({ network = false } = {}): Promise<FocusState> {
    const s = await this.settings();
    if (this.experiment && (network || !this.networkAt || Date.now() - this.networkAt > NETWORK_TTL)) {
      this.network = await this.experiment.network().catch(() => null);
      this.networkAt = Date.now();
    }
    const state = focusState(s, this.network, Date.now());
    await this.native.storage.local.set({ focusState: state });
    const announce = sparkAnnounces(s);
    if (announce !== this.announcing) {
      this.announcing = announce;
      await Promise.resolve(this.experiment?.setMailAlerts(!announce)).catch(() => {});
    }
    if (state.nextChange) await this.native.alarms.create(ALARM, { when: state.nextChange + 1000 });
    else await this.native.alarms.clear(ALARM);
    return state;
  }

  /** Returns true when the alarm was Focus's. */
  async alarm(name: string): Promise<boolean> {
    if (name !== ALARM) return false;
    await this.refresh({ network: true });
    return true;
  }

  /** New mail (messages.onNewMailReceived): announce what should notify now. */
  async received(folder: any, list: any) {
    const s = await this.settings();
    if (!sparkAnnounces(s)) return;
    const role = (folder?.specialUse || [])[0] || folder?.type || "";
    if (QUIET_FOLDERS.includes(role)) return;
    const state = await this.refresh();
    const messages: any[] = (list?.messages || []).filter((m: any) => m.read === false && shouldNotify(s, state, { author: m.author, subject: m.subject, accountId: m.folder?.accountId ?? folder?.accountId, junk: m.junk }));
    if (!messages.length) return;
    const name = (author: string) => String(author || "").replace(/\s*<[^>]*>\s*$/, "").replace(/^"|"$/g, "").trim() || author;
    if (messages.length > 3) {
      await this.notify(`${PREFIX}many`, `${messages.length} new emails`, messages.slice(0, 3).map((m) => `${name(m.author)}: ${m.subject}`).join("\n"));
      return;
    }
    for (const m of messages) await this.notify(PREFIX + m.id, name(m.author), m.subject || "(no subject)");
  }

  private notify(id: string, title: string, message: string) {
    return Promise.resolve(this.native.notifications?.create(id, { type: "basic", title, message })).catch(() => {});
  }

  /** A new-mail notification was clicked: that email in Ember (or Ember, for several). True when it was one. */
  async clicked(id: string): Promise<boolean> {
    if (!id.startsWith(PREFIX)) return false;
    void Promise.resolve(this.native.notifications.clear(id)).catch(() => {});
    const messageId = Number(id.slice(PREFIX.length));
    if (Number.isFinite(messageId)) await this.openMessage(messageId); else await this.openApp();
    return true;
  }
}
