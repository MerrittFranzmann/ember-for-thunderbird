#!/usr/bin/env python3
"""Exchange meeting responses end to end, isolated fixture profile only (port 2831), against a local mock EWS.

Starts a self-signed HTTPS server on 127.0.0.1 that records EWS requests, trusts its certificate in
the test profile, adds a throwaway EWS account (password auth) whose folder holds one meeting-request
header with an `ewsId`, then calls Ember's calendar Experiment from the app: serverResponse(), respond()
for success, and respond() against an ErrorItemNotFound answer. Removes the account and the override
afterwards. Never contacts an external server.
"""
import argparse, base64, http.server, json, os, queue, ssl, subprocess, tempfile, threading
from pathlib import Path
import spark

SUCCESS = '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><m:CreateItemResponse xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"><m:ResponseMessages><m:CreateItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode></m:CreateItemResponseMessage></m:ResponseMessages></m:CreateItemResponse></s:Body></s:Envelope>'
NOT_FOUND = SUCCESS.replace('ResponseClass="Success"><m:ResponseCode>NoError', 'ResponseClass="Error"><m:MessageText>The specified object was not found in the store.</m:MessageText><m:ResponseCode>ErrorItemNotFound')

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)

work = Path(tempfile.mkdtemp(dir=args.output_dir))
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
                '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', work / 'key.pem', '-out', work / 'cert.pem'], check=True, capture_output=True)
der = subprocess.run(['openssl', 'x509', '-in', work / 'cert.pem', '-outform', 'DER'], check=True, capture_output=True).stdout

requests = queue.Queue()
answers = queue.Queue()

class EWS(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
        if 'CreateItem' in body:
            requests.put({'path': self.path, 'authorization': self.headers.get('Authorization'), 'content_type': self.headers.get('Content-Type'), 'body': body})
            reply = answers.get(timeout=5)
            self.send_response(200)
        else:  # Thunderbird's own sync attempts for the throwaway account
            reply = ''
            self.send_response(500)
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
const folder = server.rootFolder.addSubfolder("Ember EWS test");
const db = folder.msgDatabase;
const hdr = db.createNewHdr(1);
hdr.subject = "Invitation: Ember EWS test"; hdr.author = "Ada Lovelace <ada@analytical.engineering>"; hdr.date = Date.now() * 1000;
hdr.messageId = "spark-ews-invite@spark.test";
hdr.setStringProperty("ewsId", "AAMkSparkTest<1>&2");
db.addNewHdrToDB(hdr, true); db.commit(Ci.nsMsgDBCommitType.kLargeCommit);
return {account: account.key, folder: folder.URI};
''', [port, base64.b64encode(der).decode()])
result = {'setup': setup}
try:
    app = '''
const [{ messages: [message] }] = [await messenger.messages.query({ headerMessageId: "spark-ews-invite@spark.test" })];
const out = { found: !!message, server: await messenger.sparkCalendar.serverResponse(message.id) };
out.accept = await messenger.sparkCalendar.respond(message.id, "accept").catch((e) => ({ error: e.message }));
out.notFound = await messenger.sparkCalendar.respond(message.id, "decline").catch((e) => ({ error: e.message }));
return out;'''
    answers.put(SUCCESS)
    answers.put(NOT_FOUND)
    result['app'] = spark.run_in_app(m, app)
    sent = []
    while not requests.empty():
        sent.append(requests.get())
    result['requests'] = sent
    result['checks'] = {
        'exchange_available': result['app'].get('server') is True,
        'accept_ok': {k: (result['app'].get('accept') or {}).get(k) for k in ('via', 'sent', 'code')} == {'via': 'exchange', 'sent': True, 'code': 'NoError'},
        'not_found_message': 'no longer in your Exchange mailbox' in (result['app'].get('notFound') or {}).get('error', ''),
        'path': all(r['path'] == '/EWS/Exchange.asmx' for r in sent),
        'basic_auth': all(r['authorization'] == 'Basic ' + base64.b64encode(b'merritt@ews.test:spark-test-password').decode() for r in sent),
        'accept_request': len(sent) > 0 and '<t:AcceptItem><t:ReferenceItemId Id="AAMkSparkTest&lt;1&gt;&amp;2"/></t:AcceptItem>' in sent[0]['body'] and 'MessageDisposition="SendAndSaveCopy"' in sent[0]['body'],
        'decline_request': len(sent) > 1 and '<t:DeclineItem>' in sent[1]['body'],
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

(args.output_dir / 'exchange-response.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
raise SystemExit(0 if all(result.get('checks', {}).values()) else 1)
