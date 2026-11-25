#!/usr/bin/env python3
"""Right-clicks across Ember, in the isolated fixture profile only (port 2831). Synthesized events in the page.

Thunderbird's own menu (Back, Reload, Inspect…) appears only for a right-click no page handler prevented. Checks:
Ember's interface (a sidebar button that isn't a mailbox, a reader button) drops it and opens nothing; a text field keeps it (spelling,
paste); a conversation row and a combined mailbox open Ember's menus; in an email, a web link offers Open/Copy
link, an email address Write to/Copy, selected text Copy and Search mail (which searches), plain text nothing; the
Settings window drops it except in its fields. In the reader, the sender and each recipient get a
people menu (only copying for yourself; Show mail with … searches), each attachment a file menu (Save all beside
others), and a file in the Attachments view one with Show the email (which opens it); Save, Open and Copy are never run (they'd touch the real Downloads folder and clipboard). Seeds one email (deleted afterwards).

  test_right_click.py --output-dir DIR
"""
import argparse, json, time
from datetime import datetime, timezone
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import format_datetime
from pathlib import Path
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
m = spark.connect()
RUN = str(int(time.time()))
SUBJECT = f'Right-click fixture {RUN}'
e = EmailMessage(policy=SMTP)
e['From'] = 'Ana Lima <ana@clicks.example>'; e['To'] = 'Test Owner <merritt@spark.test>, Ben Ortiz <ben@clicks.example>'; e['Date'] = format_datetime(datetime.now(timezone.utc))
e['Message-ID'] = f'<rc-{RUN}@spark-rightclick.test>'; e['Subject'] = SUBJECT; e['X-Mozilla-Status'] = '0000'
e.set_content('plain')
e.add_alternative(f'<p id="plain">Quarterly numbers are ready for review.</p><p>See <a id="web" href="https://example.org/docs">the docs</a> or write to <a id="mail" href="mailto:ana@clicks.example">Ana</a>.</p>', subtype='html')
e.add_attachment(b'meeting notes', maintype='text', subtype='plain', filename='notes.txt')
e.add_attachment(bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000000200015e2a1f0a0000000049454e44ae426082'), maintype='image', subtype='png', filename='chart.png')
m.execute('''const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
MailServices.accounts.getAccount('account1').incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage(%s); return 1;''' % json.dumps(e.as_string()))

HELPERS = r'''
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms = 10000) => { for (let t = 0; t < ms; t += 100) { const v = test(); if (v) return v; await pause(100); } return test(); };
const click = (el, doc = document) => { const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40, view: doc.defaultView }); el.dispatchEvent(ev); return ev.defaultPrevented; };
const menus = () => [...document.querySelectorAll('.context-menu')].map((m) => ({ label: m.getAttribute('aria-label'), items: [...m.querySelectorAll('button')].map((b) => b.textContent.replace(/\s+/g, ' ').trim()) }));
const closeMenus = async () => { for (const m of document.querySelectorAll('.context-menu')) m.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await pause(150); };
const row = (s) => [...document.querySelectorAll('.viewport .row')].find((r) => r.querySelector('.subject')?.textContent.trim() === s);
const body = () => [...document.querySelectorAll('iframe.display')].map((f) => f.contentDocument).find((d) => d?.getElementById('web'));
'''
def page(body):
    r = spark.run_in_app(m, HELPERS + body)
    if isinstance(r, str) and r.startswith('ERROR'): raise RuntimeError(r)
    return r

result = {}
approved_was_on = False
try:
    page("setTimeout(() => location.reload(), 50); return 1;")
    time.sleep(3)
    for _ in range(60):
        try:
            if page("return !!document.querySelector('.sidebar .item');"): break
        except Exception: pass
        time.sleep(0.5)
    result['interface'] = page("""document.querySelector('.sidebar [data-mailbox="inbox"] > button.item.parent').click(); await pause(600);
const plain = [...document.querySelectorAll('.sidebar button')].find((b) => !b.closest('.mailbox-group') && b.offsetParent);
const prevented = click(plain); await pause(150);
return { prevented, menus: menus(), item: plain?.getAttribute('aria-label') || plain?.textContent.trim() };""")
    result['field'] = page("""window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })); await pause(300);
const input = document.querySelector('.search input'); const prevented = input ? click(input) : null;
input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await pause(200);
return { found: !!input, prevented };""")
    result['row'] = page("""const r = await until(() => row(%s)); const prevented = click(r); await pause(200); const out = { prevented, menus: menus() }; await closeMenus(); return out;""" % json.dumps(SUBJECT))
    result['mailbox'] = page("""const prevented = click(document.querySelector('.sidebar [data-mailbox="inbox"] > button.item.parent')); await pause(200); const out = { prevented, menus: menus() }; await closeMenus(); return out;""")
    result['reader_button'] = page("""row(%s).click(); await until(() => body(), 15000); await pause(500);
const button = document.querySelector('.reader button[aria-label="Archive"]'); const prevented = click(button); await pause(150);
return { prevented, menus: menus() };""" % json.dumps(SUBJECT))
    result['email'] = page("""const d = await until(() => body(), 15000); const out = {};
const at = async (id) => { const prevented = click(d.getElementById(id), d); await pause(200); const m = menus(); await closeMenus(); return { prevented, menus: m }; };
out.web = await at('web'); out.mail = await at('mail');
d.getSelection().removeAllRanges(); out.plain = await at('plain');
const range = d.createRange(); range.selectNodeContents(d.getElementById('plain').firstChild); range.setStart(d.getElementById('plain').firstChild, 0); range.setEnd(d.getElementById('plain').firstChild, 17);
d.getSelection().removeAllRanges(); d.getSelection().addRange(range);
out.selectionPrevented = click(d.getElementById('plain'), d); await pause(200); out.selection = menus();
[...document.querySelectorAll('.context-menu button')].find((b) => b.textContent.includes('Search mail'))?.click();
await pause(1500); out.searched = document.querySelector('.search input')?.value || null; out.view = document.querySelector('.viewport')?.getAttribute('aria-label') || null;
return out;""")
    result['people'] = page("""const subject = %s;
if (!document.querySelector('.msg.expanded .att')) { document.querySelector('.sidebar [data-mailbox="inbox"] > button.item.parent').click(); const r = await until(() => row(subject), 15000); r.click(); }
const msg = await until(() => [...document.querySelectorAll('.msg.expanded')].find((m) => m.querySelector('.att')), 15000);
const at = async (el) => { const prevented = click(el); await pause(200); const m = menus(); await closeMenus(); return { prevented, menus: m }; };
const out = {};
out.sender = await at(msg.querySelector('.head .name'));
const people = [...msg.querySelectorAll('.to .person')];
out.toNames = people.map((p) => p.textContent);
out.me = await at(people.find((p) => p.textContent === 'me'));
out.ben = await at(people.find((p) => p.textContent === 'Ben Ortiz'));
const atts = [...msg.querySelectorAll('.att')];
out.txt = await at(atts.find((a) => a.textContent.includes('notes.txt')));
out.png = await at(atts.find((a) => a.textContent.includes('chart.png')));
out.dateBlank = await at(msg.querySelector('.head .when'));
click(people.find((p) => p.textContent === 'Ben Ortiz')); await pause(200);
[...document.querySelectorAll('.context-menu button')].find((b) => b.textContent.startsWith('Show mail with'))?.click();
await pause(1500); out.searched = document.querySelector('.search input')?.value || null;
return out;""" % json.dumps(SUBJECT))
    result['library'] = page("""[...document.querySelectorAll('.sidebar button')].find((b) => !b.closest('.mailbox-group') && b.textContent.includes('Attachments')).click();
const tab = await until(() => document.querySelector('.library-tabs [role=tab]')); if (tab.getAttribute('aria-selected') !== 'true') { tab.click(); await pause(300); }
// Files from every sender for this check (the fixture approves none); switched back at the end.
const only = document.querySelector('label.approved input[type=checkbox]');
const wasOn = !!only?.checked; if (wasOn) { only.click(); await pause(300); }
return wasOn;""")
    approved_was_on = result['library']
    for _ in range(90):  # the scan for files can take a while on the fixture mailbox
        if page("return !!document.querySelector('.files .file');"): break
        time.sleep(1)
    result['library'] = page("""const file = document.querySelector('.files .file'); if (!file) return { found: false, summary: document.querySelector('.library .summary')?.textContent.trim() };
const name = file.querySelector('.filename')?.textContent.trim();
const prevented = click(file); await pause(200); const m = menus();
[...document.querySelectorAll('.context-menu button')].find((b) => b.textContent.includes('Show the email'))?.click(); await pause(800);
await closeMenus();
return { found: true, name, prevented, items: m[0]?.items || [], readerOpen: !!document.querySelector('.reader .msg') };""")
    page("await messenger.runtime.sendMessage({ type: 'spark:settings', section: 'general' }); return 1;")
    for _ in range(60):
        try:
            if spark.in_settings(m, "return !!document.querySelector('input[type=search]') && !!document.querySelector('.card .item');"): break
        except RuntimeError: pass
        time.sleep(0.3)
    result['settings'] = spark.in_settings(m, """
const click = (el) => { const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); el.dispatchEvent(ev); return ev.defaultPrevented; };
const nav = document.querySelector('.card .item b') || document.querySelector('button'); const input = document.querySelector('input[type=search]');
return { nav: nav ? click(nav) : null, field: input ? click(input) : null };""")
    spark.close_settings(m)
finally:
    try:
        if approved_was_on: page("const only = document.querySelector('label.approved input[type=checkbox]'); if (only && !only.checked) { only.click(); await pause(300); } return !!only?.checked;")
    except Exception as error: print('could not switch Approved domains only back on:', error)
    try:
        page("document.querySelector('.search input') && (document.querySelector('.search input').value = ''); document.querySelector('.sidebar [data-mailbox=\"inbox\"] > button.item.parent')?.click(); return 1;")
    except Exception: pass
    m.execute('''const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
for (const f of MailServices.accounts.allFolders) { let hs = []; try { hs = [...f.msgDatabase.enumerateMessages()].filter((h) => h.messageId.endsWith('@spark-rightclick.test')); } catch {} if (hs.length) f.deleteMessages(hs, null, true, false, null, false); }
return 1;''')
    spark._end_session(m)

r = result
E = r.get('email', {})
P = r.get('people', {})
checks = {
    'interface_no_menu': r['interface']['prevented'] is True and r['interface']['menus'] == [] and bool(r['interface'].get('item')) and r['reader_button'] == {'prevented': True, 'menus': []},
    'field_keeps_text_menu': r['field'] == {'found': True, 'prevented': False},
    'row_spark_menu': r['row']['prevented'] and any(x['label'] == 'Conversation actions' for x in r['row']['menus']),
    'mailbox_spark_menu': r['mailbox']['prevented'] and any(x['label'] == 'Show in Inbox' for x in r['mailbox']['menus']),
    'email_link': E.get('web') == {'prevented': True, 'menus': [{'label': 'Email actions', 'items': ['Open link', 'Copy link']}]},
    'email_address': E.get('mail') == {'prevented': True, 'menus': [{'label': 'Email actions', 'items': ['Write to ana@clicks.example', 'Copy email address']}]},
    'email_plain_nothing': E.get('plain') == {'prevented': True, 'menus': []},
    'email_selection_search': E.get('selectionPrevented') is True and E.get('selection') == [{'label': 'Email actions', 'items': ['Copy', 'Search mail for “Quarterly numbers”']}] and E.get('searched') == 'Quarterly numbers',
    'settings': r.get('settings') == {'nav': True, 'field': False},
    'person_sender': P.get('sender') == {'prevented': True, 'menus': [{'label': 'Actions for ana@clicks.example', 'items': ['Write to Ana', 'Copy email address', 'Copy name and address', 'Show mail with Ana']}]},
    'person_me_copy_only': P.get('me') == {'prevented': True, 'menus': [{'label': 'Actions for merritt@spark.test', 'items': ['Copy email address', 'Copy name and address']}]},
    'person_recipient_search': (P.get('ben') or {}).get('menus', [{}])[0].get('items') == ['Write to Ben', 'Copy email address', 'Copy name and address', 'Show mail with Ben'] and P.get('searched') == 'ben@clicks.example',
    'attachment_menus': P.get('txt') == {'prevented': True, 'menus': [{'label': 'Actions for notes.txt', 'items': ['Open', 'Save…', 'Save all 2 to Downloads', 'Copy file name']}]}
        and P.get('png') == {'prevented': True, 'menus': [{'label': 'Actions for chart.png', 'items': ['Quick Look', 'Open', 'Save…', 'Save all 2 to Downloads', 'Copy file name']}]},
    'library_file_menu': (r.get('library') or {}).get('prevented') is True and (r.get('library') or {}).get('items', [])[-4:] == ['Open', 'Save…', 'Copy file name', 'Show the email'] and r['library'].get('readerOpen') is True,
    'header_elsewhere_nothing': P.get('dateBlank') == {'prevented': True, 'menus': []},
}
result['checks'] = checks
(args.output_dir / 'right-click.json').write_text(json.dumps(result, indent=2, ensure_ascii=False))
print(json.dumps(result, indent=2, ensure_ascii=False))
print('ALL PASS' if all(checks.values()) else 'FAIL: ' + ', '.join(k for k, v in checks.items() if not v))
raise SystemExit(0 if all(checks.values()) else 1)
