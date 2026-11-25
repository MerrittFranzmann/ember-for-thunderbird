/* Ember-only mode. Thunderbird keeps running underneath (accounts, sync, sending, notifications)
 * while its own main window stays hidden, so Ember looks like a standalone app.
 * - Main windows are hidden before they first paint (DOMContentLoaded, before chrome load shows them)
 *   and shown again by Ember's "Switch to Thunderbird" or when the add-on stops.
 * - macOS only restores *minimized* windows from the Dock when nothing is visible, so in this mode
 *   closing the Ember window minimizes it; the Dock icon brings it back. Quitting still quits.
 * - Thunderbird's "show this message" (new-mail notification clicks) opens the message in Ember,
 *   since its own window is hidden.
 * - "Lighten" turns off Thunderbird features Ember doesn't use (its global search index, chat and
 *   start page); the previous values are restored when it's turned off or the add-on stops.
 * - A hidden main window keeps drawing surfaces the size of the window (over 100 MB in the GPU
 *   process for a large one), so it's shrunk while hidden and put back to its size before it's shown,
 *   and at quit (the size is saved in a pref too, in case Thunderbird stops while it's small).
 * - Thunderbird restores the tabs last open in its window (a PDF attachment keeps a 100 MB+ viewer
 *   worker), which nobody sees while the window is hidden: those tabs are closed (all but the mail tab). */
"use strict";

const PREF_ONLY = "extensions.spark.sparkOnly";
const PREF_LIGHTEN = "extensions.spark.lighten";
const PREF_SAVED = "extensions.spark.lightenSaved";
const PREF_UPDATING = "extensions.spark.updating"; // set by the update Experiment while Ember replaces itself
const PREF_SIZE = "extensions.spark.hiddenMainSize"; // the hidden main window's own size, while it's shrunk
const HIDDEN_SIZE = [240, 180];
const LIGHTEN = {
  "mailnews.database.global.indexer.enabled": false,
  "mail.chat.enabled": false,
  "mailnews.start_page.enabled": false,
  // Folder databases idle for 2 minutes are closed, large ones too (a 28,000-message Archive is
  // 30 MB on disk and more in memory); Thunderbird normally keeps anything over 1 MB open for good.
  "mail.db.keep_open_size": 1073741824,
  "mail.db.idle_limit": 120000,
  "mail.db.max_open": 12,
};
const getPref = (name) => { const t = Services.prefs.getPrefType(name); return t === Services.prefs.PREF_INT ? Services.prefs.getIntPref(name) : Services.prefs.getBoolPref(name); };
const setPref = (name, value) => (typeof value === "number" ? Services.prefs.setIntPref(name, value) : Services.prefs.setBoolPref(name, value));
const MAIN = "mail:3pane";
// Ember's picture in the Dock (and the app switcher) while Ember is in charge: on unless the user turns it off.
const PREF_DOCK = "extensions.spark.dockIcon";
/** Set (a PNG's path) or restore (null) the Dock picture of the running app: macOS's NSApplication
 *  applicationIconImage, through the Objective-C runtime. Thunderbird.app itself is never changed: once
 *  Thunderbird quits, the Dock shows its own icon again. */
