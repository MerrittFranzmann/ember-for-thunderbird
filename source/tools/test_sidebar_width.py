#!/usr/bin/env python3
"""The sidebar's width, dragged by its edge like Spark's, in the isolated fixture profile only (port 2831).

Synthesized pointer and key events in the page (the real mouse and keyboard are never used). Checks: the usual
width; dragging the edge widens the sidebar and the list moves with it; the width is saved and kept after a reload;
the arrow keys on the focused edge; never wider than the window has room for; double-click puts back the usual
width. Puts the setting back.

  test_sidebar_width.py --output-dir DIR
"""
import argparse, json, time
from pathlib import Path
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
m = spark.connect()

HELPERS = r'''
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms = 8000) => { for (let t = 0; t < ms; t += 100) { const v = test(); if (v) return v; await pause(100); } return test(); };
const side = () => Math.round(document.querySelector('.col-side').getBoundingClientRect().width);
const listLeft = () => Math.round(document.querySelector('.col-list').getBoundingClientRect().left);
const handle = () => document.querySelector('.side-resize');
const saved = async () => (await messenger.storage.local.get('sidebarWidth')).sidebarWidth;
const drag = async (dx) => {
  const h = handle(), r = h.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + 200;
  const ev = (type, cx) => h.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: cx, clientY: y, isPrimary: true }));
  ev('pointerdown', x);
  for (let i = 1; i <= 5; i++) { ev('pointermove', x + dx * i / 5); await pause(30); }
  ev('pointerup', x + dx);
  await pause(400);
};
'''
def page(body):
    r = spark.run_in_app(m, HELPERS + body)
    if isinstance(r, str) and r.startswith('ERROR'): raise RuntimeError(r)
    return r

original = page("return (await messenger.storage.local.get('sidebarWidth')).sidebarWidth ?? null;")
result = {}
try:
    page("await messenger.storage.local.set({ sidebarWidth: 232 }); await pause(500); return 1;")
    result['usual'] = page("return { side: side(), handle: !!handle(), role: handle()?.getAttribute('role'), value: handle()?.getAttribute('aria-valuenow'), window: innerWidth };")
    result['dragged'] = page("const before = listLeft(); await drag(100); return { side: side(), listMoved: listLeft() - before, saved: await saved(), value: handle().getAttribute('aria-valuenow') };")
    spark.app_shot(m, str(args.output_dir / 'sidebar-wide.png'))
    page("setTimeout(() => location.reload(), 50); return 1;")
    time.sleep(3)
    for _ in range(60):
        try:
            if page("return !!handle() && !!document.querySelector('.sidebar .item');"): break
        except Exception: pass
        time.sleep(0.5)
    result['after_reload'] = page("await pause(500); return side();")
    result['keys'] = page("""handle().focus();
const key = (k, shift = false) => handle().dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey: shift, bubbles: true, cancelable: true }));
key('ArrowLeft'); await until(async () => side() === 316); const left = side();
key('ArrowRight', true); await pause(300); const right = side();
return { left, right, saved: await saved() };""")
    result['widest'] = page("await drag(2000); return { side: side(), saved: await saved(), room: Math.min(420, Math.floor(innerWidth * 0.34)) };")
    result['double_click'] = page("handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await pause(500); return { side: side(), saved: await saved() };")
finally:
    page("await messenger.storage.local.set({ sidebarWidth: %s }); return 1;" % json.dumps(original if original is not None else 232))
    spark._end_session(m)

r = result
checks = {
    'usual_width_with_a_handle': r['usual']['side'] == 232 and r['usual']['handle'] and r['usual']['role'] == 'separator' and r['usual']['value'] == '232',
    'drag_widens_and_list_follows': r['dragged']['side'] == 332 and r['dragged']['listMoved'] == 100 and r['dragged']['value'] == '332',
    'saved_and_kept_after_reload': r['dragged']['saved'] == 332 and r['after_reload'] == 332,
    # Shift+Right is +64 (to 380), but never past the room the window leaves (34% of it).
    'arrow_keys': r['keys']['left'] == 316 and r['keys']['right'] == min(380, int(r['usual']['window'] * 0.34)) and r['keys']['saved'] == r['keys']['right'],
    'never_wider_than_room': r['widest']['side'] == r['widest']['room'] and r['widest']['saved'] == r['widest']['room'],
    'double_click_usual_width': r['double_click'] == {'side': 232, 'saved': 232},
}
result['checks'] = checks
(args.output_dir / 'sidebar-width.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
print('ALL PASS' if all(checks.values()) else 'FAIL: ' + ', '.join(k for k, v in checks.items() if not v))
raise SystemExit(0 if all(checks.values()) else 1)
