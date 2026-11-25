#!/usr/bin/env python3
"""Archives that stay archived, and calendar reads that fail, in the isolated fixture profile only (port 2831).

Thunderbird reports an archive as done even when the server refused the move (Exchange then put the email back
in the Inbox on the next restart). The archive Experiment's test pref (extensions.spark.archive.testFail, honoured
only while Marionette runs) makes the next N archive calls fail without moving anything. Checks:
  - a move that keeps failing: tried three times, the email comes back into the list, the toast says why, the log
    keeps it, and it's still in Thunderbird's Inbox;
  - a move that fails once: tried again, archived (in Thunderbird's Archives), remembered as archived;
  - that email copied back into the Inbox (as an Exchange re-sync would): Ember archives it again, with a note;
  - Undo forgets it;
  - a calendar that can't be read (local mock EWS answering 500): "Couldn't read your calendar", the reason kept
    in the log, and Try again reads it once the server answers.
Puts back the storage it changed (archiveIntents, errorLog), deletes its emails and removes the mock account. Never contacts an
external server.

  test_archive.py --output-dir DIR
"""
import argparse, base64, http.server, json, ssl, subprocess, tempfile, threading, time
from datetime import datetime, timedelta, timezone
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
PREF = 'extensions.spark.archive.testFail'

def mail(name, subject, age):
    e = EmailMessage(policy=SMTP)
    e['From'] = 'Wellness Benefits <benefits@health.example>'; e['To'] = 'Merritt Franzmann <merritt@spark.test>'
    e['Date'] = format_datetime(datetime.now(timezone.utc) - timedelta(minutes=age))
    e['Message-ID'] = f'<{name}-{RUN}@spark-archive.test>'; e['Subject'] = subject; e['X-Mozilla-Status'] = '0000'
    e.set_content('Get care in minutes.')
    return e

MAILS = {
    'fail': mail('fail', f'Archive test: keeps failing {RUN}', 1),
    'flaky': mail('flaky', f'Archive test: fails once {RUN}', 2),
    'undo': mail('undo', f'Archive test: undone {RUN}', 3),
}
MID = {k: str(e['Message-ID']).strip('<>') for k, e in MAILS.items()}
SUBJECT = {k: str(e['Subject']) for k, e in MAILS.items()}
for e in MAILS.values():
    m.execute('''const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const folder = MailServices.accounts.getAccount('account1').incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder);
folder.addMessage(%s); return 1;''' % json.dumps(e.as_string()))

WHERE = '''const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const [mid] = arguments;
const found = [];
for (const f of MailServices.accounts.allFolders) {
  try {
    const db = f.msgDatabase;
    for (const h of db.enumerateMessages()) if (h.messageId === mid && !(h.flags & Ci.nsMsgMessageFlags.Expunged)) found.push(f.isSpecialFolder(Ci.nsMsgFolderFlags.Inbox, false) ? 'Inbox' : decodeURIComponent(f.URI.split('/').slice(3).join('/')));
  } catch {}
}
return found;'''
def where(key):
    reply = m._cmd("WebDriver:ExecuteScript", {"script": WHERE, "args": [MID[key]]})
    return reply.get('value') if isinstance(reply, dict) else reply
CLEANUP = '''const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
let n = 0;
for (const f of MailServices.accounts.allFolders) {
  let hdrs = [];
  try { hdrs = [...f.msgDatabase.enumerateMessages()].filter((h) => h.messageId.endsWith('@spark-archive.test')); } catch {}
  if (hdrs.length) { f.deleteMessages(hdrs, null, true, false, null, false); n += hdrs.length; }
}
return n;'''
def pref(value=None):
    if value is None: m.execute("Services.prefs.clearUserPref(%s); return 1;" % json.dumps(PREF))
    else: m.execute("Services.prefs.setStringPref(%s, %s); return 1;" % (json.dumps(PREF), json.dumps(value)))
def pref_left():
    return m.execute("return Services.prefs.getStringPref(%s, '');" % json.dumps(PREF))

