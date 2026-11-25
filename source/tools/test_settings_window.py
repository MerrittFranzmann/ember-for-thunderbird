#!/usr/bin/env python3
"""Ember's Settings window, isolated fixture profile only (port 2831).

Opens it from Ember's gear, checks the sections and search ("undo", "tracking pixels", a shortcut, no match),
changes Appearance and Undo send there and checks the Ember window follows, opens it again at a section
(one window, moved to that section), takes screenshots (light and dark), and closes it with ⌘W.

  test_settings_window.py --output-dir DIR
"""
import argparse, base64, json, time
from pathlib import Path
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
m = spark.connect()

FIND = r"""
const __settings = () => { for (const w of Services.wm.getEnumerator('mail:extensionPopup')) { const b = w.document.querySelector('browser'); if (b?.currentURI?.spec.includes('/settings.html')) return { w, b }; } return null; };
"""


def in_settings(body):
    js = FIND + r"""
    const s = __settings(); if (!s) return 'ERROR: no settings window';
    if (s.w.windowState !== s.w.STATE_MINIMIZED) s.b.browsingContext.isActive = true;
    const code = %s;
    const script = 'return (async () => {' + code + '\n})().then(v => JSON.stringify(v === undefined ? null : v), e => JSON.stringify("ERROR: " + e + "\\n" + (e && e.stack)));';
    const r = await s.b.browsingContext.currentWindowGlobal.getActor('MarionetteCommands').executeScript(script, [], {timeout: 60000});
    try { return JSON.parse(r); } catch (e) { return r; }
    """ % json.dumps(body)
    r = spark.chrome_async(m, js)
    if isinstance(r, str) and r.startswith('ERROR'): raise RuntimeError(r)
    return r


def shot(name):
    js = FIND + r"""
    const s = __settings(); const w = s.b.contentWindow;
    const bmp = await s.b.browsingContext.currentWindowGlobal.drawSnapshot(new DOMRect(0, 0, s.b.clientWidth, s.b.clientHeight), 2, 'white');
    const c = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0);
    return c.toDataURL('image/png').split(',')[1];"""
    (args.output_dir / name).write_bytes(base64.b64decode(spark.chrome_async(m, js)))


def windows():
    return spark.chrome_async(m, FIND + "let n = 0; for (const w of Services.wm.getEnumerator('mail:extensionPopup')) if (w.document.querySelector('browser')?.currentURI?.spec.includes('/settings.html')) n++; return n;")


def wait_for(fn, label, seconds=20):
    end = time.time() + seconds
    while time.time() < end:
        v = fn()
        if v: return v
        time.sleep(0.3)
    raise TimeoutError(label)


HELP = r"""const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, label) => { for (let i = 0; i < 300; i++) { const v = fn(); if (v) return v; await pause(50); } throw new Error('Timed out: ' + label); };
const search = async (q) => { const i = document.querySelector('.search input'); i.value = q; i.dispatchEvent(new Event('input', { bubbles: true })); await pause(120); return { groups: [...document.querySelectorAll('.pane h2')].map((h) => h.textContent.trim()), titles: [...document.querySelectorAll('.pane .txt b')].map((b) => b.textContent.trim()), keys: [...document.querySelectorAll('.keys dd')].map((d) => d.textContent.trim()), empty: document.querySelector('.empty')?.textContent || '' }; };
"""
result = {}
before = spark.run_in_app(m, "return (await messenger.storage.local.get({ theme: 'system', undoSend: 120 }));")
try:
    assert windows() == 0, 'a settings window is already open'
    spark.run_in_app(m, "document.querySelector('.sidebar button[aria-label=\"Settings\"]').click(); return true;")
    wait_for(lambda: windows() == 1 and in_settings("return !!document.querySelector('.side li button.on');") is True, 'settings window')
    r = in_settings(HELP + r"""
const sections = [...document.querySelectorAll('.side li button')].map((b) => b.textContent.trim());
const general = [...document.querySelectorAll('.pane .txt b')].map((b) => b.textContent.trim());
const focused = document.activeElement === document.querySelector('.search input');
const undo = await search('undo');
const pixels = await search('tracking pixels');
const shortcut = await search('reply all');
const none = await search('zebra');
document.querySelector('.search input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await pause(100);
return { sections, general, focused, undo, pixels, shortcut, none, cleared: document.querySelector('.search input').value === '' && document.querySelector('.pane h1').textContent };""")
    result['window'] = r
    assert r['sections'][:4] == ['General', 'Inboxes', 'Reading', 'Sending'] and 'Keyboard shortcuts' in r['sections'], r['sections']
    assert r['general'] == ['Appearance', 'Mark as read when opened', 'Group conversations'] or r['general'][0] == 'Appearance', r['general']
    assert r['focused'], 'search not focused'
    assert 'Undo send' in r['undo']['titles'] and r['undo']['groups'][0] == 'Sending', r['undo']
    assert r['pixels']['titles'] == ['Always load remote images'], r['pixels']
    assert r['shortcut']['groups'][-1] == 'Keyboard shortcuts' and r['shortcut']['keys'] == ['Reply all'], r['shortcut']
    assert 'No settings match' in r['none']['empty'], r['none']
    assert r['cleared'] == 'General', r['cleared']
    shot('settings-general.png')

    # Changes here reach the Ember window.
    in_settings(HELP + r"""
[...document.querySelectorAll('.side li button')].find((b) => b.textContent.trim() === 'Sending').click(); await pause(100);
const sel = document.querySelector('select[aria-label="Undo send"]'); sel.value = '30'; sel.dispatchEvent(new Event('change', { bubbles: true }));
[...document.querySelectorAll('.side li button')].find((b) => b.textContent.trim() === 'General').click(); await pause(100);
[...document.querySelectorAll('.seg button')].find((b) => b.textContent === 'Dark').click(); await pause(300); return true;""")
    follows = wait_for(lambda: (lambda v: v if v and v['theme'] == 'dark' else None)(spark.run_in_app(m, "return { theme: document.documentElement.dataset.theme, stored: (await messenger.storage.local.get('undoSend')).undoSend };")), 'Ember follows the theme')
    assert follows['stored'] == 30, follows
    result['spark_follows'] = follows
    shot('settings-general-dark.png')
    in_settings(HELP + "[...document.querySelectorAll('.side li button')].find((b) => b.textContent.trim() === 'AI').click(); await pause(150); return true;")
    shot('settings-ai-dark.png')

    # Opening again at a section reuses the window.
    spark.run_in_app(m, "await messenger.runtime.sendMessage({ type: 'spark:settings', section: 'sending' }); return true;")
    at = wait_for(lambda: (lambda h: h if h == 'Sending' else None)(in_settings("return document.querySelector('.pane h1')?.textContent;")), 'section from the hash')
    assert windows() == 1
    result['reopen'] = {'section': at, 'windows': windows()}
    shot('settings-sending-dark.png')
    in_settings("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', metaKey: true, bubbles: true, cancelable: true })); return true;")
    wait_for(lambda: windows() == 0, 'closed with ⌘W')
    result['closed'] = True
    (args.output_dir / 'settings-window.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result, indent=2))
    print('PASS')
finally:
    spark.run_in_app(m, "await messenger.storage.local.set(%s); return true;" % json.dumps(before))
    if windows():
        spark.chrome_async(m, FIND + "__settings()?.w.close(); return true;")
