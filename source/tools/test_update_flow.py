#!/usr/bin/env python3
"""End-to-end test of automatic updates in the isolated test Thunderbird (port 2831, Ember-only mode).

Builds three newer copies of dist/ (X.1, X.2, X.3), publishes them to a scratch update folder with
publish_update.py, installs thunderbird-spark-X.xpi permanently, then checks:
  1. minimized and idle: the 10-minute check installs X.1 by itself; Ember reopens minimized,
     Thunderbird's window stays hidden;
  2. in front (in use): the check waits and the sidebar offers "Update to X.2"; clicking it updates
     and Ember says "Ember updated to X.2";
  3. composer open: even minimized, no update; once it's discarded, X.3 installs;
  4. a wrong SHA-256 in latest.json is refused (Ember stays on X.3).
Restores thunderbird-spark-X.xpi and the default update folder at the end.

Usage: test_update_flow.py OUT_DIR    (writes update-flow.json there)
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import spark  # noqa: E402

PROJECT = spark.PROJECT
VERSION = json.load(open(os.path.join(PROJECT, "public", "manifest.json")))["version"]
XPI = os.path.join(PROJECT, f"thunderbird-spark-{VERSION}.xpi")


def chrome(m, js):
    return spark.chrome_async(m, js)


def app(m, body):
    return spark.run_in_app(m, body)


def install_xpi(m, path):
    return chrome(m, "const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');"
                     f"const i = await AddonManager.getInstallForFile(new FileUtils.File({json.dumps(path)})); return (await i.install()).version;")


def state(m):
    return json.loads(chrome(m, "const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');"
                                "const a = await AddonManager.getAddonByID('thunderbird-spark@merrittfranzmann');"
                                "return JSON.stringify({version: a.version, spark: [...Services.wm.getEnumerator('mail:extensionPopup')].map(w => w.windowState),"
                                "updating: Services.prefs.getStringPref('extensions.spark.updating', '')});"))


def minimize(m):
    """Minimize Ember and make sure it stays so (in the test instance, minimizing can activate
    Thunderbird's hidden window, which brings Ember straight back)."""
    for _ in range(6):
        chrome(m, "for (const w of Services.wm.getEnumerator('mail:extensionPopup')) w.minimize(); return true;")
        time.sleep(1.2)
        if state(m)["spark"] == [2]:
            return


def front(m):
    chrome(m, "for (const w of Services.wm.getEnumerator('mail:extensionPopup')) { w.restore(); w.focus(); } return true;")
    time.sleep(1)


def wait_version(m, version, seconds=30):
    for _ in range(seconds * 2):
        s = state(m)
        if s["version"] == version and s["spark"]:
            time.sleep(3)  # let the new page start
            return state(m)
        time.sleep(0.5)
    return state(m)


def arm(m, delay_ms=9000):
    """Fire the 10-minute update alarm soon (an app call brings Ember forward, so minimize after)."""
    app(m, f"await messenger.alarms.create('spark-update', {{when: Date.now() + {delay_ms}}}); return true;")


def build(work, version):
    out = os.path.join(work, f"thunderbird-spark-{version}.xpi")
    tree = os.path.join(work, version)
    shutil.copytree(os.path.join(PROJECT, "dist"), tree)
    manifest = json.load(open(os.path.join(tree, "manifest.json")))
    manifest["version"] = version
    json.dump(manifest, open(os.path.join(tree, "manifest.json"), "w"), indent=2)
    subprocess.run(["zip", "-r", "-X", "-q", out, ".", "-x", "*.DS_Store"], cwd=tree, check=True)
    return out


def publish(xpi, feed, notes):
    subprocess.run([sys.executable, os.path.join(HERE, "publish_update.py"), xpi, "--notes", notes, "--folder", feed], check=True, stdout=subprocess.DEVNULL)


def main():
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    work = tempfile.mkdtemp(prefix="spark-update-")
    feed = os.path.join(work, "feed")
    notes = os.path.join(work, "notes.md")
    open(notes, "w").write("# Update test\n")
    results, ok = {}, True

    def check(name, passed, detail):
        nonlocal ok
        ok = ok and passed
        detail = detail if isinstance(detail, dict) else {"value": detail}
        results[name] = {"pass": passed, **detail}
        print(("PASS " if passed else "FAIL ") + name, json.dumps(detail))

    m = spark.connect()
    # A temporary (development) install shadows the permanent one and never auto-updates: remove it first.
    print(chrome(m, "const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');"
                    "let a = await AddonManager.getAddonByID('thunderbird-spark@merrittfranzmann');"
                    "if (a && a.temporarilyInstalled) { await a.uninstall(); await new Promise(r => setTimeout(r, 3000)); }"
                    "a = await AddonManager.getAddonByID('thunderbird-spark@merrittfranzmann'); return a ? 'start: ' + a.version + ' temp=' + a.temporarilyInstalled : 'start: none';"))
    try:
        v1, v2, v3 = (f"{VERSION}.{n}" for n in (1, 2, 3))
        builds = {v: build(work, v) for v in (v1, v2, v3)}
        # Start from the release with no update folder, so its own start-up check finds nothing.
        app(m, "await messenger.storage.local.remove('updateFolder'); return true;")
        install_xpi(m, XPI)
        wait_version(m, VERSION)
        publish(builds[v1], feed, notes)
        app(m, f"await messenger.storage.local.set({{updateFolder: {json.dumps(feed)}}}); return true;")

        # 1. Minimized and idle: installs by itself.
        arm(m)
        minimize(m)
        s = wait_version(m, v1)
        check("idle-minimized-installs", s["version"] == v1 and s["spark"] == [2] and not s["updating"], s)
        hidden = app(m, "return (await messenger.sparkWindow.state()).mainVisible === false;")
        check("thunderbird-window-stays-hidden", hidden is True, {"hidden": hidden})

        # 2. In front: waits, offers Update now; the button updates and announces it.
        publish(builds[v2], feed, notes)
        front(m)
        waiting = app(m, "await messenger.alarms.create('spark-update', {when: Date.now() + 500}); await new Promise(r => setTimeout(r, 4000));"
                         "return {status: (await messenger.storage.local.get('updateStatus')).updateStatus, button: document.querySelector('.foot .update')?.textContent ?? null};")
        check("in-use-waits", state(m)["version"] == v1 and waiting["button"] == f"Update to {v2}", waiting)
        app(m, "document.querySelector('.foot .update').click(); return true;")
        s = wait_version(m, v2)
        toast = []
        for _ in range(30):  # the new page announces itself once it has started (cache, first view)
            toast = app(m, "return [...document.querySelectorAll('.toast')].map(t => t.textContent.trim());") or []
            if any(f"Ember updated to {v2}" in t for t in toast):
                break
            time.sleep(0.5)
        check("update-now-button", s["version"] == v2 and any(f"Ember updated to {v2}" in t for t in toast), {**s, "toasts": toast})

        # 3. Writing a message: no update even minimized; after discarding, it installs.
        publish(builds[v3], feed, notes)
        opened = app(m, "window.dispatchEvent(new KeyboardEvent('keydown', {key: 'n', ctrlKey: true, bubbles: true}));"
                        "await new Promise(r => setTimeout(r, 800)); return !!document.querySelector('.sheet');")
        arm(m)
        minimize(m)
        time.sleep(10)
        s = state(m)
        check("composer-blocks-update", opened is True and s["version"] == v2, {**s, "composer": opened})
        app(m, "document.querySelector('.sheet button[aria-label=Discard]').click(); await new Promise(r => setTimeout(r, 600));"
               "const confirm = document.querySelector('[aria-label=\"Discard message?\"]');"
               "if (confirm) [...confirm.querySelectorAll('button')].find(b => /discard/i.test(b.textContent))?.click(); return true;")
        closed = app(m, "return !document.querySelector('.sheet');")
        arm(m)
        minimize(m)
        time.sleep(1)
        before = state(m)
        s = wait_version(m, v3)
        s = {**s, "composerClosed": closed, "beforeCheck": before}
        check("installs-after-composer-closes", s["version"] == v3, s)

        # 4. latest.json that doesn't match its XPI: refused.
        bad = os.path.join(feed, "thunderbird-spark-bad.xpi")
        shutil.copyfile(builds[v3], bad)
        json.dump({"version": f"{VERSION}.4", "xpi": "thunderbird-spark-bad.xpi", "sha256": hashlib.sha256(b"other").hexdigest()}, open(os.path.join(feed, "latest.json"), "w"))
        r = app(m, "return await messenger.runtime.sendMessage({type: 'spark:update', install: 'now'});")
        check("wrong-hash-refused", state(m)["version"] == v3 and "doesn't match" in (r or {}).get("error", ""), {"status": r})
    finally:
        # Back to the release, reading the default update folder.
        try:
            app(m, "await messenger.storage.local.remove(['updateFolder', 'updateStatus']); return true;")
            install_xpi(m, XPI)
            wait_version(m, VERSION)
            minimize(m)
        finally:
            shutil.rmtree(work, ignore_errors=True)
    json.dump(results, open(os.path.join(out_dir, "update-flow.json"), "w"), indent=2)
    print("ALL PASS" if ok else "FAILURES")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