saved = spark.run_in_app(m, "return await messenger.storage.local.get(['archiveIntents', 'errorLog']);")
HELPERS = r'''
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms = 15000) => { for (let t = 0; t < ms; t += 150) { const v = test(); if (v) return v; await pause(150); } return test(); };
const row = (subject) => [...document.querySelectorAll('.viewport .row')].find((r) => r.querySelector('.subject')?.textContent.trim() === subject);
const toasts = () => [...document.querySelectorAll('.toast')].map((t) => t.textContent.replace(/\s+/g, ' ').trim());
const archiveRow = async (subject) => {
  const r = await until(() => row(subject)); if (!r) return false;
  r.click();
  const button = await until(() => document.querySelector('.reader button[aria-label="Archive"]'));
  button.click(); return true;
};
const storage = async (key) => (await messenger.storage.local.get(key))[key];
'''
def page(body):
    r = spark.run_in_app(m, HELPERS + body)
    if isinstance(r, str) and r.startswith('ERROR'): raise RuntimeError(r)
    return r
def poll(body, test, seconds=40):
    value = None
    for _ in range(int(seconds / 0.5)):
        value = page(body)
        if test(value): return value
        time.sleep(0.5)
    return value

result = {}
account = port = server = work = None
try:
    # The Inbox, fresh (the seeds just arrived).
    page("setTimeout(() => location.reload(), 50); return 1;")
    time.sleep(3)
    poll("document.querySelector('.sidebar .item.parent[aria-label^=\"Inbox\"]')?.click(); return !!row(%s);" % json.dumps(SUBJECT['undo']), bool)

    # 1. Keeps failing: three tries (now, 4 s, 15 s later), then back in the list with the reason.
    pref('3')
    result['fail_started'] = page("return { clicked: await archiveRow(%s), hidden: !!(await until(() => !row(%s), 3000)) };" % (json.dumps(SUBJECT['fail']), json.dumps(SUBJECT['fail'])))
    result['fail'] = poll("return { back: !!row(%s), toasts: toasts() };" % json.dumps(SUBJECT['fail']), lambda v: v and v['back'], 40)
    result['fail_tries_used'] = pref_left() == ''
    result['fail_in_tb'] = where('fail')
    time.sleep(2.5)  # the error log saves within 2 s
    result['fail_logged'] = page("return (await storage('errorLog') || []).some((e) => e.text.includes(\"Couldn't archive this email\") && e.text.includes(\"didn't answer in time\"));")
    result['fail_intent'] = page("return (await storage('archiveIntents') || {})[%s] || null;" % json.dumps(MID['fail']))

    # 2. Fails once: tried again and archived.
    pref('1')
    result['flaky'] = page("""const clicked = await archiveRow(%s);
const gone = !!(await until(() => !row(%s), 3000));
const done = await until(() => toasts().find((t) => t.startsWith('Archived')), 15000);
return { clicked, gone, toast: done || toasts() };""" % (json.dumps(SUBJECT['flaky']), json.dumps(SUBJECT['flaky'])))
    result['flaky_in_tb'] = where('flaky')
    result['flaky_intent'] = page("return (await storage('archiveIntents') || {})[%s] || null;" % json.dumps(MID['flaky']))

    # 3. Copied back into the Inbox (as Exchange's re-sync would put it back): Ember archives it again.
    result['copied_back'] = m.execute('''const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const root = MailServices.accounts.getAccount('account1').incomingServer.rootFolder;
const mid = %s;
let source = null, hdr = null;
for (const f of MailServices.accounts.allFolders) {
  if (f.isSpecialFolder(Ci.nsMsgFolderFlags.Inbox, false)) continue;
  try { for (const h of f.msgDatabase.enumerateMessages()) if (h.messageId === mid) { source = f; hdr = h; } } catch {}
  if (hdr) break;
}
if (!hdr) return 'not found';
MailServices.copy.copyMessages(source, [hdr], root.getChildNamed('Inbox'), false, null, null, false);
return source.URI;''' % json.dumps(MID['flaky']))
    result['back'] = poll("return { toasts: toasts(), listed: !!row(%s) };" % json.dumps(SUBJECT['flaky']),
                          lambda v: v and any('again' in t for t in v['toasts']), 25)
    time.sleep(1)
    result['back_in_tb'] = where('flaky')
    result['back_intent'] = page("return (await storage('archiveIntents') || {})[%s] || null;" % json.dumps(MID['flaky']))
    time.sleep(2.5)
    result['back_logged'] = page("return (await storage('errorLog') || []).some((e) => e.text.startsWith(\"archive didn't stick\"));")

    # 4. Undo forgets it (and brings it back).
    result['undo'] = page("""const before = new Set(document.querySelectorAll('.toast'));
await archiveRow(%s);
// This archive's own toast (an older "Archived" may still be showing).
const undo = await until(() => [...document.querySelectorAll('.toast')].filter((t) => !before.has(t)).flatMap((t) => [...t.querySelectorAll('button')]).find((b) => b.textContent.trim() === 'Undo'), 15000);
undo?.click();
const restored = !!(await until(() => row(%s), 15000));
return { restored, intent: (await storage('archiveIntents') || {})[%s] || null };""" % (json.dumps(SUBJECT['undo']), json.dumps(SUBJECT['undo']), json.dumps(MID['undo'])))

    # 5. A calendar that can't be read, then can.
    state = {'up': False}
    class EWS(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
            reply = None
            if state['up'] and '<m:FindItem' in body:
                start = datetime.now(timezone.utc) + timedelta(minutes=20)
                iso = lambda d: d.strftime('%Y-%m-%dT%H:%M:%SZ')
                reply = ('<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><m:FindItemResponse xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"><m:ResponseMessages><m:FindItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>'
                         f'<m:RootFolder TotalItemsInView="1" IncludesLastItemInRange="true"><t:Items><t:CalendarItem><t:ItemId Id="X1"/><t:Subject>Archive test sync</t:Subject><t:Start>{iso(start)}</t:Start><t:End>{iso(start + timedelta(minutes=30))}</t:End><t:IsAllDayEvent>false</t:IsAllDayEvent><t:LegacyFreeBusyStatus>Busy</t:LegacyFreeBusyStatus><t:MyResponseType>Accept</t:MyResponseType><t:IsCancelled>false</t:IsCancelled></t:CalendarItem></t:Items></m:RootFolder>'
                         '</m:FindItemResponseMessage></m:ResponseMessages></m:FindItemResponse></s:Body></s:Envelope>')
            self.send_response(200 if reply else 500)
            self.send_header('Content-Type', 'text/xml; charset=utf-8')
            self.end_headers()
            self.wfile.write((reply or '').encode())
    work = Path(tempfile.mkdtemp(dir=args.output_dir))
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
                    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', work / 'key.pem', '-out', work / 'cert.pem'], check=True, capture_output=True)
    der = subprocess.run(['openssl', 'x509', '-in', work / 'cert.pem', '-outform', 'DER'], check=True, capture_output=True).stdout
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), EWS)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(work / 'cert.pem', work / 'key.pem')
    server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    reply = m._cmd("WebDriver:ExecuteScript", {"script": '''
const [port, der] = arguments;
const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const cert = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB).constructX509FromBase64(der);
Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).rememberValidityOverride("127.0.0.1", port, {}, cert, false);
const server = MailServices.accounts.createIncomingServer("archive-test@ews.test", "127.0.0.1", "ews");
server.setStringValue("ews_url", `https://127.0.0.1:${port}/EWS/Exchange.asmx`);
server.authMethod = Ci.nsMsgAuthMethod.passwordCleartext;
server.password = "spark-test-password";
server.loginAtStartUp = false; server.doBiff = false;
const account = MailServices.accounts.createAccount();
account.incomingServer = server;
return account.key;''', "args": [port, base64.b64encode(der).decode()]})
    account = reply.get('value') if isinstance(reply, dict) else reply
    result['calendar_down'] = page("""window.dispatchEvent(new Event('spark:calendar-changed'));
const line = await until(() => document.querySelector('.agenda .calendar-error'), 20000);
return { text: line?.textContent.replace(/\\s+/g, ' ').trim() || null, title: line?.getAttribute('title') || null };""")
    time.sleep(2.5)
    result['calendar_logged'] = page("return (await storage('errorLog') || []).filter((e) => e.text.startsWith('calendar: archive-test@ews.test')).map((e) => e.text);")
    state['up'] = True
    result['calendar_up'] = page("""document.querySelector('.agenda .calendar-error button')?.click();
const shown = await until(() => [...document.querySelectorAll('.agenda li .title')].some((t) => t.textContent.trim() === 'Archive test sync'), 20000);
return { shown: !!shown, errorGone: !document.querySelector('.agenda .calendar-error') };""")
    spark.app_shot(m, str(args.output_dir / 'archive.png'))