function setMacAppIcon(path) {
  const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
  const objc = ctypes.open("/usr/lib/libobjc.A.dylib");
  try {
    const id = ctypes.voidptr_t;
    const cls = objc.declare("objc_getClass", ctypes.default_abi, id, ctypes.char.ptr);
    const sel = objc.declare("sel_registerName", ctypes.default_abi, id, ctypes.char.ptr);
    const send = objc.declare("objc_msgSend", ctypes.default_abi, id, id, id);
    const sendObj = objc.declare("objc_msgSend", ctypes.default_abi, id, id, id, id);
    const sendText = objc.declare("objc_msgSend", ctypes.default_abi, id, id, id, ctypes.char.ptr);
    const app = send(cls("NSApplication"), sel("sharedApplication"));
    let image = ctypes.voidptr_t(0);
    if (path) {
      const file = sendText(cls("NSString"), sel("stringWithUTF8String:"), path);
      image = sendObj(send(cls("NSImage"), sel("alloc")), sel("initWithContentsOfFile:"), file);
      if (image.isNull()) throw new Error(`macOS couldn't read ${path}`);
    }
    sendObj(app, sel("setApplicationIconImage:"), image);
    if (path) send(image, sel("release")); // the app keeps its own reference
  } finally { objc.close(); }
}
// Ember's window draws under its title bar, as Spark's does: the traffic lights sit over the sidebar and the page
// leaves this much room at its top (the strip below can drag the window there). Off with this pref false.
const PREF_UNIFIED = "extensions.spark.unifiedTitlebar";
const TITLEBAR_PX = 28;
/** The macOS window under the click being handled: a press on Ember's title bar becomes macOS's own window drag
 *  (so dragging to a screen edge tiles the window, as with any app); a double-click does what the user chose in
 *  System Settings (zoom, minimize or nothing). */
function macTitlebarPress(win, clicks) {
  const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
  const objc = ctypes.open("/usr/lib/libobjc.A.dylib");
  try {
    const id = ctypes.voidptr_t;
    const cls = objc.declare("objc_getClass", ctypes.default_abi, id, ctypes.char.ptr);
    const sel = objc.declare("sel_registerName", ctypes.default_abi, id, ctypes.char.ptr);
    const send = objc.declare("objc_msgSend", ctypes.default_abi, id, id, id);
    const sendObj = objc.declare("objc_msgSend", ctypes.default_abi, id, id, id, id);
    const sendText = objc.declare("objc_msgSend", ctypes.default_abi, id, id, id, ctypes.char.ptr);
    const textOf = objc.declare("objc_msgSend", ctypes.default_abi, ctypes.char.ptr, id, id);
    const app = send(cls("NSApplication"), sel("sharedApplication"));
    const event = send(app, sel("currentEvent"));
    if (clicks >= 2) {
      const defaults = send(cls("NSUserDefaults"), sel("standardUserDefaults"));
      const value = sendObj(defaults, sel("stringForKey:"), sendText(cls("NSString"), sel("stringWithUTF8String:"), "AppleActionOnDoubleClick"));
      const action = value.isNull() ? "Maximize" : textOf(value, sel("UTF8String")).readString();
      if (action === "Minimize") win.minimize();
      else if (action !== "None") { if (win.windowState === win.STATE_MAXIMIZED) win.restore(); else win.maximize(); }
      return;
    }
    if (event.isNull()) return;
    const nswindow = send(event, sel("window"));
    if (!nswindow.isNull()) sendObj(nswindow, sel("performWindowDragWithEvent:"), event);
  } finally { objc.close(); }
}
const TITLEBAR_VERSION = "2";
/** Ember's window (a popup holding app.html): content under the title bar, and a strip to drag the window by.
 *  Returns how much room the page should leave at its top (0 in full screen, or when this is off). */
