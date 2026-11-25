#!/usr/bin/env python3
"""Ember's Exchange calendar calls end to end, isolated fixture profile only (port 2831), against a local mock EWS.

Like test_exchange_response.py: a self-signed HTTPS server on 127.0.0.1 answers EWS requests, and a throwaway
EWS account (password auth) holds a meeting request and a cancellation header with `ewsId`s. The app then calls
the calendar Experiment: meetingStatus(), respond() with a note and without notifying, removeFromCalendar(),
and calendarView() with details (including the retry without UID for servers that refuse it in FindItem).
Removes the account and the certificate override afterwards. Never contacts an external server.
"""
import argparse, base64, http.server, json, ssl, subprocess, tempfile, threading
from pathlib import Path
import spark

def envelope(body):
    return ('<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' + body +
            '</s:Body></s:Envelope>').replace('<m:', '<m:').replace('XMLNS', '')
M = 'xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"'
def ok(kind, inner=''):
    return envelope(f'<m:{kind}Response {M}><m:ResponseMessages><m:{kind}ResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>{inner}</m:{kind}ResponseMessage></m:ResponseMessages></m:{kind}Response>')
MEETING = ok('GetItem', '<m:Items><t:MeetingRequest><t:ItemId Id="AAMkInvite" ChangeKey="CK&amp;7"/><t:ItemClass>IPM.Schedule.Meeting.Request</t:ItemClass>'
             '<t:ResponseType>NoResponseReceived</t:ResponseType><t:AssociatedCalendarItemId Id="CAL&amp;1"/><t:IsOutOfDate>true</t:IsOutOfDate></t:MeetingRequest></m:Items>')
def calendar_item(answer):
    return ok('GetItem', f'<m:Items><t:CalendarItem><t:ItemId Id="CAL&amp;1"/><t:MyResponseType>{answer}</t:MyResponseType><t:IsCancelled>false</t:IsCancelled></t:CalendarItem></m:Items>')
VIEW = ok('FindItem', '<m:RootFolder TotalItemsInView="2" IncludesLastItemInRange="true"><t:Items>'
          '<t:CalendarItem><t:ItemId Id="EV1"/><t:Subject>Weekly sync</t:Subject><t:Start>2026-10-28T17:30:00Z</t:Start><t:End>2026-10-28T18:00:00Z</t:End>'
          '<t:IsAllDayEvent>false</t:IsAllDayEvent><t:LegacyFreeBusyStatus>Busy</t:LegacyFreeBusyStatus><t:Location>Microsoft Teams Meeting</t:Location>'
          '<t:MyResponseType>Accept</t:MyResponseType><t:IsCancelled>false</t:IsCancelled></t:CalendarItem>'
          '<t:CalendarItem><t:ItemId Id="EV2"/><t:Subject>Lunch</t:Subject><t:Start>2026-10-28T16:00:00Z</t:Start><t:End>2026-10-28T17:00:00Z</t:End>'
          '<t:IsAllDayEvent>false</t:IsAllDayEvent><t:LegacyFreeBusyStatus>Free</t:LegacyFreeBusyStatus><t:MyResponseType>Organizer</t:MyResponseType><t:IsCancelled>false</t:IsCancelled></t:CalendarItem>'
          '</t:Items></m:RootFolder>')
NO_UID = envelope(f'<m:FindItemResponse {M}><m:ResponseMessages><m:FindItemResponseMessage ResponseClass="Error"><m:MessageText>The specified property is invalid.</m:MessageText>'
                  '<m:ResponseCode>ErrorInvalidPropertyRequest</m:ResponseCode></m:FindItemResponseMessage></m:ResponseMessages></m:FindItemResponse>')
BODIES = ok('GetItem', '<m:Items><t:CalendarItem><t:ItemId Id="EV1"/><t:Body BodyType="Text">Join the meeting now&lt;https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d&amp;a=1&gt;</t:Body></t:CalendarItem>'
            '<t:CalendarItem><t:ItemId Id="EV2"/><t:Body BodyType="Text"></t:Body></t:CalendarItem></m:Items>')
SAVED = ok('CreateItem', '<m:Items><t:MeetingResponse><t:ItemId Id="DRAFT1"/></t:MeetingResponse><t:CalendarItem><t:ItemId Id="CAL&amp;1"/></t:CalendarItem></m:Items>')
SENT = ok('CreateItem', '<m:Items/>')
DELETED = ok('DeleteItem')

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)

