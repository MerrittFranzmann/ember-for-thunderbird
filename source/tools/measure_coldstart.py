#!/usr/bin/env python3
"""Cold start of the isolated test Thunderbird (port 2831), N times: from launching Thunderbird to Ember's
first view and to all saved headers loaded (wall clock, from the page's own marks), plus the extension
process's peak and settled memory. Connects only after the wait, so the session doesn't change start-up.
Ember must be installed permanently (Addon:Install temporary:false).
  measure_coldstart.py [N] [--wait 30]
"""
import json, os, statistics, subprocess, sys, time
import spark

PROFILE = spark.PROFILE
N = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 3
WAIT = int(sys.argv[sys.argv.index('--wait') + 1]) if '--wait' in sys.argv else 30
MEM = """const mgr = Cc["@mozilla.org/memory-reporter-manager;1"].getService(Ci.nsIMemoryReporterManager); const out = {};
await new Promise((resolve) => mgr.getReports((process, path, kind, units, amount) => { if (/extension/i.test(process) && units === Ci.nsIMemoryReporter.UNITS_BYTES && (path === 'resident-peak' || path === 'resident-phys-footprint')) out[path] = (out[path] || 0) + amount; }, null, () => resolve(), null, false));
return JSON.stringify({ peakMb: Math.round((out['resident-peak'] || 0) / 1048576), footprintMb: Math.round((out['resident-phys-footprint'] || 0) / 1048576) });"""


def test_pids():
    out = subprocess.run(['pgrep', '-f', f'MacOS/thunderbird -profile {PROFILE}'], capture_output=True, text=True).stdout
    return [int(p) for p in out.split()]


def quit_tb():
    """Quit the TEST Thunderbird (its profile only): politely over Marionette, else SIGTERM to its pid
    (a lingering Marionette session refuses new connections)."""
    if not test_pids():
        return
    try:
        spark.connect(retries=4).execute('Services.startup.quit(Ci.nsIAppStartup.eForceQuit); return 1')
    except Exception:
        for pid in test_pids():
            os.kill(pid, 15)
    for _ in range(60):
        if not test_pids():
            return
        time.sleep(0.5)


runs = []
for i in range(N):
    quit_tb()
    time.sleep(2)
    t0 = time.time() * 1000
    subprocess.Popen([spark.TB, '-profile', PROFILE, '-no-remote', '--marionette', '-remote-allow-system-access'],
                     stdout=open('/private/tmp/claude-503/spark-tb.log', 'a'), stderr=subprocess.STDOUT, start_new_session=True)
    time.sleep(WAIT)
    m = spark.connect()
    marks = None
    for _ in range(40):
        try:
            marks = spark.run_in_app(m, "return { origin: performance.timeOrigin, marks: Object.fromEntries(performance.getEntriesByType('mark').filter(e => e.name.startsWith('spark:')).map(e => [e.name.slice(6), e.startTime])) };")
            if isinstance(marks, dict) and 'cache' in marks.get('marks', {}):
                break
        except Exception:
            pass
        time.sleep(1)
    mem = json.loads(spark.chrome_async(m, MEM))
    origin = marks['origin'] if isinstance(marks, dict) else None
    at = lambda k: round(origin + marks['marks'][k] - t0) if origin and k in marks['marks'] else None
    run = {'pageOpenedMs': round(origin - t0) if origin else None, 'firstViewMs': at('first-view'), 'allHeadersMs': at('cache'), **mem,
           'marks': {k: round(v) for k, v in marks['marks'].items()} if isinstance(marks, dict) else None}
    print(json.dumps(run), flush=True)
    runs.append(run)
    m.execute("for (const w of Services.wm.getEnumerator('mail:extensionPopup')) w.minimize(); return true;")
    spark._end_session(m)  # the next run's quit connects again
med = lambda k: statistics.median([r[k] for r in runs if r.get(k) is not None]) if any(r.get(k) is not None for r in runs) else None
print(json.dumps({'median': {k: med(k) for k in ('pageOpenedMs', 'firstViewMs', 'allHeadersMs', 'peakMb', 'footprintMb')}}))
