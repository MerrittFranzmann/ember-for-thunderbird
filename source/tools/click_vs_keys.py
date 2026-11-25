#!/usr/bin/env python3
"""Compare real (Gecko-synthesized) mouse clicks on list rows with j-key navigation. Isolated profile only.

Pointer and key actions run through Marionette in the chrome window, so they take Gecko's normal input
path into the Ember tab (focus, hover, :active, selection), unlike element.click(). The page records
Event Timing entries (input -> handlers -> next paint) and rAF gaps for each phase.
"""
import argparse, json, time
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--count', type=int, default=12)
parser.add_argument('--gap', type=float, default=0.6)
parser.add_argument('--output')
args = parser.parse_args()
m = spark.connect()

SETUP = r"""
const w = window; w.__lag = { events: [], gaps: [], phase: 'idle' };
try { new PerformanceObserver((list) => { for (const e of list.getEntries()) w.__lag.events.push({ phase: w.__lag.phase, name: e.name, duration: Math.round(e.duration), delay: Math.round(e.processingStart - e.startTime), handlers: Math.round(e.processingEnd - e.processingStart), at: Math.round(e.startTime) }); }).observe({ type: 'event', durationThreshold: 16, buffered: false }); w.__lag.eventTiming = true; } catch (e) { w.__lag.eventTiming = String(e); }
let last = performance.now(); const loop = (now) => { const g = now - last; last = now; if (g > 34) w.__lag.gaps.push({ phase: w.__lag.phase, gap: Math.round(g), at: Math.round(now) }); if (!w.__lag.stop) requestAnimationFrame(loop); }; requestAnimationFrame(loop);
document.querySelector('button[aria-label="Close conversation"]')?.click();
document.querySelector('.viewport').scrollTop = 0;
return w.__lag.eventTiming;
"""

ROW_RECT = r"""
const rows = [...document.querySelectorAll('.row')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
const r = rows[%d].getBoundingClientRect(); return [r.left + 120, r.top + r.height / 2];
"""


def browser_offset():
    return spark.chrome_async(m, "const ex = __sparkBrowser(); document.getElementById('tabmail').switchToTab(ex.tab); ex.browser.focus(); const r = ex.browser.getBoundingClientRect(); return [r.left, r.top];")


def phase(name):
    spark.run_in_app(m, "window.__lag.phase = %s; return true;" % json.dumps(name))


def click(x, y):
    m._cmd('WebDriver:PerformActions', {'actions': [{'type': 'pointer', 'id': 'mouse', 'parameters': {'pointerType': 'mouse'}, 'actions': [
        {'type': 'pointerMove', 'duration': 120, 'x': int(x), 'y': int(y), 'origin': 'viewport'},
        {'type': 'pointerDown', 'button': 0}, {'type': 'pause', 'duration': 70}, {'type': 'pointerUp', 'button': 0}]}]})
    m._cmd('WebDriver:ReleaseActions', {})


def key(k):
    m._cmd('WebDriver:PerformActions', {'actions': [{'type': 'key', 'id': 'kbd', 'actions': [{'type': 'keyDown', 'value': k}, {'type': 'keyUp', 'value': k}]}]})
    m._cmd('WebDriver:ReleaseActions', {})


print('event timing:', spark.run_in_app(m, SETUP))
time.sleep(1)
ox, oy = browser_offset()
phase('click')
for i in range(args.count):
    x, y = spark.run_in_app(m, ROW_RECT % (i + 1))
    click(ox + x, oy + y)
    time.sleep(args.gap)
time.sleep(1)
phase('key')
ox, oy = browser_offset()
for i in range(args.count):
    key('j')
    time.sleep(args.gap)
time.sleep(1)
data = spark.run_in_app(m, "window.__lag.stop = true; return window.__lag;")


def summary(name):
    ev = [e for e in data['events'] if e['phase'] == name]
    gaps = [g['gap'] for g in data['gaps'] if g['phase'] == name]
    by = {}
    for e in ev:
        by.setdefault(e['name'], []).append(e['duration'])
    return {'eventDurations': {k: {'n': len(v), 'max': max(v), 'median': sorted(v)[len(v) // 2]} for k, v in by.items()},
            'framesOver34ms': len(gaps), 'worstFrames': sorted(gaps)[-5:],
            'slowest': sorted(ev, key=lambda e: -e['duration'])[:5]}

result = {'click': summary('click'), 'key': summary('key')}
print(json.dumps(result, indent=1))
if args.output:
    open(args.output, 'w').write(json.dumps({'summary': result, 'raw': data}, indent=1))
