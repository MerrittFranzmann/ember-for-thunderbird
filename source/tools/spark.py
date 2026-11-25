#!/usr/bin/env python3
"""Drive the isolated Ember test instance of Thunderbird over Marionette.

Uses the Marionette client from ../Thunderbird/tools/tb_probe.py on port 2831
(never 2828 = the user's Thunderbird, never 2829 = design-dev).
All input is synthesized in-process by Marionette (no OS-level events).

Usage:
  spark.py launch                 start TB on the test profile, move window to 2nd display
  spark.py install [PATH]         temporary-install the add-on (default: dist/)
  spark.py open                   open the Ember app tab (via the extension background)
  spark.py chrome  'JS'           run JS in the chrome context
  spark.py app     'JS'           run JS inside the Ember app tab (async allowed: return a Promise)
  spark.py appfile FILE           same, JS from a file
  spark.py shot OUT.png           screenshot the main window (chrome)
  spark.py appshot OUT.png        screenshot just the Ember tab content
  spark.py keys 'e'               send key presses to the app tab (WebDriver actions)
  spark.py dark|light             toggle prefers-color-scheme for content via pref
  spark.py quit                   quit the test instance
"""
import atexit
import base64
import json
import os
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(os.path.dirname(PROJECT), "Thunderbird", "tools"))
from tb_probe import Marionette  # noqa: E402

# SPARK_PORT/SPARK_PROFILE target a sealed scratch clone instead (never the live profile).
PORT = int(os.environ.get("SPARK_PORT", 2831))
PROFILE = os.environ.get("SPARK_PROFILE", "/private/tmp/claude-503/sparkprof")
TB = os.environ.get("SPARK_TB", "/Applications/Thunderbird.app/Contents/MacOS/thunderbird")
ADDON_ID = "thunderbird-spark@merrittfranzmann"

FIND_APP_BROWSER = r"""
function __sparkBrowser() {
  const tabmail = document.getElementById('tabmail');
  for (const t of tabmail ? tabmail.tabInfo : []) {  // no tabmail when Ember is the only window
    const b = t.browser || (t.chromeBrowser) || null;
    const url = b && b.currentURI && b.currentURI.spec;
    if (url && url.startsWith('moz-extension://') && url.includes('/app.html')) return {tab: t, browser: b};
  }
  // Window mode: Ember in its own popup window (no tab).
  for (const w of Services.wm.getEnumerator(null)) {
    for (const b of w.document.querySelectorAll('browser')) {
      const url = b.currentURI && b.currentURI.spec;
      if (url && url.startsWith('moz-extension://') && url.includes('/app.html')) return {tab: null, browser: b, window: w};
    }
  }
  return null;
}
"""


def connect(retries=40):
    for i in range(retries):
        try:
            m = Marionette(port=PORT)
            m.new_session()
            m.set_chrome()
            # End the session when the script exits: Marionette allows one session, and a script that exits
            # without ending its own leaves the next one refused ("an active session has been found").
            atexit.register(_end_session, m)
            return m
        except (ConnectionError, OSError, RuntimeError):
            if i == retries - 1:
                raise
            time.sleep(0.5)


def _end_session(m):
    try:
        m.sock.settimeout(3)
        m._cmd("WebDriver:DeleteSession", {})
    except Exception:
        pass


def port_open():
    try:
        socket.create_connection(("127.0.0.1", PORT), timeout=0.5).close()
        return True
    except OSError:
        return False