function unifyTitlebar(win) {
  if (!win || win.closed || Services.appinfo.OS !== "Darwin") return 0;
  const root = win.document.documentElement;
  if (root.getAttribute("windowtype") !== "mail:extensionPopup") return 0;
  let strip = win.document.getElementById("ember-titlebar");
  if (!Services.prefs.getBoolPref(PREF_UNIFIED, true)) {
    root.removeAttribute("customtitlebar");
    root.setAttribute("drawtitle", "true");
    strip?.remove();
    return 0;
  }
  if (root.getAttribute("customtitlebar") !== "true") {
    root.setAttribute("customtitlebar", "true");
    root.removeAttribute("drawtitle");
  }
  // A strip from an earlier version (its listeners belong to old code): replaced.
  if (strip && strip.dataset.version !== TITLEBAR_VERSION) { strip.remove(); strip = null; }
  if (!strip) {
    strip = win.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    strip.id = "ember-titlebar";
    strip.dataset.version = TITLEBAR_VERSION;
    strip.style.cssText = `position:fixed;top:0;left:0;right:0;height:${TITLEBAR_PX}px;background:transparent;z-index:2147483647;`;
    strip.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || event.target !== strip) return;
      event.preventDefault();
      try { macTitlebarPress(win, event.detail); } catch (error) { Cu.reportError(error); }
    });
    root.appendChild(strip);
  }
  // Where macOS draws the traffic lights (as Thunderbird's own .titlebar-buttonbox): without it they're hidden.
  if (!win.document.getElementById("ember-window-buttons")) {
    const buttons = win.document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    buttons.id = "ember-window-buttons";
    buttons.style.cssText = `position:absolute;left:12px;top:${(TITLEBAR_PX - 14) / 2}px;width:60px;height:14px;appearance:auto;-moz-default-appearance:-moz-window-button-box;`;
    strip.appendChild(buttons);
  }
  const full = win.windowState === win.STATE_FULLSCREEN || win.document.fullscreenElement;
  strip.hidden = !!full;
  return full ? 0 : TITLEBAR_PX;
}
function dockIconPath() { return PathUtils.join(PathUtils.profileDir, "ember-dock-icon.png"); }
const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");

