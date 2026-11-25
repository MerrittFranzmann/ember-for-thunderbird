#!/usr/bin/env python3
"""Links that open an email in Ember (src/lib/mail-links.ts), isolated fixture profile only (port 2831). The test
Thunderbird answers links on its own port (pref extensions.spark.mailLinkPort = 47392, never the real Ember's
47391) and never comes to the front (extensions.spark.mailLinkActivate = false).

Checks, as a browser would ask: a clicked link (GET with Sec-Fetch-Mode: navigate) answers "Opening in Ember" and
Ember shows that email (the code is worked out here independently, from the email's Message-ID); a link preview
(HEAD), another site's name for the address (DNS rebinding), a web page loading it as an image, and a POST don't
open anything; a link to an email that isn't there says so in Ember; the row menu offers Copy link (not clicked:
tests never touch the clipboard); Settings → Links to emails shows the address, and turning it off closes the port
and hides Copy link, and on again reopens it.

  test_mail_links.py --output-dir DIR
"""
import argparse, http.client, json, socket, time
from pathlib import Path
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)

PORT = 47392
SUBJECT = 'Reading pane layout review'

def link_code(message_id):
    """The same 53-bit cyrb53 hash as mail-links.ts, written separately."""
    s = message_id.strip()
    if s.startswith('<'): s = s[1:]
    if s.endswith('>'): s = s[:-1]
    M = 0xFFFFFFFF
    imul = lambda a, b: (a * b) & M
    h1, h2 = 0xDEADBEEF, 0x41C6CE57
    for ch in s:
        c = ord(ch)
        h1 = imul(h1 ^ c, 2654435761)
        h2 = imul(h2 ^ c, 1597334677)
    h1 = imul(h1 ^ (h1 >> 16), 2246822507) ^ imul(h2 ^ (h2 >> 13), 3266489909)
    h2 = imul(h2 ^ (h2 >> 16), 2246822507) ^ imul(h1 ^ (h1 >> 13), 3266489909)
    n = 4294967296 * (2097151 & h2) + h1
    digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    out = ''
    while n: n, r = divmod(n, 36); out = digits[r] + out
    return out.rjust(11, '0')

def ask(method, path, headers=None):
    conn = http.client.HTTPConnection('127.0.0.1', PORT, timeout=5)
    try:
        conn.request(method, path, headers={'Host': f'127.0.0.1:{PORT}', **(headers or {})})
        r = conn.getresponse()
        return {'status': r.status, 'body': r.read().decode('utf-8', 'replace'), 'csp': r.getheader('Content-Security-Policy')}
    except (ConnectionRefusedError, socket.timeout, OSError) as error:
        return {'status': None, 'error': type(error).__name__}
    finally: conn.close()
CLICK = {'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-User': '?1'}

m = spark.connect()
prefs = m.execute("return [Services.prefs.getIntPref('extensions.spark.mailLinkPort', 47391), Services.prefs.getBoolPref('extensions.spark.mailLinkActivate', true)];")
if prefs != [PORT, False]:
    raise SystemExit(f'the test profile must set extensions.spark.mailLinkPort={PORT} and mailLinkActivate=false (has {prefs}): run tools/prepare_test_profile.sh')

HELPERS = r'''
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms = 10000) => { for (let t = 0; t < ms; t += 100) { const v = test(); if (v) return v; await pause(100); } return test(); };
const rows = () => [...document.querySelectorAll('.viewport .row')];
const shown = () => document.querySelector('.reader h1.subject')?.textContent.trim() || null;
const toasts = () => [...document.querySelectorAll('.toast .text')].map((t) => t.textContent.trim());
const inbox = async () => { document.querySelector('.sidebar .item.parent[aria-label^="Inbox"]')?.click(); await pause(1200); };
/** Show some other conversation, so a link's has something to change. */
const elsewhere = async () => { await inbox(); const r = rows().find((x) => !x.querySelector('.subject')?.textContent.includes(%s)); r?.click(); await pause(800); return shown(); };
''' % json.dumps(SUBJECT)
def page(body):
    r = spark.run_in_app(m, HELPERS + body)
    if isinstance(r, str) and r.startswith('ERROR'): raise RuntimeError(r)
    return r
def wait_for(test, seconds=20):
    end = time.time() + seconds
    while time.time() < end:
        v = test()
        if v: return v
        time.sleep(0.4)
    return test()

def settings_toggle():
    spark.open_settings(m, 'ai', 'Links to emails')
    try: return spark.in_settings(m, spark.SETTING_ITEM + r'''
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const links = () => item('Links to emails');
const toggle = links().querySelector('input.switch'); toggle.click();
const status = () => links().querySelector('small.status')?.textContent || null;
for (let i = 0; i < 50; i++) { await pause(100); if (!toggle.checked || (status() && status() !== 'Starting…')) break; }
return { on: toggle.checked, status: status() };''')
    finally: spark.close_settings(m)

