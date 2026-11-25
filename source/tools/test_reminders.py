#!/usr/bin/env python3
"""Meeting reminders end to end, isolated fixture profile only (port 2831), against a local mock EWS.

A throwaway EWS account (password auth, self-signed 127.0.0.1 server) has one meeting starting in about
2.5 minutes, with a Teams link in its body. With "Meeting reminders: 2 minutes before", Ember's background
should set an alarm, show one notification ("Ember reminder test") about 30 s later, and not show it again
on the next refresh. Restores the setting and removes the account afterwards. Never contacts an external server.
"""
import argparse, base64, http.server, json, ssl, subprocess, tempfile, threading, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
import spark

M = 'xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"'
def ok(kind, inner=''):
    return (f'<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><m:{kind}Response {M}><m:ResponseMessages>'
            f'<m:{kind}ResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>{inner}</m:{kind}ResponseMessage></m:ResponseMessages></m:{kind}Response></s:Body></s:Envelope>')
iso = lambda t: t.strftime('%Y-%m-%dT%H:%M:%SZ')
START = datetime.now(timezone.utc).replace(microsecond=0) + timedelta(seconds=150)
VIEW = ok('FindItem', '<m:RootFolder><t:Items><t:CalendarItem><t:ItemId Id="REM1"/><t:Subject>Ember reminder test</t:Subject>'
          f'<t:Start>{iso(START)}</t:Start><t:End>{iso(START + timedelta(minutes=30))}</t:End><t:IsAllDayEvent>false</t:IsAllDayEvent>'
          '<t:LegacyFreeBusyStatus>Busy</t:LegacyFreeBusyStatus><t:MyResponseType>Accept</t:MyResponseType><t:IsCancelled>false</t:IsCancelled>'
          '<t:UID>spark-reminder-test</t:UID><t:ReminderIsSet>true</t:ReminderIsSet><t:ReminderMinutesBeforeStart>15</t:ReminderMinutesBeforeStart></t:CalendarItem></t:Items></m:RootFolder>')
BODIES = ok('GetItem', '<m:Items><t:CalendarItem><t:ItemId Id="REM1"/><t:Body BodyType="Text">Join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_rem%40thread.v2/0</t:Body></t:CalendarItem></m:Items>')

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
work = Path(tempfile.mkdtemp(dir=args.output_dir))
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
                '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', work / 'key.pem', '-out', work / 'cert.pem'], check=True, capture_output=True)
der = subprocess.run(['openssl', 'x509', '-in', work / 'cert.pem', '-outform', 'DER'], check=True, capture_output=True).stdout
log = []

class EWS(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
        reply = VIEW if '<m:FindItem' in body else BODIES if '<m:GetItem' in body else ''
        if reply: log.append('FindItem' if '<m:FindItem' in body else 'GetItem')
        self.send_response(200 if reply else 500)
        self.send_header('Content-Type', 'text/xml; charset=utf-8')
        self.end_headers()
        self.wfile.write(reply.encode())

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), EWS)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(work / 'cert.pem', work / 'key.pem')
server.socket = context.wrap_socket(server.socket, server_side=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
port = server.server_address[1]

m = spark.connect()
def chrome(script, values):
    reply = m._cmd("WebDriver:ExecuteScript", {"script": script, "args": values})
    return reply.get("value") if isinstance(reply, dict) else reply
setup = chrome('''
const [port, der] = arguments;
const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const cert = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB).constructX509FromBase64(der);
Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).rememberValidityOverride("127.0.0.1", port, {}, cert, false);
const server = MailServices.accounts.createIncomingServer("reminders@ews.test", "127.0.0.1", "ews");
server.setStringValue("ews_url", `https://127.0.0.1:${port}/EWS/Exchange.asmx`);
server.authMethod = Ci.nsMsgAuthMethod.passwordCleartext;
server.password = "spark-test-password";
server.loginAtStartUp = false; server.doBiff = false;
const account = MailServices.accounts.createAccount();
account.incomingServer = server;
return {account: account.key};
''', [port, base64.b64encode(der).decode()])
result = {'setup': setup, 'start': iso(START)}
try:
    # Changing the setting makes the background refresh at once.
    spark.run_in_app(m, 'await messenger.storage.local.remove(["reminderShown", "reminderRefreshedAt"]); await messenger.storage.local.set({ meetingReminder: 2 }); return true;')
    time.sleep(8)
    result['planned'] = spark.run_in_app(m, '''const s = await messenger.storage.local.get(["reminderPlan", "reminderShown"]);
return { plan: Object.values(s.reminderPlan || {}).map((r) => ({ key: r.key, inSeconds: Math.round((r.at - Date.now()) / 1000), join: r.join })), shown: Object.keys(s.reminderShown || {}),
  alarms: (await messenger.alarms.getAll()).filter((a) => a.name.startsWith("spark-remind")).map((a) => ({ name: a.name, inSeconds: a.scheduledTime ? Math.round((a.scheduledTime - Date.now()) / 1000) : null })) };''')
    wait = max(0, (result['planned']['plan'][0]['inSeconds'] if result['planned']['plan'] else 0) + 8)
    time.sleep(min(wait, 90))
    result['after'] = spark.run_in_app(m, 'const s = await messenger.storage.local.get(["reminderShown"]); return Object.keys(s.reminderShown || {});')
    # A second refresh must not remind again.
    spark.run_in_app(m, 'await messenger.runtime.sendMessage({ type: "spark:reminders" }); return true;')
    time.sleep(3)
    result['afterRefresh'] = spark.run_in_app(m, 'const s = await messenger.storage.local.get(["reminderShown", "reminderPlan"]); return { shown: s.reminderShown, planned: Object.keys(s.reminderPlan || {}) };')
    key = f'spark-reminder-test|{iso(START)}'
    plan = result['planned']['plan']
    result['checks'] = {
        'read_calendar': 'FindItem' in log and 'GetItem' in log,
        'planned_two_minutes_before': len(plan) == 1 and plan[0]['key'] == key and 20 <= plan[0]['inSeconds'] <= 40,
        'join_link': len(plan) == 1 and (plan[0]['join'] or {}).get('label') == 'Teams',
        'alarm_set': any(a['name'] == 'spark-remind:' + key for a in result['planned']['alarms']),
        'not_shown_early': result['planned']['shown'] == [],
        'shown_on_time': result['after'] == [key],
        'shown_once': list((result['afterRefresh']['shown'] or {}).keys()) == [key],
    }
finally:
    spark.run_in_app(m, 'await messenger.storage.local.set({ meetingReminder: 5 }); return true;')
    chrome('''
const [key, port] = arguments;
const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const account = MailServices.accounts.getAccount(key);
if (account) MailServices.accounts.removeAccount(account, true);
Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).clearValidityOverride("127.0.0.1", port, {});
return true;''', [setup['account'], port])
    server.shutdown()

(args.output_dir / 'reminders.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
raise SystemExit(0 if result.get('checks') and all(result['checks'].values()) else 1)