def launch():
    if port_open():
        print("already running")
    else:
        subprocess.Popen(
            [TB, "-profile", PROFILE, "-no-remote", "--marionette", "-remote-allow-system-access"] + (["-offline"] if os.environ.get("SPARK_OFFLINE") else []),
            stdout=open("/private/tmp/claude-503/spark-tb.log", "a"), stderr=subprocess.STDOUT,
            start_new_session=True)
        for _ in range(120):
            if port_open():
                break
            time.sleep(0.25)
    m = connect()
    # Wait for the main window, then park it on the second display.
    for _ in range(80):
        ok = m.execute("return !!document.getElementById('tabmail') && document.readyState === 'complete'")
        if ok:
            break
        time.sleep(0.25)
    m.execute("top.resizeTo(1080,1180); top.moveTo(2560,60); return [top.screenX, top.screenY, top.outerWidth, top.outerHeight]")
    print("launched", m.execute("return [top.screenX, top.screenY, top.outerWidth, top.outerHeight]"))


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "launch":
        return launch()
    m = connect()
    if cmd == "install":
        path = sys.argv[2] if len(sys.argv) > 2 else os.path.join(PROJECT, "dist")
        try:
            m._cmd("Addon:Uninstall", {"id": ADDON_ID})
        except RuntimeError:
            pass
        print(m._cmd("Addon:Install", {"path": os.path.abspath(path), "temporary": True}))
    elif cmd == "reload":
        # rebuild is done by the caller (npm run build); reinstall + reopen via the toolbar action
        try:
            m._cmd("Addon:Uninstall", {"id": ADDON_ID})
        except RuntimeError:
            pass
        m._cmd("Addon:Install", {"path": os.path.join(PROJECT, "dist"), "temporary": True})
        clicked = None
        for _ in range(40):
            time.sleep(0.25)
            clicked = m.execute("""
              const b = document.querySelector('button[title="Open Ember"]') ||
                        document.getElementById('thunderbird-spark_merrittfranzmann-spacesButton-spark');
              if (b) { b.click(); return b.id || b.title; } return null;""")
            if clicked:
                break
        print("opened via", clicked)
        time.sleep(3.0)
        print("reloaded")
    elif cmd == "open":
        js = FIND_APP_BROWSER + r"""
        const ex = __sparkBrowser();
        if (ex) { if (ex.tab) document.getElementById('tabmail').switchToTab(ex.tab); return 'switched'; }
        const policy = WebExtensionPolicy.getByID('%s');
        const url = policy.getURL('app.html');
        document.getElementById('tabmail').openTab('contentTab', {url, linkHandler: 'single-page'});
        return url;
        """ % ADDON_ID
        print(m.execute(js))
    elif cmd == "chrome":
        print(json.dumps(m.execute(sys.argv[2]), indent=2, ensure_ascii=False))
    elif cmd in ("app", "appfile"):
        body = open(sys.argv[2]).read() if cmd == "appfile" else sys.argv[2]
        print(json.dumps(run_in_app(m, body), indent=2, ensure_ascii=False))
    elif cmd == "shot":
        open(sys.argv[2], "wb").write(base64.b64decode(m.screenshot()))
        print("saved", sys.argv[2])
    elif cmd == "appshot":
        app_shot(m, sys.argv[2])
        print("saved", sys.argv[2])
    elif cmd == "type":
        send_keys(m, sys.argv[2], literal=True)
        print("typed", repr(sys.argv[2]))
    elif cmd == "keys":
        send_keys(m, sys.argv[2])
        print("sent", repr(sys.argv[2]))
    elif cmd in ("dark", "light"):
        m.execute("Services.prefs.setIntPref('layout.css.prefers-color-scheme.content-override', %d); return 1" % (0 if cmd == "dark" else 1))
        print(cmd)
    elif cmd == "quit":
        try:
            m.execute("Services.startup.quit(Ci.nsIAppStartup.eForceQuit); return 1")
        except Exception as e:  # connection drops on quit
            print("quit:", e)
        print("quit sent")
    else:
        print(__doc__)


def chrome_async(m, js):
    script = "const __done = arguments[arguments.length-1];\n" + FIND_APP_BROWSER + "\n(async () => {\n" + js + "\n})().then(v => __done(v), e => __done('ERROR: ' + (e && e.stack || e)));"
    r = m._cmd("WebDriver:ExecuteAsyncScript", {"script": script, "args": [], "scriptTimeout": 90000})
    return r.get("value") if isinstance(r, dict) else r


# In the daytime the test window sits behind the user's own windows: macOS reports it fully occluded, the
# page turns "hidden", and Ember (rightly) stops regrouping lists for nobody — so searches and views look empty
# to a probe. Probes mark the page active instead (no window is moved or raised). Minimized windows stay hidden
# (the hidden-page measurements minimize on purpose). Set KEEP_ACTIVE = False to observe real occlusion.
KEEP_ACTIVE = True
def keep_active(m):
    if not KEEP_ACTIVE:
        return
    try:
        m.execute("for (const w of Services.wm.getEnumerator('mail:extensionPopup')) { const b = w.document.querySelector('browser');"
                  " if (b && w.windowState !== w.STATE_MINIMIZED && !b.browsingContext.isActive) b.browsingContext.isActive = true; } return true;")
    except Exception:
        pass


def run_in_app(m, body):
    """Evaluate async JS inside the Ember page through Marionette's own window actor
    (works with remote extension pages; the code runs with the page's principal)."""
    keep_active(m)
    js = r"""
    const ex = __sparkBrowser();
    if (!ex) return 'ERROR: Ember tab not open';
    const wg = ex.browser.browsingContext.currentWindowGlobal;
    const code = %s;
    const script = 'return (async () => {' + code + '\n})().then(v => JSON.stringify(v === undefined ? null : v), e => JSON.stringify("ERROR: " + e + "\\n" + (e && e.stack)));';
    const r = await wg.getActor('MarionetteCommands').executeScript(script, [], {timeout: 80000});
    try { return JSON.parse(r); } catch (e) { return r; }
    """ % json.dumps(body)
    return chrome_async(m, js)


