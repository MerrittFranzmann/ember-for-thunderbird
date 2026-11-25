#!/usr/bin/env python3
"""Undo send and Send later in the real Ember, isolated fixture profile only (port 2831), through a local SMTP
sink (127.0.0.1): nothing reaches a real server, and the recipient is at a reserved test domain.

  1. Undo send (set to 10 s): Send puts the email in the outbox strip; nothing goes out; Undo brings it back
     into the composer as written; sending again delivers it after the delay, and the strip empties.
  2. ⌘Z right after Send takes the email back too; discarding it then sends nothing.
  3. Send later (a reply, "Tomorrow morning" from the clock menu): waits in the outbox; Send now delivers it
     through Thunderbird's minimized composer, threaded (References the original).
  4. Ember closed: an email still waiting goes out from the background, then Ember reopens.

  test_outbox.py --output-dir DIR
"""
import argparse, email, json, socketserver, threading, time, queue
from pathlib import Path
import spark

# The loopback SMTP sink of test_send_flow.py.
class Sink(socketserver.StreamRequestHandler):
    def handle(self):
        self.wfile.write(b'220 localhost Ember test SMTP\r\n')
        while True:
            line=self.rfile.readline()
            if not line:return
            command=line.decode(errors='replace').split(' ',1)[0].strip().upper()
            if command in ('EHLO','HELO'):self.wfile.write(b'250-localhost\r\n250 SIZE 10485760\r\n')
            elif command in ('MAIL','RCPT','RSET','NOOP'):self.wfile.write(b'250 OK\r\n')
            elif command=='DATA':
                self.wfile.write(b'354 End with dot\r\n');chunks=[]
                while True:
                    part=self.rfile.readline()
                    if part in (b'.\r\n',b''):break
                    chunks.append(part[1:] if part.startswith(b'..') else part)
                self.server.messages.put(b''.join(chunks));time.sleep(.4);self.wfile.write(b'250 Accepted\r\n')
            elif command=='QUIT':self.wfile.write(b'221 Bye\r\n');return
            else:self.wfile.write(b'250 OK\r\n')

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
ID = 'thunderbird-spark@merrittfranzmann'

server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Sink)
server.daemon_threads = True
server.messages = queue.Queue()
threading.Thread(target=server.serve_forever, daemon=True).start()
m = spark.connect()

HELPERS = r"""
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, label, ms = 20000) => { const t = Date.now(); let v; while (!(v = await fn())) { if (Date.now() - t > ms) throw new Error('Timed out: ' + label); await pause(60); } return v; };
const strip = () => [...document.querySelectorAll('.outbox li')].map((li) => ({ subject: li.querySelector('.subj')?.textContent, meta: li.querySelector('.meta')?.textContent, buttons: [...li.querySelectorAll('button')].map((b) => b.textContent.trim()) }));
const stripButton = (subject, label) => [...document.querySelectorAll('.outbox li')].find((li) => li.querySelector('.subj')?.textContent === subject)?.querySelectorAll('button') && [...[...document.querySelectorAll('.outbox li')].find((li) => li.querySelector('.subj')?.textContent === subject).querySelectorAll('button')].find((b) => b.textContent.trim() === label);
const compose = async (identity, subjectText, body, to = true) => {
  const sheet = await wait(() => document.querySelector('.sheet'), 'composer');
  const from = sheet.querySelector('#c-from'); if (from) { from.click(); await pause(50); sheet.querySelector(`[data-identity="${identity}"]`).click(); await pause(80); }
  if (to) { const input = sheet.querySelector('#c-to'); input.value = 'recipient@spark.test'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); }
  if (subjectText) { const subject = sheet.querySelector('#c-subj'); subject.value = subjectText; subject.dispatchEvent(new Event('input', { bubbles: true })); }
  const editor = sheet.querySelector('[contenteditable=true]'); editor.innerHTML = body; editor.dispatchEvent(new Event('input', { bubbles: true }));
  await pause(150);
};
const newMail = async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true })); };
const toInbox = async () => { document.querySelector('.sidebar .item')?.click(); await pause(400); };
"""


def run(js, timeout=90):
    start = ("const root = document.documentElement; root.removeAttribute('data-test-result');"
             "(async () => { %s %s })().then((v) => root.setAttribute('data-test-result', JSON.stringify({ ok: true, v: v === undefined ? null : v })),"
             "(e) => root.setAttribute('data-test-result', JSON.stringify({ ok: false, e: String(e) + ' ' + (e && e.stack) }))); return true;") % (HELPERS, js)
    started = spark.run_in_app(m, start)
    if started is not True: raise RuntimeError('page step did not start: %s' % started)
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = spark.run_in_app(m, "return document.documentElement.getAttribute('data-test-result');")
        if r:
            r = json.loads(r)
            if not r['ok']: raise RuntimeError(r['e'])
            return r['v']
        time.sleep(0.4)
    raise TimeoutError('page step timed out')


def received(timeout):
    try: return email.message_from_bytes(server.messages.get(timeout=timeout))
    except queue.Empty: return None


