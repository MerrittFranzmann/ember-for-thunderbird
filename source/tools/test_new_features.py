#!/usr/bin/env python3
"""0.1.66 features end to end, isolated fixture profile only (port 2831). Mail goes to a local SMTP sink
(never an external server); system notifications are recorded by a stand-in alerts service instead of
appearing on screen. Run seed_feature_fixtures.py and seed_long_thread.py first.

  signatures  Thunderbird's signature is sent once; "No signature" sends none; a signature edited in one
              email, saved as "Short", is offered and sent next time.
  follow-up   "Remind me if no reply in 1 day" registers the sent Message-ID; an incoming reply with that
              In-Reply-To clears it; one past its time without a reply becomes due, notifies once, shows
              under No reply yet, and Dismiss removes it.
  pdf         The 60-message long thread saved as PDF: every message once, no repeated quoted history,
              several pages (saved to a scratch folder instead of answering the Save dialog).
  undo        Ctrl+Z after pinning unpins; after archiving restores the conversation.

Usage: test_new_features.py --output-dir DIR
"""
import argparse, email, json, queue, socketserver, tempfile, threading, time
from email.message import EmailMessage
from email.policy import SMTP, default
from email.utils import format_datetime, make_msgid
from datetime import datetime, timezone
from pathlib import Path
import spark

ID = 'thunderbird-spark@merrittfranzmann'


class Sink(socketserver.StreamRequestHandler):
    def handle(self):
        self.wfile.write(b'220 localhost Ember test SMTP\r\n')
        while True:
            line = self.rfile.readline()
            if not line:
                return
            command = line.decode(errors='replace').split(' ', 1)[0].strip().upper()
            if command in ('EHLO', 'HELO'):
                self.wfile.write(b'250-localhost\r\n250 SIZE 10485760\r\n')
            elif command == 'DATA':
                self.wfile.write(b'354 End with dot\r\n')
                chunks = []
                while True:
                    part = self.rfile.readline()
                    if part in (b'.\r\n', b''):
                        break
                    chunks.append(part[1:] if part.startswith(b'..') else part)
                self.server.messages.put(b''.join(chunks))
                self.wfile.write(b'250 Accepted\r\n')
            elif command == 'QUIT':
                self.wfile.write(b'221 Bye\r\n')
                return
            else:
                self.wfile.write(b'250 OK\r\n')


parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Sink)
server.daemon_threads = True
server.messages = queue.Queue()
threading.Thread(target=server.serve_forever, daemon=True).start()
downloads = Path(tempfile.mkdtemp(prefix='spark-pdf-'))
m = spark.connect()
results, failures = {}, []


def check(name, ok, detail):
    results[name] = {'pass': bool(ok), **(detail if isinstance(detail, dict) else {'value': detail})}
    print(('PASS ' if ok else 'FAIL ') + name, json.dumps(detail)[:400], flush=True)
    if not ok:
        failures.append(name)


def app(js):
    return spark.run_in_app(m, js)


def html_of(raw):
    msg = email.message_from_bytes(raw, policy=default)
    part = msg.get_body(preferencelist=('html', 'plain'))
    return msg, part.get_content() if part else ''


HELPERS = r"""
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, label, ms = 20000) => { const t = Date.now(); while (!(await fn())) { if (Date.now() - t > ms) throw new Error('Timed out: ' + label); await pause(60); } };
const menuItem = (text) => [...document.querySelectorAll('.sheet .sig-menu button')].find((b) => b.textContent.includes(text));
const sigButton = () => document.querySelector('.sheet button[title="Signature for this email"]');
async function openComposer(identity, subject) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }));
  await wait(() => document.querySelector('.sheet [contenteditable=true]'), 'composer');
  const sheet = document.querySelector('.sheet');
  sheet.querySelector('#c-from').click(); await new Promise((r) => setTimeout(r, 50)); sheet.querySelector(`[data-identity="${identity}"]`).click();
  await pause(120);
  const to = sheet.querySelector('#c-to'); to.value = 'recipient@spark.test'; to.dispatchEvent(new Event('input', { bubbles: true }));
  to.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  const subj = sheet.querySelector('#c-subj'); subj.value = subject; subj.dispatchEvent(new Event('input', { bubbles: true }));
  sheet.querySelector('[contenteditable=true]').insertAdjacentHTML('afterbegin', '<p>Loopback body for ' + subject + '.</p>');
  return sheet;
}
async function send() {
  document.querySelector('.sheet .send').click();
  await wait(() => !document.querySelector('.sheet') || document.querySelector('.sheet .error'), 'send');
  const error = document.querySelector('.sheet .error')?.textContent; if (error) throw new Error(error);
}
"""