result = {}
try:
    m.execute("for (const w of Services.wm.getEnumerator('mail:extensionPopup')) if (w.document.querySelector('browser')?.currentURI?.spec.endsWith('/app.html') && w.windowState === w.STATE_MINIMIZED) w.restore(); return 1;")
    page("await messenger.storage.local.set({ emailLinks: true }); return 1;")
    result['status'] = wait_for(lambda: page("return (await messenger.storage.local.get('mailLinkStatus')).mailLinkStatus || null;"))
    mid = page("return (await messenger.messages.query({ subject: %s })).messages.find((x) => x.author.includes('Ada'))?.headerMessageId || null;" % json.dumps(SUBJECT))
    code = link_code(mid or '')
    result['code'] = code

    # 1. A click: the page says so, and Ember shows the email.
    result['before'] = page("return await elsewhere();")
    click = ask('GET', f'/email/{code}', CLICK)
    result['click'] = {'status': click['status'], 'opening': 'Opening in Ember' in click.get('body', ''), 'csp': click.get('csp')}
    result['clickShows'] = wait_for(lambda: (lambda s: s if s and SUBJECT in s else None)(page("return shown();")))

    # 2. Nothing opens without a click.
    result['quietBefore'] = page("return await elsewhere();")
    result['head'] = ask('HEAD', f'/email/{code}')['status']
    result['rebinding'] = ask('GET', f'/email/{code}', {**CLICK, 'Host': f'attacker.example:{PORT}'})['status']
    result['image'] = ask('GET', f'/email/{code}', {'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Site': 'cross-site'})['status']
    result['frame'] = ask('GET', f'/email/{code}', {**CLICK, 'Sec-Fetch-Dest': 'iframe'})['status']
    result['post'] = ask('POST', f'/email/{code}', CLICK)['status']
    result['garbage'] = ask('GET', '/email/../../etc/passwd', CLICK)['status']
    time.sleep(2)
    result['quietAfter'] = page("return shown();")

    # 3. A link to an email that isn't there.
    gone = ask('GET', '/email/' + link_code(f'gone-{int(time.time())}@spark.test'), CLICK)
    result['gone'] = {'status': gone['status'], 'toast': wait_for(lambda: next((t for t in page("return toasts();") if "isn't in Thunderbird" in t), None), 10)}

    # 4. Copy link in the row menu (offered; never clicked: the clipboard is the user's).
    MENU = r'''await inbox(); const r = rows()[0];
if (!r) return null;
r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 })); await pause(250);
const offered = [...document.querySelectorAll('.context-menu button')].some((b) => b.textContent.trim() === 'Copy link');
document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); document.querySelector('.context-menu button')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await pause(150);
return offered;'''
    result['copyOffered'] = page(MENU)

    # 5. Settings: off closes the port and hides Copy link; on opens it again.
    result['off'] = settings_toggle()
    result['offPort'] = wait_for(lambda: ask('GET', f'/email/{code}', CLICK)['status'] is None and 'closed', 10) or 'open'
    result['offMenu'] = page(MENU)
    result['on'] = settings_toggle()
    result['onPort'] = wait_for(lambda: ask('GET', '/', CLICK)['status'], 10)
finally:
    try: page("await messenger.storage.local.set({ emailLinks: true }); return 1;")
    except Exception as error: print('reset failed:', error)
    m.execute("for (const w of Services.wm.getEnumerator('mail:extensionPopup')) w.minimize(); return true;")
    spark._end_session(m)

r = result
checks = {
    'listening_on_test_port': (r.get('status') or {}).get('url') == f'http://127.0.0.1:{PORT}',
    'click_opens_email': r['click']['status'] == 200 and r['click']['opening'] and "default-src 'none'" in (r['click']['csp'] or '') and SUBJECT not in (r['before'] or '') and SUBJECT in (r['clickShows'] or ''),
    'nothing_opens_without_a_click': r['head'] == 200 and r['rebinding'] == 403 and r['image'] == 403 and r['frame'] == 403 and r['post'] == 405 and r['garbage'] == 404
        and r['quietBefore'] and SUBJECT not in r['quietBefore'] and r['quietAfter'] == r['quietBefore'],
    'missing_email_says_so': r['gone']['status'] == 200 and bool(r['gone']['toast']),
    'copy_link_offered': r['copyOffered'] is True,
    'settings_off_and_on': (r.get('off') or {}).get('on') is False and r.get('offPort') == 'closed' and r.get('offMenu') is False
        and (r.get('on') or {}).get('on') is True and (r['on'].get('status') or '').startswith(f'Links open at http://127.0.0.1:{PORT}') and r.get('onPort') == 200,
}
result['checks'] = checks
(args.output_dir / 'mail-links.json').write_text(json.dumps(result, indent=2, ensure_ascii=False, default=str))
print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
print('ALL PASS' if all(checks.values()) else 'FAIL: ' + ', '.join(k for k, v in checks.items() if not v))
raise SystemExit(0 if all(checks.values()) else 1)