# Settings is its own window (settings.html), opened from Ember's gear.
FIND_SETTINGS = r"""
const __settings = () => { for (const w of Services.wm.getEnumerator('mail:extensionPopup')) { const b = w.document.querySelector('browser'); if (b?.currentURI?.spec.includes('/settings.html')) return { w, b }; } return null; };
"""


def in_settings(m, body):
    """Evaluate async JS inside Ember's Settings window (like run_in_app)."""
    js = FIND_SETTINGS + r"""
    const s = __settings(); if (!s) return 'ERROR: no settings window';
    if (s.w.windowState !== s.w.STATE_MINIMIZED) s.b.browsingContext.isActive = true;
    const code = %s;
    const script = 'return (async () => {' + code + '\n})().then(v => JSON.stringify(v === undefined ? null : v), e => JSON.stringify("ERROR: " + e + "\\n" + (e && e.stack)));';
    const r = await s.b.browsingContext.currentWindowGlobal.getActor('MarionetteCommands').executeScript(script, [], {timeout: 60000});
    try { return JSON.parse(r); } catch (e) { return r; }
    """ % json.dumps(body)
    r = chrome_async(m, js)
    if isinstance(r, str) and r.startswith('ERROR'): raise RuntimeError(r)
    return r


# In the Settings window: the item titled (starting with) `t` on the open section.
SETTING_ITEM = "const item = (t) => [...document.querySelectorAll('.card .item')].find((i) => i.querySelector('b')?.textContent.startsWith(t));"


def open_settings(m, section, title):
    """Settings at `section` (as Ember's gear and links open it); waits for the item titled `title`."""
    run_in_app(m, "await messenger.runtime.sendMessage({ type: 'spark:settings', section: %s }); return true;" % json.dumps(section))
    for _ in range(60):
        try:
            if in_settings(m, SETTING_ITEM + "return !!item(%s);" % json.dumps(title)) is True: return
        except RuntimeError: pass
        time.sleep(0.3)
    raise TimeoutError('Settings window did not open')


def close_settings(m):
    chrome_async(m, FIND_SETTINGS + "__settings()?.w.close(); return true;")


def app_shot(m, out, scale=2):
    js = r"""
    const ex = __sparkBrowser();
    if (!ex) return 'ERROR: Ember tab not open';
    const b = ex.browser;
    const w = b.contentWindow; const rect = new DOMRect(0, 0, w ? w.innerWidth : b.clientWidth, w ? w.innerHeight : b.clientHeight); const bmp = await b.browsingContext.currentWindowGlobal.drawSnapshot(rect, SCALE, 'white');
    const c = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    return c.toDataURL('image/png').split(',')[1];
    """.replace("SCALE", str(float(scale)))
    data = chrome_async(m, js)
    if isinstance(data, str) and data.startswith("ERROR"):
        raise RuntimeError(data)
    open(out, "wb").write(base64.b64decode(data))


def send_keys(m, seq, literal=False):
    """In-process synthesized key presses (Marionette actions, chrome context)."""
    focus = r"""
    const ex = __sparkBrowser(); if (!ex) return 'no tab';
    if (ex.tab) document.getElementById('tabmail').switchToTab(ex.tab);
    ex.browser.focus(); return 'ok';
    """
    chrome_async(m, focus)
    keymap = {"ENTER": "", "ESC": "", "BACKSPACE": "", "DOWN": "", "UP": "", "TAB": "", "META": ""}
    actions = []
    if literal:
        tokens = list(seq)
    else:
        tokens = seq.split(" ") if " " in seq or seq.upper() in keymap or "+" in seq else list(seq)
    for t in tokens:
        if not t:
            continue
        if not literal and "+" in t and len(t) > 1:
            parts = t.split("+")
            ks = [keymap.get(x.upper(), x) for x in parts]
            actions += [{"type": "keyDown", "value": k} for k in ks]
            actions += [{"type": "keyUp", "value": k} for k in reversed(ks)]
        else:
            k = keymap.get(t.upper(), t) if (len(t) > 1 and not literal) else t
            actions += [{"type": "keyDown", "value": k}, {"type": "keyUp", "value": k}]
    m._cmd("WebDriver:PerformActions", {"actions": [{"type": "key", "id": "kbd", "actions": actions}]})
    m._cmd("WebDriver:ReleaseActions", {})


if __name__ == "__main__":
    main()
