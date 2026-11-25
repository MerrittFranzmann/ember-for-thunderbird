#!/usr/bin/env python3
""""Before you send" in the real composer, isolated fixture profile only (port 2831). Nothing is sent:
Thunderbird is offline for the test, and the recipients are at a reserved .invalid domain or a typo of one.

Opens the composer with a never-used domain, a mistyped gmail.com address and a restricted Google Doc link,
presses Send, and checks the panel: the warnings, the typo fix (which rewrites the address in place), and
Keep editing. Saves a screenshot, discards the draft and puts Thunderbird back online.

  test_send_review.py --output-dir DIR
"""
import argparse, json, time
from pathlib import Path
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
m = spark.connect()
RESTRICTED = 'https://docs.google.com/document/d/18dSareuCRYacbNNXAoQ57xpUKZeeJvcMdhHYvCOJ8ZE/edit'

HELPERS = r"""
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, label, ms = 20000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('Timed out: ' + label); await pause(60); } };
const addTo = async (sheet, value) => { const to = sheet.querySelector('#c-to'); to.value = value; to.dispatchEvent(new Event('input', { bubbles: true })); to.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await pause(150); };
const items = () => [...document.querySelectorAll('.sheet .review li')].map((li) => ({ kind: li.className, text: li.querySelector('b')?.textContent.trim(), detail: li.querySelector('small')?.textContent.trim() || '', fix: li.querySelector('button')?.textContent.trim() || '' }));
"""


def run(js, timeout=60):
    start = ("const root = document.documentElement; root.removeAttribute('data-test-result');"
             "(async () => { %s %s })().then((v) => root.setAttribute('data-test-result', JSON.stringify({ ok: true, v: v === undefined ? null : v })),"
             "(e) => root.setAttribute('data-test-result', JSON.stringify({ ok: false, e: String(e) }))); return true;") % (HELPERS, js)
    spark.run_in_app(m, start)
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = spark.run_in_app(m, "return document.documentElement.getAttribute('data-test-result');")
        if r:
            r = json.loads(r)
            if not r['ok']: raise RuntimeError(r['e'])
            return r['v']
        time.sleep(0.4)
    raise TimeoutError('page step timed out')


# Window-free sending, as test_send_flow.py grants it (a scripted click can't answer Thunderbird's prompt).
ID = 'thunderbird-spark@merrittfranzmann'
spark.chrome_async(m, "const {ExtensionPermissions}=ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');await ExtensionPermissions.add(%s,{permissions:['messages.send'],origins:[]});const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');await (await AddonManager.getAddonByID(%s)).reload();return true;" % (json.dumps(ID), json.dumps(ID)))
time.sleep(8)
for _ in range(60):
    try:
        if spark.run_in_app(m, "return !!document.querySelector('.sidebar .item') && typeof messenger.messages.sendMessage === 'function';"): break
    except Exception: pass
    time.sleep(1)
result = {}
try:
    # Compose online (the link check starts while writing), then go offline before pressing Send.
    run(r"""
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }));
await wait(() => document.querySelector('.sheet [contenteditable=true]'), 'composer');
const sheet = document.querySelector('.sheet');
await addTo(sheet, 'Jo Doe <jo@newco-brief.invalid>');
await addTo(sheet, 'Ada <ada@gmial.com>');
const subj = sheet.querySelector('#c-subj'); subj.value = 'Review check'; subj.dispatchEvent(new Event('input', { bubbles: true }));
const editor = sheet.querySelector('[contenteditable=true]');
editor.insertAdjacentHTML('afterbegin', '<p>Notes are in <a href="%s">the planning doc</a>.</p>');
editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '.' }));
await pause(5000);
return true;""" % RESTRICTED)
    m.execute("Services.io.offline = true; return 1;")
    result['panel'] = run(r"""
const sheet = document.querySelector('.sheet');
const t = Date.now();
sheet.querySelector('.send').click();
await wait(() => document.querySelector('.sheet .review') || !document.querySelector('.sheet'), 'review');
return { ms: Date.now() - t, open: !!document.querySelector('.sheet'), items: items() };""")
    spark.app_shot(m, str(args.output_dir / 'send-review.png'))
    result['fixed'] = run(r"""
const fix = [...document.querySelectorAll('.sheet .review li button')].find((b) => b.textContent.includes('gmail.com'));
fix.click();
await wait(() => !items().some((i) => i.kind.includes('typo')), 'typo fixed');
const chips = [...document.querySelectorAll('.sheet .to-row .chip')].map((c) => c.title);
return { chips, items: items() };""")
    result['kept'] = run(r"""
[...document.querySelectorAll('.sheet .review button')].find((b) => b.textContent.trim() === 'Keep editing').click();
await pause(150);
const still = !!document.querySelector('.sheet') && !document.querySelector('.sheet .review');
// Discard the draft (Esc, then confirm when asked).
document.querySelector('.sheet').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
await pause(200);
[...document.querySelectorAll('.sheet .confirm button')].find((b) => b.textContent.trim() === 'Discard')?.click();
await wait(() => !document.querySelector('.sheet'), 'discarded');
return { still };""")
    p, f = result['panel'], result['fixed']
    kinds = [i['kind'] for i in p['items']]
    result['checks'] = {
        'held_not_sent': p['open'] and bool(p['items']),
        'typo': any('typo' in k for k in kinds) and any(i['fix'] == 'Use gmail.com' for i in p['items']),
        'new_domain': any(i['text'] == 'First email to anyone at newco-brief.invalid' for i in p['items']),
        'restricted_link': any(i['text'] == '“The planning doc” needs a sign-in' and 'Jo Doe' in i['detail'] for i in p['items']),
        'typo_fixed_in_place': f['chips'] == ['jo@newco-brief.invalid', 'ada@gmail.com'],
        'typo_gone_others_kept': not any('typo' in i['kind'] for i in f['items']) and any('newDomain' in i['kind'] for i in f['items']),
        'keep_editing': result['kept']['still'],
    }
finally:
    m.execute("Services.io.offline = false; return 1;")

(args.output_dir / 'send-review.json').write_text(json.dumps(result, indent=2, ensure_ascii=False))
print(json.dumps(result, indent=2, ensure_ascii=False))
raise SystemExit(0 if result.get('checks') and all(result['checks'].values()) else 1)