def run(js, timeout=180):
    """Run page JS past Marionette's 30 s limit: start it, park the result on a DOM attribute, poll."""
    start = ("const root = document.documentElement; root.removeAttribute('data-test-result');"
             "(async () => { %s %s })().then((v) => root.setAttribute('data-test-result', JSON.stringify({ ok: true, v: v === undefined ? null : v })),"
             "(e) => root.setAttribute('data-test-result', JSON.stringify({ ok: false, e: String(e) + ' | ' + (e && e.stack || '') }))); return true;") % (HELPERS, js)
    app(start)
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = app("return document.documentElement.getAttribute('data-test-result');")
        if r:
            r = json.loads(r)
            if not r['ok']:
                raise RuntimeError(r['e'])
            return r['v']
        time.sleep(0.4)
    raise TimeoutError('page step timed out')


def take(timeout=30):
    return server.messages.get(timeout=timeout)


config = m.execute('''const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const smtp=MailServices.outgoingServer.createServer("smtp").QueryInterface(Ci.nsISmtpServer);smtp.hostname='127.0.0.1';smtp.port=%d;smtp.authMethod=Ci.nsMsgAuthMethod.none;smtp.socketType=Ci.nsMsgSocketType.plain;smtp.description='Ember local SMTP test';
const identity=MailServices.accounts.createIdentity();identity.email='sender@spark.test';identity.fullName='Ember Loopback';identity.smtpServerKey=smtp.key;identity.doFcc=false;identity.composeHtml=true;
identity.htmlSigFormat=true;identity.htmlSigText='Loopback <b>Sig</b> Line';
MailServices.accounts.getAccount('account2').addIdentity(identity);
// Record notifications instead of showing them on screen.
const registrar=Components.manager.QueryInterface(Ci.nsIComponentRegistrar);const contract='@mozilla.org/alerts-service;1';
window.__sparkAlerts=[];window.__sparkAlertsCID=registrar.contractIDToCID(contract);
const fake={showAlert(alert,listener){window.__sparkAlerts.push({name:alert.name,title:alert.title,text:alert.text});try{listener&&listener.observe(null,'alertshow',alert.cookie);}catch(e){}},closeAlert(){},QueryInterface:ChromeUtils.generateQI(['nsIAlertsService'])};
window.__sparkFakeCID=Components.ID(Services.uuid.generateUUID().toString());window.__sparkFakeFactory={createInstance(iid){return fake.QueryInterface(iid);}};
registrar.registerFactory(window.__sparkFakeCID,'Ember test alerts',contract,window.__sparkFakeFactory);
Services.prefs.setStringPref('browser.download.dir',%s);Services.prefs.setIntPref('browser.download.folderList',2);
return {identity:identity.key,smtp:smtp.key};''' % (server.server_address[1], json.dumps(str(downloads))))
ident = config['identity']
undo_before = 120
try:
    print(spark.chrome_async(m, "const {ExtensionPermissions}=ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs');await ExtensionPermissions.add(%s,{permissions:['messages.send'],origins:[]});const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');await (await AddonManager.getAddonByID(%s)).reload();return true;" % (json.dumps(ID), json.dumps(ID))), flush=True)
    time.sleep(4)
    m.execute("const url=WebExtensionPolicy.getByID(%s).getURL('app.html');for(const w of Services.wm.getEnumerator(null))for(const b of w.document.querySelectorAll('browser'))if(b.currentURI&&b.currentURI.spec===url)return true;const tm=document.getElementById('tabmail');tm&&tm.openTab('contentTab',{url});return true;" % json.dumps(ID))
    for _ in range(80):
        r = app("return !!document.querySelector('.sidebar .item') && typeof messenger.messages.sendMessage === 'function';")
        if r is True:
            break
        time.sleep(0.5)
    undo_before = app("return (await messenger.storage.local.get({ undoSend: 120 })).undoSend;")
    run("await messenger.storage.local.set({ signatures: [], followUps: {}, undoSend: 0 }); return true;")  # sends right away (Ember's default holds mail 2 min)
    time.sleep(1)

    # ---------------- signatures ----------------
    run("await openComposer(%s, 'Sig default'); await send(); return true;" % json.dumps(ident))
    _, body = html_of(take())
    check('signature-thunderbird-once', body.count('Sig</b> Line') == 1, {'count': body.count('Sig</b> Line')})

    run("await openComposer(%s, 'Sig none'); sigButton().click(); await wait(() => menuItem('No signature'), 'menu'); menuItem('No signature').click(); await pause(150);"
        "if (document.querySelector('.sheet .moz-signature')) throw new Error('signature block still there'); await send(); return true;" % json.dumps(ident))
    _, body = html_of(take())
    check('signature-none-sends-none', 'Sig</b> Line' not in body and 'moz-signature' not in body, {'has_sig': 'Sig</b> Line' in body})

    saved = run("await openComposer(%s, 'Sig custom'); sigButton().click(); await wait(() => menuItem('Edit signature in this email'), 'menu'); menuItem('Edit signature in this email').click(); await pause(100);"
                "document.querySelector('.sheet .moz-signature').innerHTML = '-- <br>Custom Short Sig'; sigButton().click(); await wait(() => menuItem('Save as new signature'), 'save item'); menuItem('Save as new signature').click();"
                "await wait(() => document.querySelector('.sheet .sig-name input'), 'name'); const name = document.querySelector('.sheet .sig-name input'); name.value = 'Short'; name.dispatchEvent(new Event('input', { bubbles: true }));"
                "document.querySelector('.sheet .sig-name button').click(); await pause(300); const label = sigButton().textContent.trim(); await send();"
                "return { label, saved: (await messenger.storage.local.get('signatures')).signatures };" % json.dumps(ident))
    _, body = html_of(take())
    check('signature-edited-and-saved', 'Custom Short Sig' in body and 'Sig</b> Line' not in body and saved['saved'] and saved['saved'][0]['name'] == 'Short' and 'Short' in saved['label'], {'label': saved['label'], 'saved': saved['saved']})

    offered = run("await openComposer(%s, 'Sig reuse'); sigButton().click(); await wait(() => menuItem('Short'), 'Short offered'); menuItem('Short').click(); await pause(150);"
                  "const html = document.querySelector('.sheet .moz-signature')?.innerHTML || ''; await send(); return html;" % json.dumps(ident))
    _, body = html_of(take())
    check('saved-signature-reused', 'Custom Short Sig' in offered and 'Custom Short Sig' in body, {'block': offered})

    # Replies and forwards go through Thunderbird's compose window: it must not add its own signature.
    for case, pick in (('reply-thunderbird-signature-once', None), ('reply-no-signature', 'No signature')):
        run(r"""
const input = (window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })), await new Promise((r) => setTimeout(r, 200)), document.querySelector('input[aria-label="Search mail (press / )"]'));
input.value = 'Spark smoke quoted history'; input.dispatchEvent(new Event('input', { bubbles: true }));
input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
const row = () => [...document.querySelectorAll('.row')].find((r) => r.querySelector('.subject')?.textContent === 'Spark smoke quoted history');
await wait(() => !document.querySelector('.load-status') && row(), 'row'); await pause(300); row().click();
await wait(() => document.querySelector('.thread')?.dataset.relatedBusy === 'false', 'thread');
[...document.querySelectorAll('.reader .reply-bar button[data-action="reply"]')].pop().click();
await wait(() => document.querySelector('.sheet [contenteditable=true]'), 'composer');
document.querySelector('#c-from').click(); await pause(50); document.querySelector(`[data-identity="${IDENT}"]`).click(); await pause(150);
document.querySelector('.sheet [contenteditable=true]').insertAdjacentHTML('afterbegin', '<p>Reply body.</p>');
if (PICK) { sigButton().click(); await wait(() => menuItem(PICK), 'menu'); menuItem(PICK).click(); await pause(150); }
await send(); return true;""".replace('IDENT', json.dumps(ident)).replace('PICK', json.dumps(pick)), timeout=120)
        _, body = html_of(take(60))
        count = body.count('Sig</b> Line')
        check(case, count == (0 if pick else 1), {'count': count})

    # ---------------- follow-up reminders ----------------
    reg = run("await openComposer(%s, 'Follow-up answered'); document.querySelector('.sheet button[title=\"Remind me if nobody replies\"]').click();"
              "await wait(() => menuItem('1 day'), 'remind menu'); menuItem('1 day').click(); await send(); await pause(500);"
              "return { list: (await messenger.storage.local.get('followUps')).followUps, toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()) };" % json.dumps(ident))
    sent, _ = html_of(take())
    mid = sent['Message-ID'].strip('<>')
    check('follow-up-registered', mid in reg['list'] and reg['list'][mid]['state'] == 'waiting' and any('reminder in 1 day' in t for t in reg['toast']), {'mid': mid, 'list': list(reg['list']), 'toast': reg['toast']})

    reply = EmailMessage(policy=SMTP)
    reply['From'] = 'Recipient <recipient@spark.test>'
    reply['To'] = 'Ember Loopback <sender@spark.test>'
    reply['Date'] = format_datetime(datetime.now(timezone.utc))
    reply['Message-ID'] = make_msgid(domain='spark-reply.test')
    reply['Subject'] = 'Re: Follow-up answered'
    reply['In-Reply-To'] = f'<{mid}>'
    reply['References'] = f'<{mid}>'
    reply.set_content('Thanks, got it.')
    m.execute("const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage(%s);return true;" % json.dumps(reply.as_string()))
    gone = run("await messenger.alarms.create('spark-followups', { when: Date.now() + 300 }); await wait(async () => !(%s in (await messenger.storage.local.get('followUps')).followUps), 'reply noticed', 30000); return true;" % json.dumps(mid))
    alerts = m.execute("return window.__sparkAlerts;")
    check('reply-clears-reminder', gone is True and not alerts, {'alerts': alerts})

    run("await openComposer(%s, 'Follow-up silent'); document.querySelector('.sheet button[title=\"Remind me if nobody replies\"]').click();"
        "await wait(() => menuItem('2 days'), 'remind menu'); menuItem('2 days').click(); await send(); return true;" % json.dumps(ident))
    sent, _ = html_of(take())
    mid2 = sent['Message-ID'].strip('<>')
    due = run("await wait(async () => %s in (await messenger.storage.local.get('followUps')).followUps, 'registered');"
              "const list = (await messenger.storage.local.get('followUps')).followUps; list[%s].dueAt = Date.now() - 1000; await messenger.storage.local.set({ followUps: list });"
              "await messenger.alarms.create('spark-followups', { when: Date.now() + 300 }); await wait(async () => (await messenger.storage.local.get('followUps')).followUps[%s]?.state === 'due', 'due', 30000);"
              "document.querySelector('[data-mailbox=\"inbox\"] .item.parent')?.click(); await wait(() => document.querySelector('.follow'), 'No reply yet strip');"
              "const strip = document.querySelector('.follow').textContent; await messenger.alarms.create('spark-followups', { when: Date.now() + 300 }); await pause(3000);"
              "return { strip };" % (json.dumps(mid2), json.dumps(mid2), json.dumps(mid2)))
    alerts = m.execute("return window.__sparkAlerts;")
    check('no-reply-becomes-due', 'Follow-up silent' in due['strip'] and len(alerts) == 1 and alerts[0]['title'] == 'Follow-up silent' and 'No reply yet from' in alerts[0]['text'], {'strip': due['strip'], 'alerts': alerts})
    dismissed = run("document.querySelector('.follow .dismiss').click(); await wait(async () => !(%s in (await messenger.storage.local.get('followUps')).followUps), 'dismissed'); await pause(200); return !document.querySelector('.follow');" % json.dumps(mid2))
    check('dismiss-removes', dismissed is True, {'stripGone': dismissed})

    # ---------------- PDF ----------------
    pdf = run(r"""
const original = messenger.downloads.download; const calls = [];
messenger.downloads.download = (o) => { calls.push({ ...o }); return original.call(messenger.downloads, { ...o, saveAs: false, conflictAction: 'uniquify' }); };
try {
  const input = (window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })), await new Promise((r) => setTimeout(r, 200)), document.querySelector('input[aria-label="Search mail (press / )"]'));
  input.value = 'Long thread: venue planning'; input.dispatchEvent(new Event('input', { bubbles: true }));
  input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  const row = () => [...document.querySelectorAll('.row')].find((r) => /Long thread: venue planning/.test(r.querySelector('.subject')?.textContent || ''));
  await wait(() => !document.querySelector('.load-status') && row(), 'thread row'); await pause(400); row().click();
  await wait(() => document.querySelector('.thread')?.dataset.relatedBusy === 'false', 'thread loaded', 60000);
  const count = Number((document.querySelector('.chip.soft')?.textContent || '0').replace(/\D/g, ''));
  const started = Date.now();
  document.querySelector('button[aria-label="Save conversation as PDF"]').click();
  let item; await wait(async () => { [item] = await messenger.downloads.search({ startedAfter: new Date(started - 1000).toISOString() }); return item && item.state !== 'in_progress'; }, 'pdf saved', 120000);
  return { count, filename: item.filename, state: item.state, saveAs: calls[0]?.saveAs, name: calls[0]?.filename, ms: Date.now() - started };
} finally { messenger.downloads.download = original; }
""")
    from pypdf import PdfReader
    reader = PdfReader(pdf['filename'])
    text = '\n'.join(page.extract_text() or '' for page in reader.pages)
    thoughts = [text.count(f'Message {i}: here are my thoughts') for i in range(60)]
    check('pdf-whole-thread', pdf['state'] == 'complete' and pdf['saveAs'] is True and pdf['name'] == 'Long thread_ venue planning.pdf'
          and 'Long thread: venue planning' in text and all(c == 1 for c in thoughts[:pdf['count']]) and 'notes on the venue' not in text and len(reader.pages) > 3,
          {'pages': len(reader.pages), 'messages': pdf['count'], 'missing_or_repeated': [i for i, c in enumerate(thoughts[:pdf['count']]) if c != 1],
           'quoted_repeats': text.count('notes on the venue'), 'ms': pdf['ms'], 'name': pdf['name']})
    Path(pdf['filename']).replace(args.output_dir / 'long-thread.pdf')

    # ---------------- undo ----------------
    undo = run(r"""
const ctrlZ = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
const input = (window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })), await new Promise((r) => setTimeout(r, 200)), document.querySelector('input[aria-label="Search mail (press / )"]'));
input.value = 'Spark smoke quoted history'; input.dispatchEvent(new Event('input', { bubbles: true }));
input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
const row = () => [...document.querySelectorAll('.row')].find((r) => r.querySelector('.subject')?.textContent === 'Spark smoke quoted history');
await wait(() => !document.querySelector('.load-status') && row(), 'row'); await pause(300); row().click(); await pause(600);
const pinned = () => document.querySelector('.reader .bar button[aria-label="Unpin"]') !== null;
const before = pinned();
document.querySelector('.reader .bar button[aria-label="' + (before ? 'Unpin' : 'Pin') + '"]').click(); await wait(() => pinned() !== before, 'pin toggled');
ctrlZ(); await wait(() => pinned() === before, 'pin undone');
document.querySelector('.reader .bar button[aria-label="Archive"]').click(); await wait(() => !row(), 'archived');
ctrlZ(); await wait(() => [...document.querySelectorAll('.toast')].some((t) => /Restored/.test(t.textContent)), 'restored toast', 10000);
input.dispatchEvent(new Event('input', { bubbles: true })); input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
await wait(() => !document.querySelector('.load-status') && row(), 'back in the list', 20000);
return { pinUndone: true, archiveUndone: !!row() };
""")
    check('ctrl-z-undo', undo.get('pinUndone') and undo.get('archiveUndone'), undo)

    # ---------------- slash commands ----------------
    slash = run(r"""
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }));
await wait(() => document.querySelector('.sheet [contenteditable=true]'), 'composer');
const ed = document.querySelector('.sheet [contenteditable=true]');
ed.focus(); const r = document.createRange(); r.setStart(ed, 0); r.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(r);
const type = (t) => { for (const ch of t) document.execCommand('insertText', false, ch); };
const key = (k) => ed.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const menu = () => document.querySelector('.slash-menu');
type('/'); await pause(80); const opened = !!menu(); const firstItems = [...document.querySelectorAll('.slash-menu [role=option]')].length;
type('head'); await pause(80); const filtered = [...document.querySelectorAll('.slash-menu [role=option] .slash-label')].map((n) => n.textContent);
key('Enter'); await pause(120); type('Agenda'); await pause(50);
const heading = ed.querySelector('h2')?.textContent;
key('Enter'); document.execCommand('insertParagraph'); await pause(50);
type('/table'); await pause(80); key('Enter'); await pause(120);
const cells = ed.querySelectorAll('table td').length;
type('Cell A'); await pause(50); const firstCell = ed.querySelector('table td')?.textContent;
const sel = getSelection(); const end = document.createRange(); end.selectNodeContents(ed); end.collapse(false); sel.removeAllRanges(); sel.addRange(end);
type(' and/or'); await pause(80); const midWord = !!menu();
type(' /'); await pause(80); const reopened = !!menu(); key('Escape'); await pause(80);
const closedByEsc = !menu() && !!document.querySelector('.sheet');
type(' /divider'); await pause(80); key('Enter'); await pause(120); const hr = !!ed.querySelector('hr');
document.querySelector('.sheet button[aria-label=Discard]').click(); await pause(300);
[...(document.querySelector('[aria-label="Discard message?"]')?.querySelectorAll('button') || [])].find((b) => /discard/i.test(b.textContent))?.click(); await pause(300);
return { opened, firstItems, filtered, heading, cells, firstCell, midWord, reopened, closedByEsc, hr, composerClosed: !document.querySelector('.sheet') };
""")
    check('slash-commands', slash['opened'] and slash['firstItems'] >= 15 and slash['filtered'][:2] == ['Heading', 'Subheading'] and slash['heading'] == 'Agenda'
          and slash['cells'] == 6 and slash['firstCell'] == 'Cell A' and not slash['midWord'] and slash['reopened'] and slash['closedByEsc'] and slash['hr'] and slash['composerClosed'], slash)
