#!/usr/bin/env python3
""""Before your meeting" end to end, isolated fixture profile only (port 2831), against a local mock EWS.

A self-signed HTTPS server on 127.0.0.1 answers a throwaway EWS account's calendar: a meeting starting in
8 minutes whose organizer is someone with recent saved mail in the fixture profile. Then:
  - Today in the sidebar shows the meeting's email count, and the strip above the Smart Inbox appears;
  - the strip opens the brief (the meeting's subject as the list title, its people, the emails);
  - the background's reminder refresh shows the brief notification (a stand-in alerts service keeps it off
    the screen), and clicking it opens the brief again.
Removes the account, the certificate override and the stand-in alerts service afterwards. Never contacts an
external server.

  test_meeting_brief.py --output-dir DIR
"""
import argparse, base64, http.server, json, ssl, subprocess, tempfile, threading, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)

m = spark.connect()
# Someone with saved mail in the last two weeks (not the user).
person = spark.run_in_app(m, r'''
const me = new Set((await messenger.accounts.list()).flatMap((a) => a.identities.map((i) => i.email.toLowerCase())));
const inbox = (await messenger.folders.query({ specialUse: ['inbox'] }))[0];
const page = await messenger.messages.query({ folderId: inbox.id, fromDate: new Date(Date.now() - 14 * 86400000) });
const counts = new Map();
for (const msg of page.messages) {
  const m = /^(?:"?([^"<]*)"?\s*)?<?([^<>\s]+@[^<>\s]+)>?$/.exec(msg.author.trim()); if (!m) continue;
  const email = m[2].toLowerCase(); if (me.has(email) || /no-?reply|notification/i.test(email)) continue;
  const c = counts.get(email) || { name: (m[1] || '').trim() || email, email, n: 0 }; c.n++; counts.set(email, c);
}
return [...counts.values()].sort((a, b) => b.n - a.n)[0] || null;''')
print('person', person)
if not person:
    raise SystemExit('no recent saved mail from anyone in the fixture profile')

subject = f'Brief check {int(time.time())}'
start = datetime.now(timezone.utc) + timedelta(minutes=8)
end = start + timedelta(minutes=30)
iso = lambda d: d.strftime('%Y-%m-%dT%H:%M:%SZ')
esc = lambda s: s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

def envelope(body):
    return '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' + body + '</s:Body></s:Envelope>'
M = 'xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"'
def ok(kind, inner=''):
    return envelope(f'<m:{kind}Response {M}><m:ResponseMessages><m:{kind}ResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>{inner}</m:{kind}ResponseMessage></m:ResponseMessages></m:{kind}Response>')
VIEW = ok('FindItem', '<m:RootFolder TotalItemsInView="1" IncludesLastItemInRange="true"><t:Items>'
          f'<t:CalendarItem><t:ItemId Id="BRIEF1"/><t:Subject>{esc(subject)}</t:Subject><t:Start>{iso(start)}</t:Start><t:End>{iso(end)}</t:End>'
          '<t:IsAllDayEvent>false</t:IsAllDayEvent><t:LegacyFreeBusyStatus>Busy</t:LegacyFreeBusyStatus><t:Location>Microsoft Teams Meeting</t:Location>'
          f'<t:UID>brief-{int(time.time())}</t:UID><t:MyResponseType>Accept</t:MyResponseType><t:IsCancelled>false</t:IsCancelled></t:CalendarItem>'
          '</t:Items></m:RootFolder>')
mailbox = lambda name, email: f'<t:Mailbox><t:Name>{esc(name)}</t:Name><t:EmailAddress>{esc(email)}</t:EmailAddress><t:RoutingType>SMTP</t:RoutingType></t:Mailbox>'
DETAILS = ok('GetItem', '<m:Items><t:CalendarItem><t:ItemId Id="BRIEF1"/>'
             '<t:Body BodyType="Text">Join: https://teams.microsoft.com/l/meetup-join/19%3abrief%40thread.v2/0</t:Body>'
             f'<t:Organizer>{mailbox(person["name"], person["email"])}</t:Organizer>'
             f'<t:RequiredAttendees><t:Attendee>{mailbox("Merritt (EWS test)", "merritt@ews.test")}</t:Attendee>'
             f'<t:Attendee>{mailbox("Nobody", "nobody@nowhere.test")}</t:Attendee></t:RequiredAttendees>'
             '</t:CalendarItem></m:Items>')