def nothing_sent(seconds):
    mail = received(seconds)
    assert mail is None, 'sent too early: %s' % (mail and mail['Subject'])


def open_spark():
    # Ember in its own window (Ember-only mode) counts: a second copy in a tab would be closed by Ember mid-step.
    m.execute("const url=WebExtensionPolicy.getByID('%s').getURL('app.html');for(const w of Services.wm.getEnumerator(null))for(const b of w.document.querySelectorAll('browser'))if(b.currentURI&&b.currentURI.spec===url)return true;const tm=document.getElementById('tabmail');tm&&tm.openTab('contentTab',{url});return true;" % ID)
    for _ in range(80):
        try:
            if spark.run_in_app(m, "return !!document.querySelector('.sidebar .item') && !document.querySelector('.mini-spin');") is True: return
        except Exception: pass
        time.sleep(0.5)
    raise RuntimeError('Ember did not open')


config = m.execute('''const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');const smtp=MailServices.outgoingServer.createServer("smtp").QueryInterface(Ci.nsISmtpServer);smtp.hostname='127.0.0.1';smtp.port=%d;smtp.authMethod=Ci.nsMsgAuthMethod.none;smtp.socketType=Ci.nsMsgSocketType.plain;smtp.description='Ember local SMTP test';const identity=MailServices.accounts.createIdentity();identity.email='sender@spark.test';identity.fullName='Ember Loopback';identity.smtpServerKey=smtp.key;identity.doFcc=false;identity.composeHtml=true;const account=MailServices.accounts.getAccount('account2');account.addIdentity(identity);window.__sparkSendFixture={identity:identity.key,smtp:smtp.key,account:account.key,windows:[]};const observer={onOpenWindow(win){const w=win.docShell.domWindow;w.addEventListener('load',()=>window.__sparkSendFixture.windows.push({url:w.document.documentURI,type:w.document.documentElement.getAttribute('windowtype'),state:w.windowState}),{once:true});},onCloseWindow(){}};window.__sparkSendFixture.observer=observer;Services.wm.addListener(observer);return {identity:identity.key,smtp:smtp.key};''' % server.server_address[1])
identity = json.dumps(config['identity'])
results = {}
try:
    spark.chrome_async(m, "const {ExtensionPermissions}=ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');await ExtensionPermissions.add('%s',{permissions:['messages.send'],origins:[]});const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');await (await AddonManager.getAddonByID('%s')).reload();return true;" % (ID, ID))
    time.sleep(4)
    open_spark()
    run("await messenger.storage.local.set({ undoSend: 10 }); await pause(300); return true;")

    # 1. Undo send, then send for real.
    r = run(r"""
await toInbox(); await newMail(); await compose(%s, 'Outbox undo test', '<p>Outbox body one.</p>');
document.querySelector('.sheet .send').click();
await wait(() => !document.querySelector('.sheet'), 'composer closed');
const queued = await wait(() => strip().find((x) => x.subject === 'Outbox undo test'), 'outbox strip');
const toast = [...document.querySelectorAll('.toast .text')].map((t) => t.textContent);
return { queued, toast };""" % identity)
    assert r['queued']['meta'].startswith('To recipient') and 'Sending in 0:' in r['queued']['meta'] and r['queued']['buttons'] == ['Undo', 'Send now'], r
    assert any(t.startswith('Sending in 10 s') for t in r['toast']), r
    nothing_sent(4)
    r = run(r"""
stripButton('Outbox undo test', 'Undo').click();
const sheet = await wait(() => document.querySelector('.sheet'), 'composer back');
await pause(200);
return { subject: sheet.querySelector('#c-subj').value, body: sheet.querySelector('[contenteditable=true]').innerHTML, to: sheet.querySelector('.chip-name')?.textContent, strip: strip() };""")
    assert r['subject'] == 'Outbox undo test' and 'Outbox body one.' in r['body'] and r['strip'] == [], r
    results['undo'] = r
    nothing_sent(12)  # past the original send time: undone means never sent
    t0 = time.time()
    run("document.querySelector('.sheet .send').click(); await wait(() => !document.querySelector('.sheet'), 'closed'); return true;")
    mail = received(30)
    assert mail is not None and mail['Subject'] == 'Outbox undo test', mail
    waited = time.time() - t0
    assert waited >= 8, waited
    r = run("await wait(() => !strip().length, 'strip empty'); await wait(() => [...document.querySelectorAll('.toast .text')].some((t) => t.textContent.startsWith('Sent “Outbox undo test”')), 'sent toast'); return true;")
    results['sent_after_delay'] = {'seconds': round(waited, 1)}

    # 2. ⌘Z takes it back; discarding sends nothing.
    r = run(r"""
await newMail(); await compose(%s, 'Outbox cmd-z test', '<p>Outbox body two.</p>');
document.querySelector('.sheet .send').click();
await wait(() => !document.querySelector('.sheet'), 'composer closed');
await wait(() => strip().length, 'queued');
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true }));
const sheet = await wait(() => document.querySelector('.sheet'), 'composer back');
await pause(200);
const subject = sheet.querySelector('#c-subj').value;
sheet.querySelector('.head button[aria-label="Discard"]').click();
const confirm = await wait(() => document.querySelector('.sheet .confirm'), 'restored email asks before discarding');
[...confirm.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Discard').click();
await wait(() => !document.querySelector('.sheet'), 'discarded');
return { subject, strip: strip() };""" % identity)
    assert r['subject'] == 'Outbox cmd-z test' and r['strip'] == [], r
    nothing_sent(13)
    results['cmd_z'] = r

    # 3. Send later (a reply), then Send now.
    run(r"""
window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })); await pause(200);
const input = document.querySelector('.search input'); input.value = 'Spark smoke quoted history'; input.dispatchEvent(new Event('input', { bubbles: true }));
input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
// Search results arrive twice (saved mail, then Thunderbird's): click the row once it stays put, in the same
// check that finds it (a later line could find the list already redrawn).
let seen = null;
await wait(() => { if (document.querySelector('.mini-spin')) return false; const row = [...document.querySelectorAll('.row')].find((r) => r.querySelector('.subject')?.textContent === 'Spark smoke quoted history'); if (row && row === seen) { row.click(); return true; } seen = row || null; return false; }, 'search');
await wait(() => document.querySelector('.thread')?.dataset.relatedBusy === 'false' && document.querySelector('.reply-bar button[data-action="reply"]'), 'conversation');
[...document.querySelectorAll('.reader .reply-bar button[data-action="reply"]')].pop().click();
return true;""")
    r = run(r"""
await compose(%s, '', '<p>Outbox later reply.</p>', false);
document.querySelector('.sheet .later-btn').click();
const menu = await wait(() => document.querySelector('.later-menu'), 'send later menu');
const choices = [...menu.querySelectorAll('button[role=menuitem]')].map((b) => b.textContent.trim());
[...menu.querySelectorAll('button')].find((b) => b.textContent.includes('Tomorrow morning')).click();
await wait(() => !document.querySelector('.sheet'), 'scheduled');
document.querySelector('.reader .bar .close')?.click(); await toInbox();
const queued = await wait(() => strip()[0], 'outbox strip');
return { choices, queued };""" % identity)
    assert r['queued']['meta'].startswith('To ') and 'Sends tomorrow at 8:00' in r['queued']['meta'] and r['queued']['buttons'] == ['Edit', 'Send now'], r
    results['send_later'] = r
    nothing_sent(3)
    m.execute('window.__sparkSendFixture.windows=[];return true;')
    run("stripButton(%s, 'Send now').click(); return true;" % json.dumps(r['queued']['subject']))
    mail = received(30)
    assert mail is not None and mail['Subject'].startswith('Re: Spark smoke quoted history'), mail
    assert 'history-latest@spark-smoke.test' in str(mail.get('References', '')), mail.get('References')
    windows = m.execute('return window.__sparkSendFixture.windows;')
    # Sent from the background without Thunderbird's composer: no window over the user's work (0.1.116).
    assert not any(w.get('type') == 'msgcompose' for w in windows), windows
    run("await wait(() => !strip().length, 'strip empty'); return true;")
    results['send_now'] = {'subject': mail['Subject'], 'references': mail.get('References'), 'windows': windows}

    # 4. Ember closed: the background still sends it.
    run(r"""
await newMail(); await compose(%s, 'Outbox closed test', '<p>Outbox body four.</p>');
document.querySelector('.sheet .send').click();
await wait(() => !document.querySelector('.sheet'), 'composer closed'); await wait(() => strip().length, 'queued');
return true;""" % identity)
    m.execute("const tm=document.getElementById('tabmail');const url=WebExtensionPolicy.getByID('%s').getURL('app.html');for(const t of [...tm.tabInfo])if((t.browser||t.chromeBrowser)?.currentURI?.spec===url)tm.closeTab(t);return true;" % ID)
    t0 = time.time()
    mail = received(40)
    assert mail is not None and mail['Subject'] == 'Outbox closed test', mail
    results['spark_closed'] = {'seconds': round(time.time() - t0, 1)}
    open_spark()
    left = spark.run_in_app(m, "await new Promise((r) => setTimeout(r, 800)); return document.querySelectorAll('.outbox li').length;")
    assert left == 0, left
    (args.output_dir / 'outbox.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps(results, indent=2))
    print('PASS')
finally:
    try:
        spark.run_in_app(m, "await messenger.storage.local.set({ undoSend: 0 }); return true;")
    except Exception: pass
    try: m.execute("const f=window.__sparkSendFixture;if(f){Services.wm.removeListener(f.observer);const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');const identity=MailServices.accounts.getIdentity(f.identity);MailServices.accounts.getAccount(f.account).removeIdentity(identity);const smtp=MailServices.outgoingServer.getServerByKey(f.smtp);MailServices.outgoingServer.deleteServer(smtp);delete window.__sparkSendFixture;}return true;")
    finally: server.shutdown(); server.server_close()
