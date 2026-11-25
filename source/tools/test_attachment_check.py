#!/usr/bin/env python3
"""Attachment check in "Before you send", isolated fixture profile only (port 2831). Nothing is sent: the
email is checked (Send shows "Before you send") and then discarded.

A fixture email with budget-v3.xlsx is added to the "Work (test)" Inbox. Replying to it:
  1. "I've attached the spreadsheet." with no file: "You mention a spreadsheet, but nothing is attached."
  2. budget.pdf attached: "You mention a spreadsheet, but none is attached."
  3. budget-v2.xlsx instead: "looks older than budget-v3.xlsx", and "Use budget-v3.xlsx" swaps in the
     conversation's file; the panel then has nothing left to say.

  test_attachment_check.py --output-dir DIR
"""
import argparse, json, time
from pathlib import Path
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
m = spark.connect()
SUBJECT = 'Attachment check fixture %d' % time.time()

m.execute("""const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const f=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder);
const b='spark-boundary-'+Date.now();
f.addMessage(['From: Ada Lovelace <ada@analytical.test>','To: merritt@spark.test','Subject: %s','Date: '+new Date().toUTCString(),'Message-ID: <attach-'+Date.now()+'@spark.test>','MIME-Version: 1.0','Content-Type: multipart/mixed; boundary="'+b+'"','X-Mozilla-Status: 0001','',
'--'+b,'Content-Type: text/plain; charset=utf-8','','Here is the latest budget.','',
'--'+b,'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet; name="budget-v3.xlsx"','Content-Disposition: attachment; filename="budget-v3.xlsx"','Content-Transfer-Encoding: base64','',btoa('PK fake spreadsheet v3'),'',
'--'+b+'--',''].join('\\r\\n')); return 1;""" % SUBJECT)

HELP = r"""const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, label, ms = 20000) => { const t = Date.now(); let v; while (!(v = await fn())) { if (Date.now() - t > ms) throw new Error('Timed out: ' + label); await pause(80); } return v; };
const review = () => [...document.querySelectorAll('.sheet .review li')].map((li) => ({ kind: li.classList[0], text: li.querySelector('b')?.textContent.trim(), detail: li.querySelector('small')?.textContent.trim() || '', fix: li.querySelector('button')?.textContent.trim() || '' }));
const drop = (name, type) => { const dt = new DataTransfer(); dt.items.add(new File(['x'], name, { type })); document.querySelector('.sheet').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); };
const send = async () => { document.querySelector('.sheet .send').click(); await pause(300); return wait(() => !document.querySelector('.sheet .send')?.textContent.includes('Checking') && document.querySelector('.sheet .review') && review(), 'review'); };
"""


def app(js):
    start = ("const root = document.documentElement; root.removeAttribute('data-test-result');"
             "(async () => { %s %s })().then((v) => root.setAttribute('data-test-result', JSON.stringify({ ok: true, v: v === undefined ? null : v })),"
             "(e) => root.setAttribute('data-test-result', JSON.stringify({ ok: false, e: String(e) }))); return true;") % (HELP, js)
    spark.run_in_app(m, start)
    end = time.time() + 60
    while time.time() < end:
        r = spark.run_in_app(m, "return document.documentElement.getAttribute('data-test-result');")
        if r:
            r = json.loads(r)
            if not r['ok']: raise RuntimeError(r['e'])
            return r['v']
        time.sleep(0.3)
    raise TimeoutError('step')


result = {}
try:
    app(r"""
document.querySelector('.sidebar .item')?.click(); await pause(800);
const row = await wait(() => [...document.querySelectorAll('.row')].find((r) => r.querySelector('.subject')?.textContent === %s), 'fixture in the inbox', 30000);
row.click();
await wait(() => document.querySelector('.reader .reply-bar button[data-action="reply"]'), 'conversation');
[...document.querySelectorAll('.reader .reply-bar button[data-action="reply"]')].pop().click();
const editor = await wait(() => document.querySelector('.sheet [contenteditable=true]'), 'composer');
await pause(300);
editor.insertAdjacentHTML('afterbegin', "<div>I've attached the spreadsheet with my changes.</div>"); editor.dispatchEvent(new Event('input', { bubbles: true }));
return true;""" % json.dumps(SUBJECT))
    r = app("return await send();")
    assert r[0]['kind'] == 'attachMissing' and r[0]['text'] == 'You mention a spreadsheet, but nothing is attached.' and r[0]['fix'] == 'Attach a file', r
    result['missing'] = r[0]
    r = app("drop('budget.pdf', 'application/pdf'); return await wait(() => review().find((w) => w.kind === 'attachKind') && review(), 'kind warning');")
    w = next(x for x in r if x['kind'] == 'attachKind')
    assert w['text'] == 'You mention a spreadsheet, but none is attached.' and 'budget.pdf' in w['detail'], r
    result['kind'] = w
    r = app("""document.querySelector('.sheet .files .x').click(); await pause(100); drop('budget-v2.xlsx', 'application/vnd.ms-excel');
return await wait(() => review().find((w) => w.kind === 'olderVersion') && review(), 'older version');""")
    w = next(x for x in r if x['kind'] == 'olderVersion')
    assert w['text'] == 'budget-v2.xlsx looks older than budget-v3.xlsx in this conversation.' and w['fix'] == 'Use budget-v3.xlsx' and w['detail'].startswith('Ada Lovelace sent budget-v3.xlsx'), r
    assert not any(x['kind'].startswith('attach') for x in r), r
    result['older'] = w
    r = app("""[...document.querySelectorAll('.sheet .review li')].find((li) => li.classList.contains('olderVersion')).querySelector('button').click();
await wait(() => !review().some((w) => w.kind === 'olderVersion'), 'swapped');
const files = [...document.querySelectorAll('.sheet .files .fname')].map((f) => f.textContent);
return { files, review: review(), open: !!document.querySelector('.sheet .review') };""")
    assert r['files'] == ['budget-v3.xlsx'] and not any(x['kind'] in ('attachMissing', 'attachKind', 'olderVersion') for x in r['review']), r
    result['swapped'] = r
    print(json.dumps(result, indent=2))
    print('PASS')
finally:
    try:
        app("""const sheet = document.querySelector('.sheet'); if (!sheet) return true;
sheet.querySelector('.head button[aria-label="Discard"]').click(); const c = await wait(() => document.querySelector('.sheet .confirm'), 'confirm');
[...c.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Discard').click(); await wait(() => !document.querySelector('.sheet'), 'closed'); return true;""")
    except Exception as e: print('cleanup:', e)
(args.output_dir / 'attachment-check.json').write_text(json.dumps(result, indent=2) + '\n')
