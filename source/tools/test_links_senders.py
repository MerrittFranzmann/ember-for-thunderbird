#!/usr/bin/env python3
"""Attachments → Links and Senders you ignore in the real Ember, isolated fixture profile only (port 2831).
Fixture mail is added to the "Work (test)" Inbox locally; nothing is fetched or sent. One-click unsubscribes go
to a list server on 127.0.0.1 run by this script; the email unsubscribe only opens the composer (discarded).

Links:
  1. Ada (northwind.test, approved) shares a Dropbox file and a Frame.io review; her reply quotes an earlier
     email whose Frame.io link must stay credited to that email only. A newsletter (not approved) has a
     YouTube link. With approved domains only: Ada's three links; without: the YouTube one too; the service
     filter narrows to YouTube.
Senders you ignore:
  2. "Deals" (7 unread, one-click unsubscribe) and "Digest" (6 unread, unsubscribe by email) are listed; Ada
     (2 emails) and "Read Weekly" (6 emails, all read) are not.
  3. Unsubscribe & archive on Deals: the list server gets "List-Unsubscribe=One-Click", Deals' emails leave the
     Inbox, and Deals moves to "Unsubscribed · nothing since". Undo brings the emails back.
  4. Unsubscribe on Digest opens the composer to its address with its subject (then discarded).
  5. Keep / Put back on a sender.

  test_links_senders.py --output-dir DIR
"""
import argparse, json, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
m = spark.connect()
RUN = int(time.time())
DEALS, DIGEST = 'deals%d@shop.test' % RUN, 'digest%d@list.test' % RUN
posts = []