work = Path(tempfile.mkdtemp(dir=args.output_dir))
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
                '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', work / 'key.pem', '-out', work / 'cert.pem'], check=True, capture_output=True)
der = subprocess.run(['openssl', 'x509', '-in', work / 'cert.pem', '-outform', 'DER'], check=True, capture_output=True).stdout
requests = []

class EWS(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
        reply = VIEW if '<m:FindItem' in body and 'calendar:Start' in body else DETAILS if '<m:GetItem' in body and 'item:Body' in body else None
        if reply: requests.append('FindItem' if '<m:FindItem' in body else 'GetItem+people' if 'RequiredAttendees' in body else 'GetItem')
        self.send_response(200 if reply else 500)
        self.send_header('Content-Type', 'text/xml; charset=utf-8')
        self.end_headers()
        self.wfile.write((reply or '').encode())

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), EWS)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(work / 'cert.pem', work / 'key.pem')
server.socket = context.wrap_socket(server.socket, server_side=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
port = server.server_address[1]

def chrome(script, values=()):
    reply = m._cmd("WebDriver:ExecuteScript", {"script": script, "args": list(values)})
    return reply.get("value") if isinstance(reply, dict) else reply

# Stand-in alerts service: keeps the notification (and its click listener) instead of showing it.
chrome("""
const registrar=Components.manager.QueryInterface(Ci.nsIComponentRegistrar);const contract='@mozilla.org/alerts-service;1';
window.__brAlerts=[]; window.__brOrigCID=registrar.contractIDToCID(contract);
window.__brCID=Components.ID('{'+Services.uuid.generateUUID().toString().slice(1,-1)+'}');
const fake={showAlert(alert,listener){window.__brAlerts.push({alert,listener});try{listener&&listener.observe(null,'alertshow',alert.cookie);}catch(e){}},closeAlert(){},QueryInterface:ChromeUtils.generateQI(['nsIAlertsService'])};
window.__brFactory={createInstance(iid){return fake.QueryInterface(iid);},QueryInterface:ChromeUtils.generateQI(['nsIFactory'])};
registrar.registerFactory(window.__brCID,'Brief test alerts',contract,window.__brFactory); return 1;""")
account = chrome('''
const [port, der] = arguments;
const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const cert = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB).constructX509FromBase64(der);
Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).rememberValidityOverride("127.0.0.1", port, {}, cert, false);
const server = MailServices.accounts.createIncomingServer("merritt@ews.test", "127.0.0.1", "ews");
server.setStringValue("ews_url", `https://127.0.0.1:${port}/EWS/Exchange.asmx`);
server.authMethod = Ci.nsMsgAuthMethod.passwordCleartext;
server.password = "spark-test-password";
server.loginAtStartUp = false; server.doBiff = false;
const account = MailServices.accounts.createAccount();
account.incomingServer = server;
const identity = MailServices.accounts.createIdentity(); identity.email = "merritt@ews.test"; identity.fullName = "Merritt (EWS test)";
account.addIdentity(identity);
return account.key;''', [port, base64.b64encode(der).decode()])
result = {'person': person, 'subject': subject}
try:
    # Today reads the calendar; the Smart Inbox shows the strip.
    result['today'] = spark.run_in_app(m, r'''
document.querySelector('.sidebar .item.parent[aria-label^="Inbox"]')?.click();
window.dispatchEvent(new Event('spark:calendar-changed'));
for (let i = 0; i < 40 && !document.querySelector('section.brief'); i++) await new Promise(r => setTimeout(r, 250));
const row = [...document.querySelectorAll('.agenda li')].find(li => li.textContent.includes(%s));
const strip = document.querySelector('section.brief');
return { row: row?.textContent.replace(/\s+/g, ' ').trim() || null, count: row?.querySelector('.mail-count')?.textContent.trim() || null,
  strip: strip?.textContent.replace(/\s+/g, ' ').trim() || null, join: !!strip?.querySelector('.join') };''' % json.dumps(subject))
    spark.app_shot(m, str(args.output_dir / 'brief-strip.png'))
    # The strip opens the brief.
    result['brief'] = spark.run_in_app(m, r'''
document.querySelector('section.brief .open')?.click();
for (let i = 0; i < 40 && !document.querySelector('.brief-scope'); i++) await new Promise(r => setTimeout(r, 250));
await new Promise(r => setTimeout(r, 1500));
return { title: document.querySelector('.list-head h1')?.textContent.trim(), scope: document.querySelector('.brief-scope')?.textContent.replace(/\s+/g, ' ').trim() || null,
  conversations: Number(document.querySelector('.list-head .n')?.textContent.replace(/\D/g, '') || 0), rows: document.querySelectorAll('.viewport .row, .viewport [role=option]').length,
  senders: [...document.querySelectorAll('.viewport [role=option]')].slice(0, 5).map(r => r.textContent.replace(/\s+/g, ' ').trim().slice(0, 60)) };''')
    spark.app_shot(m, str(args.output_dir / 'brief-view.png'))
    # The background's notification ten minutes before (here: at once, it's 8 minutes away), and its click.
    spark.run_in_app(m, r'''document.querySelector('.sidebar .item.parent[aria-label^="Inbox"]')?.click();
await messenger.runtime.sendMessage({ type: 'spark:reminders' }); return 1;''')
    alerts = []
    for _ in range(30):
        alerts = chrome("return window.__brAlerts.map(a => ({name: a.alert.name, title: a.alert.title, text: a.alert.text}));")
        if any(a['title'].startswith('Before ') for a in alerts): break
        time.sleep(0.5)
    result['notifications'] = alerts
    if any(a['title'].startswith('Before ') for a in alerts):
        chrome("const a = window.__brAlerts.find(a => a.alert.title.startsWith('Before ')); a.listener.observe(null, 'alertclickcallback', a.alert.cookie); return 1;")
        time.sleep(3)
        result['clicked'] = spark.run_in_app(m, "return { title: document.querySelector('.list-head h1')?.textContent.trim(), scope: !!document.querySelector('.brief-scope') };")
    result['requests'] = requests
    t, b = result['today'] or {}, result['brief'] or {}
    brief_alert = next((a for a in alerts if a['title'].startswith('Before ')), None)
    result['checks'] = {
        'calendar_asked_for_people': 'GetItem+people' in requests,
        'today_shows_count': bool(t.get('count')) and int(t['count'].rstrip('+')) >= 1,
        'strip_above_inbox': bool(t.get('strip')) and subject in t['strip'] and 'recent email' in t['strip'],
        'strip_join_button': t.get('join') is True,
        'brief_title': b.get('title') == subject,
        'brief_people': bool(b.get('scope')) and person['name'].split()[0] in b['scope'] and 'last 30 days' in b['scope'],
        'brief_lists_mail': (b.get('conversations') or 0) >= 1,
        'notification': bool(brief_alert) and brief_alert['title'] == f'Before {subject}' and 'recent email' in brief_alert['text'],
        'notification_opens_brief': (result.get('clicked') or {}).get('title') == subject and (result.get('clicked') or {}).get('scope') is True,
    }
finally:
    chrome('''
const [key, port] = arguments;
const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const account = MailServices.accounts.getAccount(key);
if (account) MailServices.accounts.removeAccount(account, true);
Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).clearValidityOverride("127.0.0.1", port, {});
const registrar=Components.manager.QueryInterface(Ci.nsIComponentRegistrar); registrar.registerFactory(window.__brOrigCID,'','@mozilla.org/alerts-service;1',null); try{registrar.unregisterFactory(window.__brCID,window.__brFactory);}catch(e){}
return true;''', [account, port])
    server.shutdown()
    spark.run_in_app(m, "await messenger.storage.local.remove('sparkOpenBrief'); window.dispatchEvent(new Event('spark:calendar-changed')); return 1;")

(args.output_dir / 'meeting-brief.json').write_text(json.dumps(result, indent=2))
print(json.dumps({k: result.get(k) for k in ('today', 'brief', 'notifications', 'clicked', 'checks')}, indent=2))
raise SystemExit(0 if result.get('checks') and all(result['checks'].values()) else 1)
