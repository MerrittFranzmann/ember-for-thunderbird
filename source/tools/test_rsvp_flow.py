#!/usr/bin/env python3
"""Calendar responses end to end, isolated fixture profile only (port 2831), via a loopback SMTP sink.

Points the fixture identity (merritt@spark.test) at a local SMTP sink, opens the fixture invitation
(tools/seed_feature_fixtures.py), clicks Accept, and checks the iMIP REPLY that Thunderbird sends.
Restores the identity's outgoing server afterwards. Never contacts an external server.
"""
import argparse, email, json, queue, socketserver, threading
from email import policy
from pathlib import Path
import spark


class Sink(socketserver.StreamRequestHandler):
    def handle(self):
        self.wfile.write(b'220 localhost Ember RSVP test SMTP\r\n')
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
m = spark.connect()
m.execute('''const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const smtp=MailServices.outgoingServer.createServer("smtp").QueryInterface(Ci.nsISmtpServer);smtp.hostname='127.0.0.1';smtp.port=%d;smtp.authMethod=Ci.nsMsgAuthMethod.none;smtp.socketType=Ci.nsMsgSocketType.plain;smtp.description='Ember RSVP loopback';
const identity=MailServices.accounts.getIdentity('id1');window.__sparkRsvp={smtp:smtp.key,previous:identity.smtpServerKey,fcc:identity.doFcc,progress:Services.prefs.getBoolPref('mailnews.show_send_progress',true)};
identity.smtpServerKey=smtp.key;identity.doFcc=false;Services.prefs.setBoolPref('mailnews.show_send_progress',false);return true;''' % server.server_address[1])
try:
    # Replies go through Ember's calendar Experiment (Thunderbird's own sender); no permission needed.
    if not spark.run_in_app(m, "return typeof messenger.sparkCalendar?.sendReply === 'function';"):
        raise SystemExit('The calendar Experiment is not loaded (extensions.experiments.enabled?)')
    ui = spark.run_in_app(m, r'''
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
await messenger.storage.local.remove('rsvpResponses');
const s = 'Spark smoke calendar invitation';
for (let i = 0; i < 400 && !(window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })), await new Promise((r) => setTimeout(r, 200)), document.querySelector('input[aria-label="Search mail (press / )"]')); i++) await pause(50);
const input = (window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })), await new Promise((r) => setTimeout(r, 200)), document.querySelector('input[aria-label="Search mail (press / )"]'));
input.value = s; input.dispatchEvent(new Event('input', { bubbles: true })); input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
for (let i = 0; i < 400 && ![...document.querySelectorAll('.row .subject')].some((n) => n.textContent === s); i++) await pause(20);
[...document.querySelectorAll('.row')].find((n) => n.querySelector('.subject')?.textContent === s).click();
for (let i = 0; i < 400 && !document.querySelector('.rsvp button'); i++) await pause(25);
const before = [...document.querySelectorAll('.rsvp button')].map((b) => b.textContent.trim());
[...document.querySelectorAll('.rsvp button')].find((b) => b.textContent.includes('Accept')).click();
for (let i = 0; i < 400 && !document.querySelector('.toast'); i++) await pause(25);
await pause(500);
return { buttons: before, toast: document.querySelector('.toast')?.textContent.trim(), response: document.querySelector('.calendar-invitation dl')?.innerText.match(/Your response\s+(\w+)/)?.[1], pressed: document.querySelector('.rsvp button[aria-pressed="true"]')?.textContent.trim(), stored: (await messenger.storage.local.get('rsvpResponses')).rsvpResponses };''')
    raw = server.messages.get(timeout=20)
    (args.output_dir / 'rsvp-reply.eml').write_bytes(raw)
    mail = email.message_from_bytes(raw, policy=policy.default)
    structure = [p.get_content_type() for p in mail.walk()]
    parts = [(p.get_content_type(), dict(p.get_params() or []).get('method'), p.get_filename()) for p in mail.walk() if not p.is_multipart()]
    calendar = next((p.get_content() for p in mail.walk() if p.get_content_type() in ('text/calendar', 'application/ics')), '')
    if isinstance(calendar, bytes):
        calendar = calendar.decode()
    inline = next((p for p in mail.walk() if p.get_content_type() == 'text/calendar'), None)
    result = {'ui': ui, 'to': mail['To'], 'from': mail['From'], 'subject': mail['Subject'], 'structure': structure, 'parts': parts,
              'inline_method_reply': bool(inline) and dict(inline.get_params() or []).get('method') == 'REPLY' and inline.get_content_disposition() is None,
              'method': 'METHOD:REPLY' in calendar, 'accepted': 'PARTSTAT=ACCEPTED' in calendar, 'uid': 'UID:spark-board-review@spark-smoke.test' in calendar,
              'attendee': [l for l in calendar.replace('\r\n ', '').splitlines() if l.startswith('ATTENDEE')]}
    (args.output_dir / 'rsvp-result.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))
finally:
    m.execute('''const f=window.__sparkRsvp;if(f){const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');const identity=MailServices.accounts.getIdentity('id1');identity.smtpServerKey=f.previous;identity.doFcc=f.fcc;Services.prefs.setBoolPref('mailnews.show_send_progress',f.progress);MailServices.outgoingServer.deleteServer(MailServices.outgoingServer.getServerByKey(f.smtp));delete window.__sparkRsvp;}return true;''')
    server.shutdown()
    server.server_close()