class ListServer(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length') or 0)).decode()
        posts.append({'path': self.path, 'body': body, 'type': self.headers.get('Content-Type')})
        self.send_response(200); self.end_headers(); self.wfile.write(b'ok')
    def log_message(self, *a): pass


server = HTTPServer(('127.0.0.1', 0), ListServer)
threading.Thread(target=server.serve_forever, daemon=True).start()
UNSUB = 'http://127.0.0.1:%d/unsub?u=deals' % server.server_port


def add(lines):
    m.execute("""const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const f=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder);
f.addMessage(%s.join('\\r\\n')); return 1;""" % json.dumps(lines))


def mail(author, subject, body, minutes, html=False, extra=(), read=False, mid=None):
    date = time.strftime('%a, %d %b %Y %H:%M:%S +0000', time.gmtime(time.time() - minutes * 60))
    add(['From: ' + author, 'To: merritt@spark.test', 'Subject: ' + subject, 'Date: ' + date,
         'Message-ID: <%s@links.test>' % (mid or 'l-%d-%s-%d' % (RUN, subject.replace(' ', ''), minutes)), 'MIME-Version: 1.0',
         'Content-Type: %s; charset=utf-8' % ('text/html' if html else 'text/plain'), 'X-Mozilla-Status: %s' % ('0001' if read else '0000'), *extra, '', body, ''])


ADA = 'Ada Lovelace <ada@northwind.test>'
mail(ADA, 'Rough cut %d' % RUN, '<p>First pass: <a href="https://f.io/OldCut%d">rough cut review</a></p>' % RUN, 600, html=True, mid='ada1-%d' % RUN)
mail(ADA, 'Re: Rough cut %d' % RUN, ('<p>New version: <a href="https://www.dropbox.com/scl/fi/abc%d/Final%%20cut%%20v3.mov?dl=0">here</a> and the '
     '<a href="https://nam12.safelinks.protection.outlook.com/?url=https%%3A%%2F%%2Ff.io%%2FNewCut%d&amp;data=x">Frame.io review</a>.</p>'
     '<div class="gmail_quote">On Monday Ada wrote:<blockquote><a href="https://f.io/OldCut%d">rough cut review</a></blockquote></div>') % (RUN, RUN, RUN), 300, html=True,
     extra=['In-Reply-To: <ada1-%d@links.test>' % RUN])
mail('Video Weekly <news@videoweekly.test>', 'This week in video %d' % RUN, 'Watch: https://www.youtube.com/watch?v=vid%d' % RUN, 200)
for i in range(7):
    mail('Deals <%s>' % DEALS, 'Deal %d of the day %d' % (i, RUN), 'Big sale.', 100 + i, extra=['List-Unsubscribe: <%s>, <mailto:leave@shop.test>' % UNSUB, 'List-Unsubscribe-Post: List-Unsubscribe=One-Click', 'List-Id: deals.shop.test'])
for i in range(6):
    mail('Digest <%s>' % DIGEST, 'Digest %d %d' % (i, RUN), 'Today on the list.', 150 + i, extra=['List-Unsubscribe: <mailto:digest-unsub@list.test?subject=unsubscribe>', 'Precedence: list'])
for i in range(6):
    mail('Read Weekly <weekly@read.test>', 'Weekly %d %d' % (i, RUN), 'Read me.', 160 + i, read=True, extra=['List-Id: weekly.read.test'])

HELP = r"""const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, label, ms = 30000) => { const t = Date.now(); let v; while (!(v = await fn())) { if (Date.now() - t > ms) throw new Error('Timed out: ' + label); await pause(100); } return v; };
const byText = (sel, text) => [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(text));
const linkRows = () => [...document.querySelectorAll('.link-row')].map((r) => ({ title: r.querySelector('.filename').textContent.trim(), href: r.querySelector('.filename').href, sender: r.querySelector('.sender').textContent.replace(/\s+/g, ' ').trim() }));
const senderRows = () => [...document.querySelectorAll('.senders > .scroll > .list .sender')].map((r) => ({ name: r.querySelector('.name').textContent.replace(/\s+/g, ' ').trim(), stats: r.querySelector('.stats').textContent.replace(/\s+/g, ' ').trim(), buttons: [...r.querySelectorAll('button.pill')].map((b) => b.textContent.trim()) }));
const row = (address) => [...document.querySelectorAll('.senders > .scroll > .list .sender')].find((r) => r.querySelector('.name').textContent.includes(address));
const mine = (rows) => rows.filter((r) => r.href.includes('%d'));
const DEALS_JS = '%s', DIGEST_JS = '%s';
""" % (RUN, DEALS, DIGEST)


def app(js, seconds=90):
    start = ("const root = document.documentElement; root.removeAttribute('data-test-result');"
             "(async () => { %s %s })().then((v) => root.setAttribute('data-test-result', JSON.stringify({ ok: true, v: v === undefined ? null : v })),"
             "(e) => root.setAttribute('data-test-result', JSON.stringify({ ok: false, e: String(e) }))); return true;") % (HELP, js)
    spark.run_in_app(m, start)
    end = time.time() + seconds
    while time.time() < end:
        r = spark.run_in_app(m, "return document.documentElement.getAttribute('data-test-result');")
        if r:
            r = json.loads(r)
            if not r['ok']: raise RuntimeError(r['e'])
            return r['v']
        time.sleep(0.3)
    raise TimeoutError('step')


def inbox_count(address):
    return m.execute("""const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const f=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox');
let n=0; for (const h of f.messages) if (h.author.includes(%s)) n++; return n;""" % json.dumps(address))


KEYS = ['approvedAttachmentDomains', 'attachmentApprovedOnly', 'attachmentTab', 'linkService', 'linkGroupBy', 'keptSenders', 'unsubscribedSenders']
before = spark.run_in_app(m, "return await messenger.storage.local.get(%s);" % json.dumps(KEYS))
result = {}
try:
    spark.run_in_app(m, "await messenger.storage.local.set({ approvedAttachmentDomains: ['northwind.test'], attachmentApprovedOnly: true, attachmentTab: 'files', linkService: 'all', linkGroupBy: 'none', keptSenders: [], unsubscribedSenders: {} }); return true;")
    time.sleep(1)
    # 1. Links (the background saves the new emails' bodies first: Refresh until they're in).
    r = app("""byText('.sidebar .item', 'Attachments').click();
const tab = await wait(() => byText('.library-tabs button', 'Links'), 'Links tab'); tab.click();
await wait(() => document.querySelector('.library[aria-label="Received links"]'), 'links page');
await wait(async () => { if (mine(linkRows()).length >= 3) return true; document.querySelector('.list-head button[aria-label="Refresh"]').click(); await pause(1500); return false; }, 'links found', 60000);
const approved = mine(linkRows());
document.querySelector('.library .approved input').click(); await pause(400);
const all = mine(linkRows());
const select = document.querySelector('select[aria-label="Link service"]'); select.value = 'YouTube'; select.dispatchEvent(new Event('change', { bubbles: true })); await pause(400);
const youtube = mine(linkRows()).map((r) => r.title);
select.value = 'all'; select.dispatchEvent(new Event('change', { bubbles: true }));
document.querySelector('.library .approved input').click(); await pause(200);
return { approved, all: all.map((r) => r.title), youtube, setting: (await messenger.storage.local.get('attachmentTab')).attachmentTab };""")
    titles = [x['title'] for x in r['approved']]
    assert titles == ['Final cut v3.mov', 'Frame.io review', 'rough cut review'], r
    old = next(x for x in r['approved'] if x['title'] == 'rough cut review')
    assert 'in 2 emails' not in old['sender'] and old['href'].startswith('https://f.io/OldCut'), old
    assert next(x for x in r['approved'] if x['title'] == 'Frame.io review')['href'].startswith('https://f.io/NewCut'), r
    assert 'YouTube video' in r['all'] and len(r['all']) == 4 and r['youtube'] == ['YouTube video'] and r['setting'] == 'links', r
    result['links'] = r
    spark.app_shot(m, str(args.output_dir / 'links.png'))

    # 2. Senders you ignore.
    r = app("""const more = document.querySelector('.sidebar .item.more'); if (more.getAttribute('aria-expanded') !== 'true') more.click();
(await wait(() => byText('.sidebar .item', 'Senders you ignore'), 'sidebar item')).click();
await wait(() => row(DEALS_JS) && row(DIGEST_JS), 'senders listed', 30000);
return { title: document.querySelector('.list-head h1').textContent, rows: senderRows() };""")
    names = [x['name'] for x in r['rows']]
    assert r['title'] == 'Senders you ignore' and not any('ada@northwind.test' in n or 'weekly@read.test' in n for n in names), r
    deals = next(x for x in r['rows'] if DEALS in x['name'])
    assert deals['stats'].startswith('7 emails · never opened') and 'Unsubscribe & archive' in deals['buttons'], deals
    result['senders'] = r['rows']
    spark.app_shot(m, str(args.output_dir / 'senders.png'))

    # 3. Unsubscribe & archive, then Undo.
    assert inbox_count(DEALS) == 7
    r = app("""const button = [...row(DEALS_JS).querySelectorAll('button.pill')].find((b) => b.textContent.includes('Unsubscribe & archive')); button.click();
const toast = await wait(() => byText('.toast .text', 'Archived 7 emails from Deals'), 'archive toast');
await wait(() => byText('.extra .sender', DEALS_JS), 'moved to Unsubscribed');
return { toast: toast.textContent, unsubscribed: byText('.extra .sender', DEALS_JS).textContent.replace(/\\s+/g, ' ').trim(), stillListed: !!row(DEALS_JS) };""")
    end = time.time() + 15
    while time.time() < end and inbox_count(DEALS): time.sleep(0.3)
    assert posts and posts[0]['body'] == 'List-Unsubscribe=One-Click' and posts[0]['path'] == '/unsub?u=deals', posts
    assert inbox_count(DEALS) == 0 and 'nothing since' in r['unsubscribed'] and 'in Inbox' not in r['unsubscribed'] and not r['stillListed'], r
    result['unsubscribe'] = {**r, 'post': posts[0]}
    app("""byText('.toast', 'Archived 7 emails').querySelector('button.act').click(); return true;""")
    end = time.time() + 20
    while time.time() < end and inbox_count(DEALS) < 7: time.sleep(0.3)
    result['undo'] = inbox_count(DEALS)
    assert result['undo'] == 7, result['undo']

    # 4. Unsubscribe by email: the composer, addressed and titled (then discarded).
    r = app("""[...row(DIGEST_JS).querySelectorAll('button.pill')].find((b) => b.textContent.trim() === 'Unsubscribe').click();
await wait(() => document.querySelector('.sheet #c-subj'), 'composer');
const out = { to: [...document.querySelectorAll('.sheet .chip')].map((c) => c.title), subject: document.querySelector('.sheet #c-subj').value };
document.querySelector('.sheet .head button[aria-label="Discard"]').click(); await pause(300);
const c = document.querySelector('.sheet .confirm'); if (c) [...c.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Discard').click();
await wait(() => !document.querySelector('.sheet'), 'composer closed');
return { ...out, unsubscribed: !!byText('.extra .sender', DIGEST_JS) };""")
    assert r['to'] == ['digest-unsub@list.test'] and r['subject'] == 'unsubscribe' and r['unsubscribed'], r
    result['email_unsubscribe'] = r

    # 5. Keep and put back (Forget the Deals unsubscribe first: it's listed again).
    r = app("""byText('.extra .sender', DEALS_JS).querySelector('button.pill:last-child').click();
await wait(() => row(DEALS_JS), 'deals back on the list');
row(DEALS_JS).querySelector('button[aria-label^="Keep"]').click();
await wait(() => !row(DEALS_JS), 'kept');
byText('.extra-head', 'Kept').click();
const kept = await wait(() => byText('.extra .sender', DEALS_JS), 'kept listed');
kept.querySelector('button').click();
await wait(() => row(DEALS_JS), 'put back');
return (await messenger.storage.local.get('keptSenders')).keptSenders;""")
    assert r == [], r
    result['keep'] = 'ok'
    print(json.dumps(result, indent=2))
finally:
    spark.run_in_app(m, "await messenger.storage.local.set(%s); return true;" % json.dumps({k: before.get(k, v) for k, v in {'approvedAttachmentDomains': [], 'attachmentApprovedOnly': True, 'attachmentTab': 'files', 'linkService': 'all', 'linkGroupBy': 'none', 'keptSenders': [], 'unsubscribedSenders': {}}.items()}))
    server.shutdown()
(args.output_dir / 'links-senders.json').write_text(json.dumps(result, indent=2) + '\n')
print('PASS')