work = Path(tempfile.mkdtemp(dir=args.output_dir))
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
                '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', work / 'key.pem', '-out', work / 'cert.pem'], check=True, capture_output=True)
der = subprocess.run(['openssl', 'x509', '-in', work / 'cert.pem', '-outform', 'DER'], check=True, capture_output=True).stdout

log = []
# The calendar entry Exchange keeps for the invitation; `ignore` makes the next answer "succeed" without changing it.
state = {'refuse_uid': True, 'answer': 'NoResponseReceived', 'ignore': True}
ANSWERS = {'<t:AcceptItem>': 'Accept', '<t:TentativelyAcceptItem>': 'Tentative', '<t:DeclineItem>': 'Decline'}

class EWS(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
        reply, kind = '', None
        if '<m:FindItem' in body:
            kind = 'FindItem'
            if 'calendar:UID' in body and state['refuse_uid']:
                state['refuse_uid'] = False
                reply = NO_UID
            else:
                reply = VIEW
        elif '<m:GetItem' in body:
            kind = 'GetItem'
            reply = MEETING if 'meeting:AssociatedCalendarItemId' in body else calendar_item(state['answer']) if 'calendar:MyResponseType' in body else BODIES
        elif '<m:CreateItem' in body:
            kind = 'CreateItem'
            reply = SAVED if 'SaveOnly' in body else SENT
            answer = next((a for tag, a in ANSWERS.items() if tag in body), None)
            if answer and state['ignore']: state['ignore'] = False
            elif answer: state['answer'] = answer
        elif '<m:DeleteItem' in body:
            kind = 'DeleteItem'
            reply = DELETED
        if kind:  # anything else is Thunderbird's own sync for the throwaway account
            log.append({'kind': kind, 'authorization': self.headers.get('Authorization'), 'body': body})
        self.send_response(200 if kind else 500)
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
const server = MailServices.accounts.createIncomingServer("merritt@ews.test", "127.0.0.1", "ews");
server.setStringValue("ews_url", `https://127.0.0.1:${port}/EWS/Exchange.asmx`);
server.authMethod = Ci.nsMsgAuthMethod.passwordCleartext;
server.password = "spark-test-password";
server.loginAtStartUp = false; server.doBiff = false;
const account = MailServices.accounts.createAccount();
account.incomingServer = server;
const identity = MailServices.accounts.createIdentity(); identity.email = "merritt@ews.test"; identity.fullName = "Merritt (EWS test)";
account.addIdentity(identity);
const folder = server.rootFolder.addSubfolder("Ember EWS calendar test");
const db = folder.msgDatabase;
const add = (key, subject, id, ewsId) => {
  const hdr = db.createNewHdr(key);
  hdr.subject = subject; hdr.author = "Ada Lovelace <ada@analytical.engineering>"; hdr.date = Date.now() * 1000;
  hdr.messageId = id; hdr.setStringProperty("ewsId", ewsId);
  db.addNewHdrToDB(hdr, true);
};
add(1, "Ember EWS calendar invite", "spark-ews-cal-invite@spark.test", "AAMkInvite");
add(2, "Canceled: Ember EWS calendar invite", "spark-ews-cal-cancel@spark.test", "AAMkCancel");
db.commit(Ci.nsMsgDBCommitType.kLargeCommit);
return {account: account.key, folder: folder.URI};
''', [port, base64.b64encode(der).decode()])
result = {'setup': setup}
try:
    app = '''
const find = async (id) => (await messenger.messages.query({ headerMessageId: id })).messages[0];
const invite = await find("spark-ews-cal-invite@spark.test"), cancel = await find("spark-ews-cal-cancel@spark.test");
const call = (work) => work.catch((e) => ({ error: e.message }));
const c = messenger.sparkCalendar;
return {
  status: await call(c.meetingStatus(invite.id)),
  ignored: await call(c.respond(invite.id, "accept")),
  quiet: await call(c.respond(invite.id, "tentative", { note: "Running <late> & sorry", send: false })),
  noted: await call(c.respond(invite.id, "accept", { note: "See you there" })),
  removed: await call(c.removeFromCalendar(cancel.id)),
  view: await call(c.calendarView("2026-10-28T04:00:00Z", "2026-10-29T04:00:00Z", { details: true })),
  tooLong: await call(c.calendarView("2026-01-01T00:00:00Z", "2026-06-01T00:00:00Z")),
  fromCalendar: await call(c.respondEvent(%s, "EV1", "tentative")),
};'''
    result['app'] = spark.run_in_app(m, app % json.dumps(setup['account']))
    result['requests'] = log
    a = result['app']
    creates = [r['body'] for r in log if r['kind'] == 'CreateItem']
    deletes = [r['body'] for r in log if r['kind'] == 'DeleteItem']
    finds = [r['body'] for r in log if r['kind'] == 'FindItem']
    view = a.get('view') or {}
    ev1 = next((e for e in view.get('events', []) if e.get('id') == 'EV1'), {})
    result['checks'] = {
        'status': a.get('status') == {'response': 'none', 'outOfDate': True, 'onCalendar': True, 'cancelled': False, 'itemClass': 'IPM.Schedule.Meeting.Request'},
        'answers_the_current_version': len(creates) > 0 and '<t:ReferenceItemId Id="AAMkInvite" ChangeKey="CK&amp;7"/>' in creates[0],
        'unrecorded_answer_detected': a.get('ignored') == {'via': 'exchange', 'sent': True, 'code': 'NoError', 'verified': 'none'},
        'status_asks_calendar_item': any('<t:ItemId Id="CAL&amp;1"/>' in r['body'] for r in log if r['kind'] == 'GetItem'),
        'quiet_save_only': len(creates) > 1 and 'MessageDisposition="SaveOnly"' in creates[1] and '<t:TentativelyAcceptItem><t:Body BodyType="Text">Running &lt;late&gt; &amp; sorry</t:Body><t:ReferenceItemId Id="AAMkInvite" ChangeKey="CK&amp;7"/>' in creates[1],
        'quiet_draft_deleted_not_calendar': len(deletes) == 1 and 'Id="DRAFT1"' in deletes[0] and 'CAL' not in deletes[0],
        'quiet_result': a.get('quiet') == {'via': 'exchange', 'sent': False, 'code': 'NoError', 'verified': 'tentative'},
        'noted_sent': len(creates) > 2 and 'MessageDisposition="SendAndSaveCopy"' in creates[2] and '<t:AcceptItem><t:Body BodyType="Text">See you there</t:Body>' in creates[2],
        'noted_verified': (a.get('noted') or {}).get('verified') == 'accept',
        'remove_request': len(creates) > 3 and '<t:RemoveItem><t:ReferenceItemId Id="AAMkCancel" ChangeKey="CK&amp;7"/></t:RemoveItem>' in creates[3],
        'removed_result': a.get('removed') == {'removed': True},
        'view_retried_without_uid': len(finds) == 2 and 'calendar:UID' in finds[0] and 'calendar:UID' not in finds[1] and 'Id="calendar"' in finds[1],
        'view_events': view.get('accounts', 0) >= 1 and len(view.get('events', [])) == 2 and ev1.get('accountId') == setup['account'] and ev1.get('response') == 'accept',
        'view_body_unescaped': '<https://teams.microsoft.com/l/meetup-join/19%3ameeting_x%40thread.v2/0?context=%7b%7d&a=1>' in ev1.get('body', ''),
        'answers_from_calendar_entry': len(creates) > 4 and '<t:TentativelyAcceptItem><t:ReferenceItemId Id="EV1"/></t:TentativelyAcceptItem>' in creates[4] and 'SendAndSaveCopy' in creates[4] and (a.get('fromCalendar') or {}).get('via') == 'exchange',
        'range_limit': 'two months' in (a.get('tooLong') or {}).get('error', ''),
        'basic_auth': all(r['authorization'] == 'Basic ' + base64.b64encode(b'merritt@ews.test:spark-test-password').decode() for r in log),
    }
finally:
    chrome('''
const [key, port] = arguments;
const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const account = MailServices.accounts.getAccount(key);
if (account) MailServices.accounts.removeAccount(account, true);
Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).clearValidityOverride("127.0.0.1", port, {});
return true;''', [setup['account'], port])
    server.shutdown()

(args.output_dir / 'exchange-calendar.json').write_text(json.dumps(result, indent=2))
print(json.dumps({'app': result.get('app'), 'checks': result.get('checks')}, indent=2))
raise SystemExit(0 if result.get('checks') and all(result['checks'].values()) else 1)
