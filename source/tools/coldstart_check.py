#!/usr/bin/env python3
"""Cold start of the isolated test Thunderbird (port 2831) with Ember installed permanently: quits it,
relaunches, and reports when the Ember window shows rows and which windows are visible. Ember-only
mode should show the Ember window only, with Thunderbird's own window hidden.

  coldstart_check.py
"""
import json, subprocess, time
import spark

try:
    spark.connect().execute("Services.startup.quit(Ci.nsIAppStartup.eForceQuit); return 1")
except Exception:
    pass
for _ in range(60):
    if subprocess.run(['pgrep', '-f', f'-profile {spark.PROFILE}'], capture_output=True).returncode: break
    time.sleep(0.5)
t0 = time.time()
subprocess.Popen([spark.TB, "-profile", spark.PROFILE, "-no-remote", "--marionette", "-remote-allow-system-access"],
                 stdout=open("/private/tmp/claude-503/spark-tb.log", "a"), stderr=subprocess.STDOUT, start_new_session=True)
while not spark.port_open(): time.sleep(0.1)
m = spark.connect()
WINDOWS = """return [...Services.wm.getEnumerator(null)].map(w => [w.document.documentElement.getAttribute('windowtype'), w.windowState,
  w.docShell.treeOwner.QueryInterface(Ci.nsIInterfaceRequestor).getInterface(Ci.nsIAppWindow).QueryInterface(Ci.nsIBaseWindow).visibility])"""
timeline, rows_at = [], None
while time.time() - t0 < 30:
    wins = m.execute(WINDOWS)
    timeline.append([round(time.time() - t0, 1), wins])
    if any(w[0] == 'mail:extensionPopup' for w in wins) and rows_at is None:
        try:
            r = spark.run_in_app(m, "return document.querySelectorAll('.row').length")
            if isinstance(r, int) and r > 0: rows_at = round(time.time() - t0, 1)
        except Exception:
            pass
    if rows_at is not None and time.time() - t0 > rows_at + 4: break
    time.sleep(0.4)
changes = [timeline[0]] + [t for i, t in enumerate(timeline[1:], 1) if t[1] != timeline[i - 1][1]]
print(json.dumps({'sparkRowsAt': rows_at, 'windowChanges': changes, 'final': timeline[-1]}))
