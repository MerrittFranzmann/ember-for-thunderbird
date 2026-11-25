/* Lock with Touch ID (src/lib/lock.ts). Ember's pages cover themselves while this says locked; unlocking asks
 * macOS through Gecko's OS reauthenticator (the Touch ID sheet Firefox shows before revealing saved passwords;
 * the Mac's password when Touch ID isn't available). It locks by itself: after the Mac has been unused for a
 * while (the user-idle service), when the Mac goes to sleep, when its screen locks (polled with ioreg only while
 * the Mac is idle, since a locked screen means nobody's typing), and when Thunderbird starts. On a network the
 * user trusts (the background says which, setTrusted) it doesn't lock when away or when the screen locks, and a
 * lock from sleep or start-up comes off once the network turns out to be trusted. The settings and the state are
 * kept in prefs, so the lock holds before the background starts and across restarts. The pure helpers at the
 * top are unit-tested (test/lock.test.ts). */
"use strict";

/** Whether `ioreg -n Root -d1 -a` says the screen is locked. */
function lockScreenLocked(text) {
  return /<key>(?:IOConsoleLocked|CGSSessionScreenIsLocked)<\/key>\s*<true\/>/.test(text || "");
}
/** Whether a moment should lock Ember. `trusted`: on a network the user trusts. A sleep or start-up locks
 *  whatever the network (where the Mac wakes isn't known yet); lockUnlocksWhenTrusted takes it off later. */
function lockShouldLock(config, trigger, trusted) {
  if (!config?.enabled) return false;
  switch (trigger) {
    case "manual": return true;
    case "start": return !!config.onStart;
    case "sleep": return !!config.onSleep;
    case "screen": return !!config.onSleep && !trusted;
    case "away": return config.idleMinutes > 0 && !trusted;
    default: return false;
  }
}
const LOCK_TRUST_WINDOW = 3 * 60000;
/** Whether a trusted network takes the lock off: one from sleep or start-up, put on in the last few minutes. */
function lockUnlocksWhenTrusted(state, now) {
  return !!state?.locked && (state.reason === "sleep" || state.reason === "start") && now - (state.at || 0) < LOCK_TRUST_WINDOW;
}

if (typeof module === "object") module.exports = { lockScreenLocked, lockShouldLock, lockUnlocksWhenTrusted };

const LOCK_PREF_CONFIG = "extensions.spark.lock.config";
const LOCK_PREF_STATE = "extensions.spark.lock.state";
/** Tests only, and only while Marionette (remote control) is on: "pass" or "fail" instead of asking macOS. */
const LOCK_PREF_TEST = "extensions.spark.lock.testAuth";
const LOCK_SCREEN_IDLE = 10; // seconds idle before the screen-lock poll starts
const LOCK_SCREEN_POLL = 10000;

class SparkLockWatch {
  constructor() {
    this.config = this.read(LOCK_PREF_CONFIG, { enabled: false, idleMinutes: 15, onSleep: true, onStart: true });
    this.state = this.read(LOCK_PREF_STATE, { locked: false });
    this.trusted = false;
    this.listeners = new Set();
    this.wakeListeners = new Set();
    this.pending = null;
    this.idleTime = 0;
    this.screenTimer = null;
    this.started = false;
    this.observer = { observe: (subject, topic, data) => this.observe(topic, data) };
    this.idleObserver = { observe: (subject, topic) => { if (topic === "idle") this.trigger("away"); } };
    this.screenObserver = { observe: (subject, topic) => (topic === "idle" ? this.startScreenPoll() : this.stopScreenPoll()) };
  }

  read(pref, fallback) {
    try { return { ...fallback, ...JSON.parse(Services.prefs.getStringPref(pref, "")) }; } catch { return { ...fallback }; }
  }

  get idleService() { return Cc["@mozilla.org/widget/useridleservice;1"].getService(Ci.nsIUserIdleService); }

  start() {
    if (this.started) return;
    this.started = true;
    for (const topic of ["sleep_notification", "wake_notification", "spark-lock:test"]) Services.obs.addObserver(this.observer, topic);
    this.watchIdle();
    if (this.state.locked && !this.available) this.set({ locked: false });
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    for (const topic of ["sleep_notification", "wake_notification", "spark-lock:test"]) {
      try { Services.obs.removeObserver(this.observer, topic); } catch { /* not added */ }
    }
    this.unwatchIdle();
  }

  /** The idle observers for the settings now: "away" after idleMinutes, and the screen-lock poll. */
  watchIdle() {
    this.unwatchIdle();
    if (!this.config.enabled) return;
    const idle = this.idleService;
    if (this.config.idleMinutes > 0) { this.idleTime = this.config.idleMinutes * 60; idle.addIdleObserver(this.idleObserver, this.idleTime); }
    if (this.config.onSleep) { idle.addIdleObserver(this.screenObserver, LOCK_SCREEN_IDLE); this.screenWatched = true; }
  }

  unwatchIdle() {
    const idle = this.idleService;
    if (this.idleTime) { try { idle.removeIdleObserver(this.idleObserver, this.idleTime); } catch { /* gone */ } this.idleTime = 0; }
    if (this.screenWatched) { try { idle.removeIdleObserver(this.screenObserver, LOCK_SCREEN_IDLE); } catch { /* gone */ } this.screenWatched = false; }
    this.stopScreenPoll();
  }