class SparkOnly {
  constructor(extension) {
    this.extension = extension;
    this.appUrl = extension.baseURI.resolve("app.html");
    this.reopen = new Set();
    this.openers = new Set();
    this.pendingOpen = null; // a "show this message" waiting for Ember's background to listen
    // New-mail notification clicks call MailUtils.displayMessageInFolderTab on the (hidden) main window.
    this.MailUtils = ChromeUtils.importESModule("resource:///modules/MailUtils.sys.mjs").MailUtils;
    this.originalDisplay = this.MailUtils.displayMessageInFolderTab;
    const spark = this;
    this.MailUtils.displayMessageInFolderTab = function (msgHdr, ...rest) {
      if (spark.on && !spark.userShown && msgHdr) {
        if (spark.openers.size) { for (const open of spark.openers) open(msgHdr); return undefined; }
        // Ember's background isn't running (suspended or still starting): wake it and hand the
        // message over when it listens; Thunderbird's own window shows it only if that fails.
        spark.queueOpen(msgHdr, () => { spark.showMain(); spark.originalDisplay.call(this, msgHdr, ...rest); });
        return undefined;
      }
      if (spark.on && !spark.userShown) spark.showMain();
      return spark.originalDisplay.call(this, msgHdr, ...rest);
    };
    this.userShown = false; // the user asked for Thunderbird's window; leave it alone until Ember is shown again
    this.stopped = false;
    this.hidden = new WeakSet();
    this.sizes = new WeakMap(); // hidden main windows' own sizes
    this.seen = new WeakSet();
    this.listener = { onOpenWindow: (appWindow) => this.opened(appWindow.docShell.domWindow), onCloseWindow() {} };
    // Windows closing because Thunderbird quits aren't the user leaving Thunderbird's window.
    this.quitting = false;
    this.quitObserver = { observe: () => { this.quitting = true; for (const w of this.mains()) this.unshrink(w); } };
    // Tabs come back with the session after start-up (messenger.js atStartupRestoreTabs).
    this.restoredObserver = { observe: (win) => setTimeout(() => this.closeExtraTabs(win), 0) };
    Services.obs.addObserver(this.restoredObserver, "mail-tabs-session-restored");
    Services.obs.addObserver(this.quitObserver, "quit-application-granted");
    this.watching = false;
  }
  get on() { return !this.stopped && Services.prefs.getBoolPref(PREF_ONLY, false); }
  mains() { return [...Services.wm.getEnumerator(MAIN)]; }
  setVisible(win, visible) {
    if (visible) this.unshrink(win); // its own size first, so it never shows small
    win.docShell.treeOwner.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIAppWindow).QueryInterface(Ci.nsIBaseWindow).visibility = visible;
    if (visible) this.hidden.delete(win); else { this.hidden.add(win); this.shrink(win); }
  }
  /** While hidden: small, so its drawing surfaces are small (they're freed with the old size). */
  shrink(win) {
    if (this.sizes.has(win) || win.closed) return;
    const size = { w: win.outerWidth, h: win.outerHeight, x: win.screenX, y: win.screenY, max: win.windowState === win.STATE_MAXIMIZED };
    if (size.w <= HIDDEN_SIZE[0] && size.h <= HIDDEN_SIZE[1]) {
      // Already small: left so by a Thunderbird that stopped while it was hidden. Use the saved size.
      try { Object.assign(size, JSON.parse(Services.prefs.getStringPref(PREF_SIZE, "null")) || {}); } catch {}
      if (size.w <= HIDDEN_SIZE[0]) return;
    }
    this.sizes.set(win, size);
    Services.prefs.setStringPref(PREF_SIZE, JSON.stringify(size));
    if (size.max) win.restore();
    win.resizeTo(...HIDDEN_SIZE);
  }
  unshrink(win) {
    const size = this.sizes.get(win);
    if (!size || win.closed) return;
    this.sizes.delete(win);
    win.resizeTo(size.w, size.h);
    win.moveTo(size.x, size.y);
    if (size.max) win.maximize();
    if (!this.mains().some((w) => this.sizes.has(w))) Services.prefs.clearUserPref(PREF_SIZE);
  }
  /** Hide a main window, and again once its own load has run (loading a window shows it, which
   *  undid the hide when Ember started while Thunderbird's window was still loading at launch). */
  hideMainWindow(win) {
    this.setVisible(win, false);
    if (win.document.readyState === "complete") { this.finishStartup(win); return; }
    win.addEventListener("load", () => setTimeout(() => {
      if (this.on && !this.userShown) this.setVisible(win, false);
      this.finishStartup(win);
    }, 0), { once: true });
  }
  /**
   * Thunderbird finishes starting up after its main window first paints (messenger.js
   * gMailInit._delayedStartup): offline handling, OpenPGP, filters, and the start of extension
   * backgrounds, Ember's own included. A window hidden before it paints never does, so nothing
   * appeared at launch. Run that step now, as Thunderbird itself does for "start in tray"
   * (it cancels its own paint listener, so it can't run twice).
   */
  finishStartup(win) {
    const init = win.gMailInit;
    if (init?.delayedStartupFinished) return;
    if (init && typeof init._delayedStartup === "function") {
      if (!init._boundDelayedStartup) return; // already running (it cancels its paint listener first)
      try { init._delayedStartup(); return; } catch (error) { Cu.reportError(error); }
    }
    // A Thunderbird without that step: let the window paint once, then hide it again.
    this.setVisible(win, true);
    win.addEventListener("MozAfterPaint", () => { if (this.on && !this.userShown) this.setVisible(win, false); }, { once: true });
  }
  queueOpen(msgHdr, fallback) {
    this.pendingOpen = { msgHdr, fallback };
    Promise.resolve().then(() => this.extension.wakeupBackground?.()).catch(() => {});
    setTimeout(() => {
      const pending = this.pendingOpen;
      if (!pending || pending.msgHdr !== msgHdr) return;
      this.pendingOpen = null;
      pending.fallback();
    }, 8000);
  }
  addOpener(listener) {
    this.openers.add(listener);
    const pending = this.pendingOpen;
    if (pending) { this.pendingOpen = null; listener(pending.msgHdr); }
  }
  /** Ember should come forward. If the background missed it (suspended, no listener), do it here. */
  fireReopen() {
    if (this.reopen.size) { for (const fire of this.reopen) fire(); return; }
    if (!this.focusSpark()) this.wakeSpark(5000);
  }
  /**
   * Ember's background is an event page: Thunderbird starts it only after its delayed start-up
   * (see finishStartup), and suspends it when idle. Wake it; once running it opens Ember, since
   * Thunderbird's window is hidden. Only if Ember still hasn't appeared by the deadline is
   * Thunderbird's own window shown, so the screen is never left empty.
   */
  wakeSpark(timeout) {
    if (this.waking) return;
    this.waking = true;
    Promise.resolve().then(() => this.extension.wakeupBackground?.()).catch(() => {});
    const deadline = Date.now() + timeout;
    const check = () => {
      if (this.stopped || !this.on || this.userShown || this.focusSpark()) { this.waking = false; return; }
      if (Date.now() < deadline) { setTimeout(check, 150); return; }
      this.waking = false;
      if (this.reopen.size) for (const fire of this.reopen) fire();
      else this.showMain();
    };
    setTimeout(check, 150);
  }
  isSpark(win) {
    return win.document.documentElement.getAttribute("windowtype") === "mail:extensionPopup" &&
      [...win.document.querySelectorAll("browser")].some((b) => b.currentURI && b.currentURI.spec.startsWith(this.appUrl));
  }

  /** Wire a main or Ember window once: activation of a hidden main, and close-to-minimize for Ember. */
  adopt(win) {
    if (this.seen.has(win)) return;
    this.seen.add(win);
    win.addEventListener("activate", () => {
      if (!this.on) return;
      if (!this.userShown && this.hidden.has(win)) this.fireReopen();
      // Back in Ember after a trip to Thunderbird's window (Open in Thunderbird, Switch to Thunderbird): hide it again.
      else if (this.userShown && this.isSpark(win)) this.hideMain();
    });
    win.addEventListener("close", (event) => {
      if (this.on && this.isSpark(win)) { event.preventDefault(); win.minimize(); }
    });
    // Minimized, Ember's page keeps its GPU drawing memory (about 25 MB): it stops drawing until the window
    // comes back.
    // (A moment after minimizing, once Thunderbird has finished its own handling of it.)
    // Minimized for 10 minutes: Thunderbird's graphics caches go too (~60-80 MB in the GPU process, rebuilt as
    // Ember draws again), as about:memory's "Minimize memory usage" does. Once per minimize.
    const minimized = () => {
      setTimeout(() => { if (!win.closed && win.windowState === win.STATE_MINIMIZED) this.setDrawing(win, false); }, 2000);
      clearTimeout(win.sparkTrimTimer);
      win.sparkTrimTimer = setTimeout(() => {
        if (win.closed || win.windowState !== win.STATE_MINIMIZED) return;
        try {
          Cc["@mozilla.org/memory-reporter-manager;1"].getService(Ci.nsIMemoryReporterManager).minimizeMemoryUsage(() => {});
          Services.obs.notifyObservers(null, "child-mmu-request");
        } catch (error) { Cu.reportError(error); }
      }, Services.prefs.getIntPref("extensions.spark.minimizedTrimMs", 600000));
    };
    win.addEventListener("sizemodechange", () => {
      if (!this.isSpark(win)) return;
      if (win.windowState !== win.STATE_MINIMIZED) { clearTimeout(win.sparkTrimTimer); this.setDrawing(win, true); return; }
      minimized();
    });
    if (win.windowState === win.STATE_MINIMIZED && this.isSpark(win)) minimized();
    // Closing Thunderbird's last window after switching to it means "done with Thunderbird": back to
    // Ember mode, so the Dock (which opens a new main window) brings Ember back, not Thunderbird.
    win.addEventListener("unload", () => {
      if (this.quitting || Services.startup.shuttingDown) return;
      if (this.on && this.userShown && win.document.documentElement.getAttribute("windowtype") === MAIN && !this.mains().some((w) => w !== win)) {
        if (this.focusSpark()) this.userShown = false; // only when there's an Ember to return to
      }
    });
  }
  setDrawing(win, on) {
    for (const browser of win.document.querySelectorAll("browser")) {
      if (!browser.isRemoteBrowser) continue;
      try {
        // Off: from on to off on purpose. Thunderbird already marks a minimized window inactive itself, which
        // keeps everything; only a real change from active to inactive lets the drawing resources go.
        browser.docShellIsActive = true; browser.renderLayers = true;
        if (!on) { browser.docShellIsActive = false; browser.renderLayers = false; }
      } catch (error) { Cu.reportError(error); }
    }
  }
  opened(win) {
    win.addEventListener("DOMContentLoaded", () => {
      const type = win.document.documentElement.getAttribute("windowtype");
      if (type !== MAIN && type !== "mail:extensionPopup") return;
      this.adopt(win);
      if (type !== MAIN || !this.on || this.userShown) return;
      const others = this.mains().filter((w) => w !== win);
      // A second main window is closed below: hide it, but don't run start-up for it.
      if (others.length) this.setVisible(win, false); else this.hideMainWindow(win);
      // The only main window, opened after start-up (the Dock, after Thunderbird's window was closed):
      // Ember comes forward instead.
      // Briefly later, and not if Thunderbird's window was asked for meanwhile ("Open in Thunderbird" opens one).
      if (!others.length && [...Services.wm.getEnumerator("mail:extensionPopup")].some((w) => this.isSpark(w))) {
        setTimeout(() => { if (this.on && !this.userShown && !this.stopped) this.fireReopen(); }, 300);
      }
      if (others.length) {
        // A second main window (Dock, notification, "New window") while Ember is in charge: Ember instead.
        win.addEventListener("load", () => win.setTimeout(() => win.close(), 0), { once: true });
        this.fireReopen();
      }
    }, { once: true });
  }

  apply() {
    this.applyLighten();
    if (this.on) {
      if (!this.watching) { Services.wm.addListener(this.listener); this.watching = true; }
      for (const w of [...this.mains(), ...Services.wm.getEnumerator("mail:extensionPopup")]) this.adopt(w);
      if (!this.userShown) for (const w of this.mains()) {
        this.hideMainWindow(w);
        if (w.SessionStoreManager?._restored) this.closeExtraTabs(w); // restored before Ember started
      }
    } else {
      this.unwatch();
      for (const w of this.mains()) if (this.hidden.has(w)) this.setVisible(w, true);
      this.userShown = false;
    }
    this.applyDock();
  }
  unwatch() { if (this.watching) { Services.wm.removeListener(this.listener); this.watching = false; } }
  /** Ember's icon in the Dock while Ember-only mode is on (and the user hasn't turned it off); else Thunderbird's. */
  applyDock(force = false) {
    if (Services.appinfo.OS !== "Darwin") return;
    const path = dockIconPath();
    const want = this.on && !this.stopped && Services.prefs.getBoolPref(PREF_DOCK, true) && Services.prefs.getBoolPref("extensions.spark.dockIconReady", false) ? path : "";
    if (want === (this.dockShown || "") && !force) return;
    try { setMacAppIcon(want || null); this.dockShown = want; }
    catch (error) { Cu.reportError(error); }
  }
  showMain() {
    this.userShown = true;
    const mains = this.mains();
    if (!mains.length) {
      Services.ww.openWindow(null, "chrome://messenger/content/messenger.xhtml", "_blank", "chrome,dialog=no,all", null);
      return;
    }
    for (const w of mains) if (this.hidden.has(w)) this.setVisible(w, true);
    mains[0].focus();
  }
  hideMain() {
    if (!this.on) return;
    this.userShown = false;
    for (const w of this.mains()) { this.setVisible(w, false); this.closeExtraTabs(w); }
  }
  /** While the window is hidden, only its mail tab stays (and Ember's own, in tab mode). */
  closeExtraTabs(win) {
    if (!this.on || this.userShown || win.closed || !this.hidden.has(win)) return;
    const tabmail = win.document.getElementById("tabmail");
    if (!tabmail?.tabInfo) return;
    for (const tab of [...tabmail.tabInfo].reverse()) {
      if (tab === tabmail.tabInfo[0] || tab.mode?.name === "mail3PaneTab") continue;
      if ((tab.browser?.currentURI?.spec || "").startsWith(this.appUrl)) continue;
      try { tabmail.closeTab(tab, true); } catch (error) { Cu.reportError(error); }
    }
  }
  focusSpark() {
    for (const w of Services.wm.getEnumerator("mail:extensionPopup")) {
      if (!this.isSpark(w)) continue;
      if (w.windowState === w.STATE_MINIMIZED) w.restore();
      w.focus();
      return true;
    }
    return false;
  }
  state() {
    return { sparkOnly: this.on, lighten: Services.prefs.getBoolPref(PREF_LIGHTEN, false), mainVisible: this.mains().some((w) => !this.hidden.has(w)) };
  }

  applyLighten() {
    if (this.stopped || !Services.prefs.getBoolPref(PREF_LIGHTEN, false)) { this.restoreLighten(); return; }
    // The user's own values, to put back later (also for settings added to the list since they were saved).
    let saved = {};
    try { saved = JSON.parse(Services.prefs.getStringPref(PREF_SAVED, "{}")) || {}; } catch {}
    let added = !Services.prefs.prefHasUserValue(PREF_SAVED);
    for (const name of Object.keys(LIGHTEN)) if (!(name in saved)) { saved[name] = Services.prefs.prefHasUserValue(name) ? getPref(name) : null; added = true; }
    if (added) Services.prefs.setStringPref(PREF_SAVED, JSON.stringify(saved));
    for (const [name, value] of Object.entries(LIGHTEN)) setPref(name, value);
  }
  restoreLighten() {
    if (!Services.prefs.prefHasUserValue(PREF_SAVED)) return;
    let saved = {};
    try { saved = JSON.parse(Services.prefs.getStringPref(PREF_SAVED)); } catch {}
    for (const name of Object.keys(LIGHTEN)) {
      if (saved[name] === null || saved[name] === undefined) Services.prefs.clearUserPref(name);
      else setPref(name, saved[name]);
    }
    Services.prefs.clearUserPref(PREF_SAVED);
  }

  /** The add-on is going away (disable, update, uninstall): hand Thunderbird back as it was. */
  stop(isAppShutdown) {
    if (this.MailUtils.displayMessageInFolderTab !== this.originalDisplay) this.MailUtils.displayMessageInFolderTab = this.originalDisplay;
    try { Services.obs.removeObserver(this.quitObserver, "quit-application-granted"); } catch {}
    try { Services.obs.removeObserver(this.restoredObserver, "mail-tabs-session-restored"); } catch {}
    for (const w of Services.wm.getEnumerator("mail:extensionPopup")) if (this.isSpark(w)) this.setDrawing(w, true);
    if (isAppShutdown) return;
    this.stopped = true;
    this.unwatch();
    this.restoreLighten();
    this.applyDock(); // Thunderbird's own icon again (disabled, removed or updating)
    // Ember is installing its own update (update Experiment): the new version hides the window again
    // straight away, so don't flash it. If the new version hasn't started in 20 s, show it after all.
    const updating = Number(Services.prefs.getStringPref(PREF_UPDATING, "0"));
    if (Date.now() - updating < 60000) {
      setTimeout(() => {
        if (!Services.prefs.prefHasUserValue(PREF_UPDATING)) return;
        Services.prefs.clearUserPref(PREF_UPDATING);
        for (const w of this.mains()) if (this.hidden.has(w)) this.setVisible(w, true);
      }, 20000);
      return;
    }
    for (const w of this.mains()) if (this.hidden.has(w)) this.setVisible(w, true);
  }
}