finally:
    try:
        app("await messenger.storage.local.set({ signatures: [], followUps: {}, undoSend: %s });" % json.dumps(undo_before if isinstance(undo_before, int) else 120) + " for (const a of await messenger.alarms.getAll()) if (a.name.startsWith('spark-follow')) await messenger.alarms.clear(a.name); return true;")
    except Exception as error:
        print('cleanup (page):', error)
    m.execute('''const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');const account=MailServices.accounts.getAccount('account2');
for(const i of [...account.identities])if(i.key===%s){account.removeIdentity(i);}
try{MailServices.outgoingServer.deleteServer(MailServices.outgoingServer.getServerByKey(%s));}catch(e){}
const registrar=Components.manager.QueryInterface(Ci.nsIComponentRegistrar);registrar.registerFactory(window.__sparkAlertsCID,'','@mozilla.org/alerts-service;1',null);try{registrar.unregisterFactory(window.__sparkFakeCID,window.__sparkFakeFactory);}catch(e){}
Services.prefs.clearUserPref('browser.download.dir');Services.prefs.clearUserPref('browser.download.folderList');return true;''' % (json.dumps(config['identity']), json.dumps(config['smtp'])))
    server.shutdown()
(args.output_dir / 'new-features.json').write_text(json.dumps(results, indent=2))
print('ALL PASS' if not failures else 'FAILURES: ' + ', '.join(failures))
raise SystemExit(1 if failures else 0)