  startScreenPoll() {
    this.stopScreenPoll();
    const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    const check = async () => {
      if (!this.screenTimer) return;
      try {
        const proc = await Subprocess.call({ command: "/usr/sbin/ioreg", arguments: ["-n", "Root", "-d1", "-a"], stderr: "stdout" });
        let out = "", chunk;
        while ((chunk = await proc.stdout.readString())) out += chunk;
        await proc.wait();
        if (lockScreenLocked(out)) this.trigger("screen");
      } catch { /* no ioreg: the idle lock still works */ }
      if (this.screenTimer) this.screenTimer = setTimeout(check, LOCK_SCREEN_POLL);
    };
    this.screenTimer = setTimeout(check, 0);
  }

  stopScreenPoll() {
    if (this.screenTimer) clearTimeout(this.screenTimer);
    this.screenTimer = null;
  }

  observe(topic, data) {
    if (topic === "sleep_notification") {
      this.trusted = false; // until the background has looked at the network after waking
      this.trigger("sleep");
    } else if (topic === "wake_notification") {
      for (const listener of this.wakeListeners) listener();
    } else if (topic === "spark-lock:test") {
      this.trigger(String(data || ""));
    }
  }

  trigger(reason) {
    // Never locks where it couldn't ask to unlock.
    if (this.state.locked || !this.available || !lockShouldLock(this.config, reason, this.trusted)) return;
    this.set({ locked: true, reason, at: Date.now() });
  }

  set(state) {
    this.state = state;
    Services.prefs.setStringPref(LOCK_PREF_STATE, JSON.stringify(state));
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  get available() {
    if (this.canAsk === undefined) {
      const { AppConstants: constants } = ChromeUtils.importESModule("resource://gre/modules/AppConstants.sys.mjs");
      this.canAsk = "@mozilla.org/security/osreauthenticator;1" in Cc && ["macosx", "win"].includes(constants.platform);
    }
    return this.canAsk;
  }

  snapshot() {
    return { ...this.state, available: this.available, config: { ...this.config } };
  }

  configure(config) {
    this.config = { ...this.config, ...config };
    Services.prefs.setStringPref(LOCK_PREF_CONFIG, JSON.stringify(this.config));
    if (this.started) this.watchIdle();
    if (!this.config.enabled && this.state.locked) this.set({ locked: false });
    return this.snapshot();
  }

  setTrusted(trusted) {
    this.trusted = !!trusted;
    if (this.trusted && lockUnlocksWhenTrusted(this.state, Date.now())) this.set({ locked: false });
    return this.snapshot();
  }

  testAuth() {
    try {
      const marionette = Cc["@mozilla.org/remote/marionette;1"]?.getService(Ci.nsIMarionette);
      if (!marionette?.running) return "";
      return Services.prefs.getStringPref(LOCK_PREF_TEST, "");
    } catch { return ""; }
  }

  /** Touch ID or the Mac's password. `prompt` finishes macOS's "Thunderbird is trying to …". */
  async ask(prompt, window) {
    const test = this.testAuth();
    if (test) return test === "pass";
    if (!this.available) return false;
    try {
      const auth = Cc["@mozilla.org/security/osreauthenticator;1"].getService(Ci.nsIOSReauthenticator);
      const result = await auth.asyncReauthenticateUser(prompt, "Ember", window || null);
      return !!result?.[0];
    } catch { return false; } // cancelled (Windows rejects; macOS answers false)
  }

  unlock(window) {
    if (!this.state.locked) return Promise.resolve({ unlocked: true });
    if (!this.pending) {
      this.pending = this.ask("unlock Ember", window).then((ok) => {
        if (ok && this.state.locked) this.set({ locked: false });
        return { unlocked: ok };
      }).finally(() => { this.pending = null; });
    }
    return this.pending;
  }
}

var sparkLock = class extends ExtensionCommon.ExtensionAPI {
  watch() { if (!this.lockWatch) this.lockWatch = new SparkLockWatch(); return this.lockWatch; }
  onStartup() {
    // Only a real Thunderbird start locks "when Thunderbird starts" (not Ember updating or being turned on).
    const watch = this.watch();
    watch.start();
    if (this.extension.startupReason === "APP_STARTUP") watch.trigger("start");
  }
  onShutdown() { if (this.lockWatch) this.lockWatch.stop(); }
  getAPI(context) {
    const watch = this.watch();
    watch.start();
    const window = () => { try { return context.xulBrowser?.ownerGlobal || null; } catch { return null; } };
    return {
      sparkLock: {
        async configure(config) { return watch.configure(config || {}); },
        async state() { return watch.snapshot(); },
        async lock() { watch.trigger("manual"); return watch.snapshot(); },
        async unlock() { return watch.unlock(window()); },
        async verify(prompt) { return watch.ask(String(prompt || "change the Ember lock"), window()); },
        async setTrusted(trusted) { return watch.setTrusted(trusted); },
        onChanged: new ExtensionCommon.EventManager({
          context,
          name: "sparkLock.onChanged",
          register: (fire) => {
            const listener = (state) => fire.async(state);
            watch.listeners.add(listener);
            return () => watch.listeners.delete(listener);
          },
        }).api(),
        onWake: new ExtensionCommon.EventManager({
          context,
          name: "sparkLock.onWake",
          register: (fire) => {
            const listener = () => fire.async();
            watch.wakeListeners.add(listener);
            return () => watch.wakeListeners.delete(listener);
          },
        }).api(),
      },
    };
  }
};
this.sparkLock = sparkLock;