var sparkWindow = class extends ExtensionCommon.ExtensionAPI {
  mode() { if (!this.spark) this.spark = new SparkOnly(this.extension); return this.spark; }
  onStartup() {
    Services.prefs.clearUserPref(PREF_UPDATING); // this is the new version: the update went through
    const mode = this.mode();
    mode.apply();
    if (mode.on) mode.wakeSpark(20000); // a slow start (large profile) can take a while to show Ember
  }
  onShutdown(isAppShutdown) { if (this.spark) this.spark.stop(isAppShutdown); }
  getAPI(context) {
    const mode = this.mode();
    return {
      sparkWindow: {
        async configure({ sparkOnly, lighten }) {
          if (typeof sparkOnly === "boolean") Services.prefs.setBoolPref(PREF_ONLY, sparkOnly);
          if (typeof lighten === "boolean") Services.prefs.setBoolPref(PREF_LIGHTEN, lighten);
          mode.apply();
          return mode.state();
        },
        async showThunderbird() { mode.showMain(); },
        /** For the calling page's window: draw under the title bar (Ember's own window) and say how much room to
         *  leave at the top. 0 for Ember in a Thunderbird tab, in full screen, or with the unified title bar off. */
        async titlebar() {
          // The window holding the calling page (Ember's own popup window, or a Thunderbird window with Ember in a tab).
          const browser = context.xulBrowser;
          const popups = [...Services.wm.getEnumerator("mail:extensionPopup")];
          const top = browser?.ownerGlobal || browser?.ownerDocument?.defaultView
            || popups.find((w) => [...w.document.querySelectorAll("browser")].includes(browser))
            || (context.viewType === "tab" && popups.find((w) => mode.isSpark(w))) || null;
          return { inset: unifyTitlebar(top) };
        },
        /** Ember's Dock icon: save the picture (a base64 PNG, when given) in the profile, and show it or not. */
        async setDockIcon({ png, show }) {
          if (png) {
            Cu.importGlobalProperties(["atob"]);
            const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
            const path = dockIconPath();
            const current = await IOUtils.read(path).catch(() => null);
            const same = current && current.length === bytes.length && current.every((b, i) => b === bytes[i]);
            if (!same) await IOUtils.write(path, bytes, { tmpPath: `${path}.tmp` });
            Services.prefs.setBoolPref("extensions.spark.dockIconReady", true);
            if (!same) mode.dockShown = "";
          }
          if (typeof show === "boolean") Services.prefs.setBoolPref(PREF_DOCK, show);
          mode.applyDock();
          return !!mode.dockShown;
        },
        /** Thunderbird's own account setup (its Account Hub) in its main window, shown for it. Coming back to
         *  Ember's window hides Thunderbird's again (Ember-only mode), as after Switch to Thunderbird. */
        async openAccountSetup() {
          mode.showMain();
          for (let i = 0; i < 100; i++) {
            const win = Services.wm.getMostRecentWindow(MAIN);
            if (win && win.document.readyState === "complete" && (typeof win.openAccountHub === "function" || typeof win.openAccountSetupTab === "function")) {
              win.focus();
              // (Not awaited: the hub stays open while the user sets the account up.)
              if (typeof win.openAccountHub === "function") Promise.resolve(win.openAccountHub()).catch((error) => Cu.reportError(error));
              else win.openAccountSetupTab();
              return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new ExtensionError("Thunderbird's account setup didn't open.");
        },
        async hideThunderbird() { mode.hideMain(); },
        async focusSpark() { return mode.focusSpark(); },
        async state() { return mode.state(); },
        onOpenMessage: new ExtensionCommon.EventManager({
          context,
          name: "sparkWindow.onOpenMessage",
          register: (fire) => {
            const listener = (msgHdr) => { const message = context.extension.messageManager.convert(msgHdr); if (message) fire.async(message.id); };
            mode.addOpener(listener);
            return () => mode.openers.delete(listener);
          },
        }).api(),
        onReopen: new ExtensionCommon.EventManager({
          context,
          name: "sparkWindow.onReopen",
          register: (fire) => {
            const listener = () => fire.async();
            mode.reopen.add(listener);
            return () => mode.reopen.delete(listener);
          },
        }).api(),
      },
    };
  }
};
this.sparkWindow = sparkWindow;