finally:
    pref()
    # Its emails go (every copy, in any folder): left in the Inbox they'd push other tests' fixtures out of the
    # rows an occluded test window draws.
    try:
        result['cleaned'] = m.execute(CLEANUP)
    except Exception as error: result['cleanup_error'] = str(error)
    try:
        page("await messenger.storage.local.set(%s); setTimeout(() => location.reload(), 50); return 1;" % json.dumps({'archiveIntents': saved.get('archiveIntents') or {}, 'errorLog': saved.get('errorLog') or []}))
        time.sleep(3)
    except Exception as error: result['restore_error'] = str(error)
    if account:
        m._cmd("WebDriver:ExecuteScript", {"script": '''
const [key, port] = arguments;
const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const account = MailServices.accounts.getAccount(key);
if (account) MailServices.accounts.removeAccount(account, true);
Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).clearValidityOverride("127.0.0.1", port, {});
return true;''', "args": [account, port]})
        try: page("window.dispatchEvent(new Event('spark:calendar-changed')); return 1;")
        except Exception: pass
    if server: server.shutdown()
    if work: subprocess.run(['rm', '-rf', str(work)])
    spark._end_session(m)

r = result
fail_toast = next((t for t in r.get('fail', {}).get('toasts', []) if "Couldn't archive" in t), '')
checks = {
    'failing_move_tried_three_times': r.get('fail_started', {}).get('hidden') is True and r.get('fail_tries_used') is True,
    'failing_move_comes_back_with_reason': r.get('fail', {}).get('back') is True and "didn't answer in time" in fail_toast and "back in the inbox" in fail_toast,
    'failing_move_left_in_inbox': r.get('fail_in_tb') == ['Inbox'],
    'failing_move_logged_and_waits_for_server': r.get('fail_logged') is True and (r.get('fail_intent') or {}).get('pending') is not None and 'when the server answers' in fail_toast,
    'flaky_move_retried_and_archived': r.get('flaky', {}).get('gone') is True and isinstance(r['flaky'].get('toast'), str) and r['flaky']['toast'].startswith('Archived') and len(r.get('flaky_in_tb') or []) == 1 and r['flaky_in_tb'][0].startswith('Archives'),
    'archived_remembered': (r.get('flaky_intent') or {}).get('settled') is True,
    'came_back_archived_again': any('again' in t for t in r.get('back', {}).get('toasts', [])) and bool(r.get('back_in_tb')) and 'Inbox' not in r['back_in_tb'] and r.get('back', {}).get('listed') is False,
    'came_back_counted_and_logged': (r.get('back_intent') or {}).get('again') == 1 and r.get('back_logged') is True,
    'undo_forgets': r.get('undo', {}).get('restored') is True and r['undo'].get('intent') is None,
    'calendar_failure_shown': (r.get('calendar_down') or {}).get('text', '') .startswith("Couldn't read") and 'archive-test@ews.test' in ((r.get('calendar_down') or {}).get('title') or ''),
    'calendar_failure_logged': bool(r.get('calendar_logged')),
    'calendar_try_again': r.get('calendar_up') == {'shown': True, 'errorGone': True},
}
result['checks'] = checks
(args.output_dir / 'archive.json').write_text(json.dumps(result, indent=2, ensure_ascii=False))
print(json.dumps(result, indent=2, ensure_ascii=False))
print('ALL PASS' if all(checks.values()) else 'FAIL: ' + ', '.join(k for k, v in checks.items() if not v))
raise SystemExit(0 if all(checks.values()) else 1)
