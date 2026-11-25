import { CacheService } from "./lib/cache-service";
import { AppWindow } from "./lib/app-window";
import { ReminderService } from "./lib/reminder-service";
import { RESUME_MS, UpdateService } from "./lib/update-service";
import { FollowUpService } from "./lib/follow-up-service";
import { AiSorter } from "./lib/ai-sorter";
import { SpamService } from "./lib/spam-service";
import { OutboxService } from "./lib/outbox-service";
import { FocusService } from "./lib/focus-service";
import { FOCUS_DEFAULTS } from "./lib/focus";
import { LockService } from "./lib/lock-service";
import { LOCK_DEFAULTS } from "./lib/lock";
import { TravelService } from "./lib/travel-service";
import { perf } from "./lib/perf-recorder";
import { MailLinkService } from "./lib/mail-link-service";
perf.watchErrors();
const native = (globalThis as any).messenger ?? (globalThis as any).browser;
const cache = new CacheService(native);
const APP_PATH = "app.html";
const APP_URL = native.runtime.getURL(APP_PATH);
async function getSpace() {
  if (!native.spaces) return null;
  try { const own = await native.spaces.query({ isSelfOwned: true }); return own[0] || await native.spaces.create("spark", APP_PATH, { title: "Ember", defaultIcons: "icons/ember.svg" }); }
  catch { return null; }
}
const appWindow = new AppWindow(native, APP_URL);
const reminders = new ReminderService(native, () => openApp(), () => cache.headers());
const updates = new UpdateService(native, sparkOpen, () => outbox.busy());
/** Short enough to run before Thunderbird suspends an idle background (~30 s). */
const STARTUP_DEFER_MS = 12000;
const followUps = new FollowUpService(native, async (id: number) => {
  await native.storage.local.set({ sparkOpenMessage: { id, at: Date.now() } });
  await openApp();
}, cache);
// Undo send and Send later: Ember's outbox sends each email at its time, with Ember open or not.
const outbox = new OutboxService(native, (f) => followUps.add(f));
// Focus: quiet hours and work mail by network; Ember announces new mail itself while they're set.
const focus = new FocusService(native, async (id: number) => {
  await native.storage.local.set({ sparkOpenMessage: { id, at: Date.now() } });
  await openApp();
}, () => openApp());
// Links that open an email (mail-links.ts): Thunderbird answers them while Settings allow; a click shows the email.
const mailLinks = new MailLinkService(native, {
  headers: () => cache.headers(),
  show: async (id: number) => { await native.storage.local.set({ sparkOpenMessage: { id, at: Date.now() } }); await openApp(); },
  missing: async () => { await native.storage.local.set({ sparkOpenMessage: { missing: true, at: Date.now() } }); await openApp(); },
});
native.sparkMailLinks?.onOpen.addListener((code: string) => { void mailLinks.open(code).catch(() => {}); });
// Lock with Touch ID: the Experiment watches and asks; this passes it the settings and whether the network is trusted.
const lock = new LockService(native);
/** Focus looks at the network; the lock follows (trusted network or not). */
async function refreshFocus(options: { network?: boolean } = {}) {
  const state = await focus.refresh(options);
  await lock.network(state.network?.key);
  return state;
}
// AI sorting (opt-in): saved content when there is some, else Thunderbird's copy (new mail not saved yet).
// Spam you teach Ember (spam.ts): senders you marked, and what Clef is sure of, go to Spam.
const spam = new SpamService(native, { headers: () => cache.headers() });
const aiSorter = new AiSorter(native, {
  headers: () => cache.headers(),
  full: async (message) => (await cache.saved(message.id)) ?? await native.messages.getFull(message.id).catch(() => undefined),
}, (items) => spam.answered(items));
// Trips: bookings in travel mail (markup, else Workers AI with AI sorting on), changes announced, check-in reminders.
const travel = new TravelService(native, {
  headers: () => cache.headers(),
  full: async (message) => (await cache.saved(message.id)) ?? await native.messages.getFull(message.id).catch(() => undefined),
}, async (id: string) => {
  await native.storage.local.set({ sparkOpenTrip: { id, at: Date.now() } });
  await openApp();
});
async function windowMode(): Promise<boolean> { return (await native.storage.local.get({ windowMode: true })).windowMode; }
/** Ember-only mode and the lighter Thunderbird settings live in the window Experiment. */
async function configureWindows() {
  if (!native.sparkWindow) return;
  const s = await native.storage.local.get({ windowMode: true, sparkOnly: true, lightenThunderbird: true, dockIcon: true });
  await native.sparkWindow.configure({ sparkOnly: s.windowMode && s.sparkOnly, lighten: s.lightenThunderbird }).catch(() => {});
  void showDockIcon(s.dockIcon);
  return s.windowMode && s.sparkOnly;
}
/** Ember's icon in the Dock (Ember-only mode): the picture is handed over once per start, then just on/off. */
let dockIconSent = false;
async function showDockIcon(show: boolean) {
  if (typeof native.sparkWindow?.setDockIcon !== "function") return;
  try {
    let png: string | undefined;
    if (!dockIconSent) {
      const bytes = new Uint8Array(await (await fetch(native.runtime.getURL("icons/ember-dock.png"))).arrayBuffer());
      let text = "";
      for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      png = btoa(text);
    }
    await native.sparkWindow.setDockIcon({ png, show });
    dockIconSent = true;
  } catch { /* the Dock keeps Thunderbird's icon */ }
}
async function openApp({ minimized = false } = {}) {
  if (await windowMode()) return appWindow.showSpark({ minimized });
  // moz-extension URLs aren't valid query patterns; filter in code.
  const tabs = (await native.tabs.query({}).catch(() => [])).filter((t: any) => t.url?.startsWith(APP_URL));
  if (tabs.length) { await native.tabs.update(tabs[0].id, { active: true }); return; }
  const space = await getSpace();
  if (space) await native.spaces.open(space.id); else await native.tabs.create({ url: APP_PATH });
}
/** Ember's settings in their own window (one at a time), opened at a section when asked. */
const SETTINGS_URL = native.runtime.getURL("settings.html");
async function openSettings(section?: string) {
  const url = SETTINGS_URL + (section ? `#${section}` : "");
  const windows = await native.windows.getAll({ populate: true, windowTypes: ["popup"] }).catch(() => []);
  const existing = windows.find((w: any) => w.tabs?.some((t: any) => t.url?.startsWith(SETTINGS_URL)));
  if (existing) {
    const tab = existing.tabs.find((t: any) => t.url?.startsWith(SETTINGS_URL));
    if (section) await native.tabs.update(tab.id, { url }).catch(() => {});
    void Promise.resolve(native.windows.update(existing.id, { focused: true, ...(existing.state === "minimized" ? { state: "normal" } : {}) })).catch(() => {});
    return;
  }
  // Centred on Ember's window (or Thunderbird's).
  const spark = await appWindow.sparkWindow() ?? (await native.windows.getAll({ windowTypes: ["normal"] }).catch(() => []))[0];
  const width = 880, height = 640;
  const place = spark && spark.width ? { left: Math.round(spark.left + (spark.width - width) / 2), top: Math.round(spark.top + Math.max(0, (spark.height - height) / 2)) } : {};
  // windows.create can stay pending in Thunderbird; not awaited (as in app-window.ts).
  void Promise.resolve(native.windows.create({ type: "popup", url, width, height, ...place })).catch(() => {});
}
/** Whether Ember is open (window or tab), for reopening it after an update. */
async function sparkOpen() {
  const win = await appWindow.sparkWindow();
  if (win) return { open: true, minimized: win.state === "minimized" };
  const tabs = (await native.tabs.query({}).catch(() => [])).filter((t: any) => t.url?.startsWith(APP_URL));
  return { open: tabs.length > 0, minimized: false };
}
/** Ctrl+Shift+S: between Ember and the regular Thunderbird window (or mail tab in tab mode). */
async function toggleApp() {
  if (await lock.locked()) return openApp();
  if (await windowMode()) return appWindow.toggle();
  const [active] = await native.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (active?.url?.startsWith(APP_URL)) {
    const [mail] = await native.tabs.query({ type: "mail", currentWindow: true }).catch(() => []);
    if (mail) await native.tabs.update(mail.id, { active: true });
  } else await openApp();
}
// Register every waking listener synchronously at background evaluation.
native.action.onClicked.addListener(() => openApp());
// Ember-only mode: Thunderbird tried to bring its window back (e.g. a new main window); show Ember.
native.sparkWindow?.onReopen.addListener(() => { void openApp(); });
// Ember-only mode: a new-mail notification was clicked; open that message in Ember. The request goes
// through storage so an Ember window that is still opening picks it up too.
native.sparkWindow?.onOpenMessage.addListener(async (messageId: number) => {
  await native.storage.local.set({ sparkOpenMessage: { id: messageId, at: Date.now() } });
  await openApp();
});
native.storage.onChanged.addListener((changes: any, area: string) => {
  if (area === "local" && (changes.sparkOnly || changes.lightenThunderbird || changes.windowMode || changes.dockIcon)) void configureWindows();
  if (area === "local" && (changes.meetingReminder || changes.meetingBrief)) void reminders.refresh();
  if (area === "local" && Object.keys(changes).some((key) => key in FOCUS_DEFAULTS)) void refreshFocus();
  if (area === "local" && Object.keys(changes).some((key) => key in LOCK_DEFAULTS)) void lock.configure().then(() => refreshFocus({ network: true }));
  if (area === "local" && (changes.aiSort || changes.clefAccount || changes.clefToken || changes.clefModel || changes.workAccounts)) aiSorter.schedule(500);
  if (area === "local" && (changes.travel || changes.aiSort || changes.clefAccount || changes.clefToken)) travel.schedule(1000);
  if (area === "local" && changes.emailLinks) void mailLinks.configure();
});
native.commands?.onCommand.addListener((name: string) => { if (name === "toggle-spark") void toggleApp(); });
native.runtime.onMessage.addListener((message: any, sender: any) => {
  if (sender.id && sender.id !== native.runtime.id) return;
  if (message?.type === "spark:open") return openApp();
  if (message?.type === "spark:toggle") return toggleApp();
  if (message?.type === "spark:show-thunderbird") return lock.locked().then((locked) => locked ? openApp() : appWindow.showThunderbird());
  if (message?.type === "spark:cache") return cache.request(message);
  if (message?.type === "spark:keepalive") return Promise.resolve(true);
  if (message?.type === "spark:reminders") return reminders.refresh();
  if (message?.type === "spark:update") return updates.check(message.install === "now" ? "now" : "never");
  if (message?.type === "spark:ai-test") return aiSorter.test(message.settings || {});
  if (message?.type === "spark:outbox") return outbox.request(message);
  if (message?.type === "spark:focus") return refreshFocus({ network: true });
  if (message?.type === "spark:travel") return travel.run();
  if (message?.type === "spark:settings") return openSettings(message.section);
  if (message?.type === "spark:open-email") return mailLinks.openEmail(String(message.id || ""));
  if (message?.type === "spark:follow-up") return message.add ? followUps.add(message.add) : followUps.cancel(String(message.cancel));
});
native.runtime.onConnect.addListener((port: any) => { if (port.name === "spark:cache-reader") cache.reader(port); });
native.messages.onNewMailReceived.addListener((folder: any, list: any) => {
  void focus.received(folder, list).catch(() => {});
  void cache.received(list).then(async () => {
    await spam.received(list?.messages || []).catch(() => 0);
    aiSorter.schedule(); travel.schedule();
  });
});
native.sparkFocus?.onNetworkChanged.addListener(() => { void refreshFocus({ network: true }); });
// The Mac woke: the lock it put on at sleep comes off if this turns out to be a trusted network.
native.sparkLock?.onWake.addListener(() => { void refreshFocus({ network: true }); });
native.messages.onUpdated.addListener((message: any, changes: any) => cache.changed(message, changes));
native.messages.onMoved.addListener((first: any, second: any) => cache.moved(first, second));
native.messages.onCopied?.addListener((_first: any, copies: any) => cache.received(copies)); // copies are new mail for their folder
native.messages.onDeleted.addListener((list: any) => cache.deleted(list));
native.alarms.onAlarm.addListener((alarm: any) => {
  if (alarm.name === "spark-cache-sync") cache.tick();
  else if (updates.handles(alarm.name)) void updates.check();
  else void focus.alarm(alarm.name).then((handled) => handled || outbox.alarm(alarm.name)).then((handled) => handled || followUps.alarm(alarm.name)).then((handled) => handled || reminders.alarm(alarm.name)).then((handled) => handled || travel.alarm(alarm.name));
});
native.notifications?.onClicked.addListener((id: string) => {
  if (id.startsWith("spark-send:")) { void native.notifications.clear(id); void openApp(); return; }
  void focus.clicked(id).then((handled) => handled || followUps.clicked(id)).then((handled) => handled || reminders.clicked(id)).then((handled) => handled || travel.clicked(id));
});
let extrasStarted = false;
async function bootstrap() {
  await native.alarms.create("spark-cache-sync", { periodInMinutes: 5 });
  // Meeting reminders (an Exchange request), the update check and follow-up sweep wait a few seconds:
  // at Thunderbird start-up its main thread is busy, and Ember's first view waits on it too.
  if (!extrasStarted) {
    extrasStarted = true;
    setTimeout(() => {
      void reminders.start().catch(() => {});
      void updates.start().catch(() => {});
      void followUps.start().catch(() => {});
      void outbox.start().catch(() => {});
      void refreshFocus({ network: true }).catch(() => {});
      aiSorter.schedule(20000); // after the cache's start-up work
      travel.schedule(30000);
    }, STARTUP_DEFER_MS);
  }
  await cache.start();
}
void mailLinks.configure().catch(() => {});
// The lock's settings, and (with the lock on) the network straight away: a lock from Thunderbird starting comes
// off on a trusted network without waiting for the rest of start-up.
void lock.configure().then(async () => { if (await lock.enabled()) await refreshFocus({ network: true }); }).catch(() => {});
native.runtime.onStartup.addListener(async () => {
  await bootstrap(); await getSpace();
  const settings = await native.storage.local.get({ openOnStartup: false, sparkOnly: true, windowMode: true });
  if (settings.openOnStartup && !(native.sparkWindow && settings.windowMode && settings.sparkOnly)) await openApp();
});
native.runtime.onInstalled.addListener(async () => { await bootstrap(); await getSpace(); });
/** Whenever the background starts (Thunderbird start, install, update, enable, wake-up): in Ember-only
 *  mode Thunderbird's window is hidden, so there must be an Ember window. A minimized one counts. If the
 *  user switched to Thunderbird's window, leave it alone. Right after Ember updated itself, Ember
 *  reopens as it was (open or not, minimized or not). */
async function ensureSpark() {
  const { sparkResume } = await native.storage.local.get("sparkResume");
  if (sparkResume) await native.storage.local.remove("sparkResume");
  const only = await configureWindows();
  if (await appWindow.sparkWindow()) return;
  if (sparkResume && Date.now() - sparkResume.at < RESUME_MS) {
    if (sparkResume.open || only) await openApp({ minimized: !!sparkResume.minimized });
    return;
  }
  if (!only) return;
  const state = await native.sparkWindow.state().catch(() => null);
  if (state && !state.mainVisible) await appWindow.showSpark();
}
void ensureSpark();
void bootstrap();
