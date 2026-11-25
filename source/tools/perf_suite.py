#!/usr/bin/env python3
"""Speed and resource scoreboard, isolated profile only (port 2831). Run with the build to measure
installed (spark.py install; open). Prints one JSON line per metric group and writes all to --out.

  startup   page reload → first view and → all saved headers (median of 3)
  views     sidebar/tab switches, first pass and cached (smoke/perf-views.js)
  open      opening conversations: body painted (smoke/open-render.js, perf fixtures)
  search    saved-mail search, 6 queries (smoke/search-speed.js)
  scroll    list and reader scrolling frame gaps (smoke/scroll-frames.js)
  idle      CPU seconds used by Thunderbird's parent and extension processes over 60 s with Ember idle
  memory    extension process resident MB idle (after heap-minimize), after the workload, and minimized again

  perf_suite.py --out FILE [--only startup,views,...]
"""
import argparse, json, statistics, sys, time
from pathlib import Path
import spark, run_probe

HERE = Path(__file__).resolve().parent

PROC = """const info = await ChromeUtils.requestProcInfo();
const ext = info.children.filter(c => c.type === 'extension');
return JSON.stringify({ parentCpu: info.cpuTime, parentMb: Math.round(info.memory / 1048576),
  extCpu: ext.reduce((n, c) => n + c.cpuTime, 0), extMb: ext.map(c => Math.round(c.memory / 1048576)),
  allCpu: info.cpuTime + info.children.reduce((n, c) => n + c.cpuTime, 0) });"""
# The extension process's physical footprint (what macOS's Activity Monitor shows) and malloc heap.
FOOTPRINT = """const mgr = Cc["@mozilla.org/memory-reporter-manager;1"].getService(Ci.nsIMemoryReporterManager);
const out = {};
await new Promise((resolve) => mgr.getReports((process, path, kind, units, amount) => {
  if (!/extension/i.test(process) || units !== Ci.nsIMemoryReporter.UNITS_BYTES) return;
  if (path === 'resident-phys-footprint' || path === 'heap-allocated' || path === 'resident-unique') out[path] = (out[path] || 0) + amount;
}, null, () => resolve(), null, false));
return JSON.stringify({ footprintMb: Math.round((out['resident-phys-footprint'] || 0) / 1048576), heapMb: Math.round((out['heap-allocated'] || 0) / 1048576), uniqueMb: Math.round((out['resident-unique'] || 0) / 1048576) });"""
GC = """for (let i = 0; i < 3; i++) { Services.obs.notifyObservers(null, 'memory-pressure', 'heap-minimize'); await new Promise(r => setTimeout(r, 1500)); } return 1;"""


def proc(m):
    return json.loads(spark.chrome_async(m, PROC))


def probe(m, name, config='{}', timeout=600):
    r = run_probe.run(m, str(HERE / 'smoke' / name), config, timeout=timeout)
    if not r.get('ok'):
        raise RuntimeError(f'{name}: {r.get("error")}')
    return r['value']


def startup(m):
    firsts, caches = [], []
    for _ in range(3):
        try:
            spark.run_in_app(m, "setTimeout(() => location.reload(), 50); return 1;")
        except Exception:
            pass
        time.sleep(10)
        marks = spark.run_in_app(m, """const marks = performance.getEntriesByType('mark').filter((e) => e.name.startsWith('spark:')).map((e) => [e.name.slice(6), Math.round(e.startTime)]);
return Object.fromEntries(marks);""")
        firsts.append(marks.get('first-view'))
        caches.append(marks.get('cache'))
    ok = lambda xs: [x for x in xs if isinstance(x, (int, float))]
    return {'firstViewMs': statistics.median(ok(firsts)) if ok(firsts) else None, 'allHeadersMs': statistics.median(ok(caches)) if ok(caches) else None, 'runs': list(zip(firsts, caches))}


def idle(m, seconds=30):
    """Lowest of two windows, after the local cache has finished any sync (a fresh install re-syncs)."""
    spark.run_in_app(m, "document.querySelector('[data-mailbox=\"inbox\"] .item.parent')?.click(); return 1;")
    for _ in range(150):
        if spark.run_in_app(m, "return (await messenger.storage.local.get('cacheStatus')).cacheStatus?.phase;") == 'ready':
            break
        time.sleep(2)
    # The startup group's reloads leave deferred work (index warm-up, classification) and three pages' garbage
    # behind; 8 s measured that GC as Ember's idle CPU (0.25 s vs 0.04 s per 30 s once settled).
    time.sleep(30)
    best = None
    for _ in range(2):
        a = proc(m)
        time.sleep(seconds)
        b = proc(m)
        r = {'seconds': seconds, 'parentCpuS': round((b['parentCpu'] - a['parentCpu']) / 1e9, 2), 'extensionCpuS': round((b['extCpu'] - a['extCpu']) / 1e9, 2), 'allCpuS': round((b['allCpu'] - a['allCpu']) / 1e9, 2)}
        if best is None or r['extensionCpuS'] < best['extensionCpuS']:
            best = r
    return best


def footprint(m):
    return json.loads(spark.chrome_async(m, FOOTPRINT))


def memory(m, workload):
    spark.chrome_async(m, GC)
    idle_fp = footprint(m)
    workload()
    after_fp = footprint(m)
    spark.chrome_async(m, GC)
    settled = footprint(m)
    return {'idle': idle_fp, 'afterWork': after_fp, 'afterMinimize': settled}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--only', default='')
    args = parser.parse_args()
    only = set(filter(None, args.only.split(',')))
    want = lambda k: not only or k in only
    m = spark.connect()
    m.execute("for (const w of Services.wm.getEnumerator('mail:extensionPopup')) { w.restore(); } return true;")
    out = {'version': spark.run_in_app(m, "return messenger.runtime.getManifest().version;"), 'at': time.strftime('%H:%M:%S')}

    def record(key, value):
        out[key] = value
        print(json.dumps({key: value if key != 'views' else {k: v for k, v in value.items() if k != 'steps'}}), flush=True)

    def workload():
        if want('views'):
            record('views', probe(m, 'perf-views.js'))
        if want('open'):
            v = probe(m, 'open-render.js')
            recs = v.get('records', [])
            record('open', {'bodyMedianMs': statistics.median([r['body'] for r in recs if r.get('body') is not None]) if recs else None, 'records': [{k: (round(r[k]) if isinstance(r.get(k), float) else r.get(k)) for k in ('subject', 'repeat', 'shell', 'body', 'finalHeightAt', 'maxFrameMs', 'maxStallMs') if k in r} for r in recs]})
        if want('search'):
            s = probe(m, 'search-speed.js')
            record('search', {'medianMs': statistics.median([q['ms'] for q in s]), 'maxMs': max(q['ms'] for q in s), 'worstFrame': max(q['maxFrame'] for q in s), 'queries': s})
        if want('scroll'):
            record('scroll', probe(m, 'scroll-frames.js'))

    if want('startup'):
        record('startup', startup(m))
    if want('idle'):
        record('idle', idle(m))
    if want('memory'):
        record('memory', memory(m, workload))
    else:
        workload()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=2))
    m.execute("for (const w of Services.wm.getEnumerator('mail:extensionPopup')) w.minimize(); return true;")


if __name__ == '__main__':
    main()
