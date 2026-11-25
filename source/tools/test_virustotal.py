#!/usr/bin/env python3
"""VirusTotal for attachments, in the isolated fixture profile only (port 2831), against a local mock of VirusTotal's
API (the sparkScan Experiment's test pref; nothing reaches VirusTotal). A fixture email carries three harmless files
the mock calls clean, flagged and unknown. Checks: opening the email looks each one up by its SHA-256 only (no file
sent), the badges and the flagged file's look, opening the flagged file asks first, the unknown file's shield offers
an upload with the warning and only then sends the file, the analysis result shows, answers are kept by
fingerprint, and Settings → Security's Test key. Puts every setting back.

  test_virustotal.py --output-dir DIR
"""
import argparse, base64, hashlib, json, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)

KEY = 'c0ffee' * 10 + 'beef'
FILES = {
    'report-clean.txt': b'Quarterly report: all figures in order.\n',
    'invoice-flagged.bin': b'Ember VirusTotal test: the mock calls this one malicious. Harmless bytes.\n',
    'notes-unknown.pdf': b'%PDF-1.4 Ember VirusTotal test notes (the mock has never seen these)\n',
}
SHA = {name: hashlib.sha256(data).hexdigest() for name, data in FILES.items()}
EICAR = '275a021bbfb6489e54d471899f7db9d1663fc695ec2fe2a2c4538aabf651fd0f'
seen = []  # (method, path, body bytes)

def stats(malicious=0, harmless=0, undetected=0):
    return {'malicious': malicious, 'suspicious': 0, 'harmless': harmless, 'undetected': undetected, 'type-unsupported': 4, 'timeout': 0}

class Mock(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
    def authorized(self):
        if self.headers.get('x-apikey') == KEY: return True
        self.reply(401, {'error': {'code': 'WrongCredentialsError', 'message': 'Wrong API key'}}); return False
    def do_GET(self):
        seen.append(('GET', self.path, b''))
        if not self.authorized(): return
        if self.path.startswith('/files/'):
            sha = self.path.split('/')[-1]
            if sha == SHA['report-clean.txt']: return self.reply(200, {'data': {'attributes': {'last_analysis_stats': stats(harmless=4, undetected=64), 'last_analysis_results': {}}}})
            if sha in (SHA['invoice-flagged.bin'], EICAR):
                results = {f'Engine{i}': {'category': 'malicious', 'result': 'Ember.Test.Flagged' if i < 4 else 'Other.Name'} for i in range(5)}
                return self.reply(200, {'data': {'attributes': {'last_analysis_stats': stats(malicious=5, undetected=63), 'last_analysis_results': results}}})
            return self.reply(404, {'error': {'code': 'NotFoundError', 'message': 'File not found'}})
        if self.path == '/analyses/an-1':
            return self.reply(200, {'data': {'attributes': {'status': 'completed', 'stats': stats(harmless=2, undetected=66), 'results': {}}}, 'meta': {'file_info': {'sha256': SHA['notes-unknown.pdf']}}})
        self.reply(404, {})
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length') or 0))
        seen.append(('POST', self.path, body))
        if not self.authorized(): return
        if self.path == '/files': return self.reply(200, {'data': {'type': 'analysis', 'id': 'an-1'}})
        self.reply(404, {})

server = ThreadingHTTPServer(('127.0.0.1', 0), Mock)
threading.Thread(target=server.serve_forever, daemon=True).start()
ENDPOINT = 'http://127.0.0.1:%d' % server.server_address[1]

m = spark.connect()
SUBJECT = 'VirusTotal fixture %d' % time.time()
parts = []
for name, data in FILES.items():
    parts += ['--B', f'Content-Type: application/octet-stream; name="{name}"', f'Content-Disposition: attachment; filename="{name}"', 'Content-Transfer-Encoding: base64', '', base64.b64encode(data).decode(), '']
raw = '\r\n'.join(['From: Ada Lovelace <ada@analytical.test>', 'To: merritt@spark.test', f'Subject: {SUBJECT}', 'Date: ' + time.strftime('%a, %d %b %Y %H:%M:%S +0000', time.gmtime()),
                   f'Message-ID: <vt-{int(time.time())}@spark.test>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B"', 'X-Mozilla-Status: 0001', '',
                   '--B', 'Content-Type: text/plain; charset=utf-8', '', 'Three files for you.', ''] + parts + ['--B--', ''])
m.execute("""const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const f=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder);
f.addMessage(%s); Services.prefs.setStringPref('extensions.spark.virustotalEndpoint', %s); return 1;""" % (json.dumps(raw), json.dumps(ENDPOINT)))

saved = spark.run_in_app(m, "return await messenger.storage.local.get(['virusTotalKey', 'virusTotalAuto', 'virusTotalResults']);")

HELPERS = r'''
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms = 20000) => { for (let t = 0; t < ms; t += 150) { const v = test(); if (v) return v; await pause(150); } return test(); };
const att = (name) => [...document.querySelectorAll('.reader .att')].find((li) => li.querySelector('.att-name')?.textContent.trim() === name);
const badge = (name) => att(name)?.querySelector('.scan-badge')?.textContent.trim() || null;
const shield = (name) => att(name)?.querySelector('button.scan');
'''

def page(body):
    r = spark.run_in_app(m, HELPERS + body)
    if isinstance(r, str) and r.startswith('ERROR'): raise RuntimeError(r)
    return r

result = {}
try:
    page("await messenger.storage.local.set({ virusTotalKey: %s, virusTotalAuto: true, virusTotalResults: {} }); await pause(500); return 1;" % json.dumps(KEY))
    # Open the email: each file is looked up by its fingerprint.
    result['badges'] = page(r'''
document.querySelector('.sidebar .item')?.click(); await pause(800);
const row = await until(() => [...document.querySelectorAll('.row')].find((r) => r.querySelector('.subject')?.textContent === %s), 30000);
row.click();
await until(() => att('report-clean.txt') && badge('report-clean.txt') === 'Clean' && badge('invoice-flagged.bin')?.startsWith('Flagged') && badge('notes-unknown.pdf') === 'Not scanned', 30000);
return { clean: badge('report-clean.txt'), cleanTitle: shield('report-clean.txt')?.title, flagged: badge('invoice-flagged.bin'), flaggedTitle: shield('invoice-flagged.bin')?.title,
  flaggedChip: att('invoice-flagged.bin')?.classList.contains('flagged'), unknown: badge('notes-unknown.pdf') };''' % json.dumps(SUBJECT))
    result['lookups'] = sorted(p for meth, p, body in seen if meth == 'GET')
    result['posted_before_upload'] = sum(1 for meth, *_ in seen if meth == 'POST')

    # Opening the flagged file asks first (cancelled: nothing opens).
    result['open_flagged'] = page(r'''
att('invoice-flagged.bin').querySelector('button[aria-label^="Open "]').click();
const ask = await until(() => document.querySelector('.reader .scan-ask.danger'), 3000);
const out = { asked: !!ask, text: ask?.querySelector('p')?.textContent.trim(), buttons: [...(ask?.querySelectorAll('button') || [])].map((b) => b.textContent.trim()) };
[...ask.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel').click(); await pause(200);
out.cancelled = !document.querySelector('.reader .scan-ask.danger');
return out;''')

    # The unknown file: its shield offers an upload with the warning; Upload sends it and the analysis shows.
    result['upload'] = page(r'''
shield('notes-unknown.pdf').click();
const ask = await until(() => document.querySelector('.reader .scan-ask:not(.danger)'), 3000);
const out = { warning: ask?.querySelector('p')?.textContent.trim() };
[...ask.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Upload').click();
out.during = await until(() => ['Uploading…', 'Scanning…'].includes(badge('notes-unknown.pdf')) && badge('notes-unknown.pdf'), 5000);
return out;''')
    # The analysis is polled within the free key's 4 a minute (3 lookups + the upload came first): up to ~90 s.
    for _ in range(60):
        result['upload']['after'] = page("return badge('notes-unknown.pdf');")
        if result['upload']['after'] not in ('Uploading…', 'Scanning…'): break
        time.sleep(2)
    posts = [(p, body) for meth, p, body in seen if meth == 'POST']
    result['upload_posts'] = [p for p, _ in posts]
    result['upload_carried_file'] = bool(posts) and FILES['notes-unknown.pdf'] in posts[0][1] and b'notes-unknown.pdf' in posts[0][1]
    result['other_files_never_sent'] = not any(FILES[n] in body for _, _, body in seen for n in ('report-clean.txt', 'invoice-flagged.bin'))
    spark.app_shot(m, args.output_dir / 'virustotal.png')

    # Kept by fingerprint: reopening asks VirusTotal nothing new.
    before = len(seen)
    result['kept'] = page(r'''
await pause(1500);
const kept = (await messenger.storage.local.get('virusTotalResults')).virusTotalResults || {};
return Object.fromEntries(Object.entries(kept).map(([sha, r]) => [sha, r.status]));''')
    result['kept_expected'] = {SHA['report-clean.txt']: 'clean', SHA['invoice-flagged.bin']: 'flagged', SHA['notes-unknown.pdf']: 'clean'}

    # Settings → Security: Test key (the EICAR fingerprint), then a key the mock refuses.
    spark.open_settings(m, 'security', 'Check attachments with VirusTotal')
    result['settings_good'] = spark.in_settings(m, spark.SETTING_ITEM + r'''
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const card = item('Check attachments with VirusTotal').closest('.item');
[...card.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Test key').click();
for (let i = 0; i < 60 && !card.querySelector('.note'); i++) await pause(150);
return card.querySelector('.note')?.textContent.trim() || null;''')
    page("await messenger.storage.local.set({ virusTotalKey: %s }); return 1;" % json.dumps('ab' * 32))
    result['settings_bad'] = spark.in_settings(m, spark.SETTING_ITEM + r'''
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
await pause(600);
const card = item('Check attachments with VirusTotal').closest('.item');
[...card.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Test key').click();
for (let i = 0; i < 60 && !card.querySelector('.note.bad'); i++) await pause(150);
return card.querySelector('.note')?.textContent.trim() || null;''')
    result['settings_items'] = spark.in_settings(m, "return [...document.querySelectorAll('.card .item b')].map((b) => b.textContent.trim());")
    spark.close_settings(m)
    result['reopen_requests'] = [p for meth, p, _ in seen[before:] if meth == 'GET' and p.startswith('/files/') and p.split('/')[-1] != EICAR]
finally:
    try:
        page("await messenger.storage.local.set(%s); return 1;" % json.dumps({'virusTotalKey': saved.get('virusTotalKey', ''), 'virusTotalAuto': saved.get('virusTotalAuto', True), 'virusTotalResults': saved.get('virusTotalResults', {})}))
    finally:
        m.execute("Services.prefs.clearUserPref('extensions.spark.virustotalEndpoint'); return 1;")
        spark._end_session(m)
        server.shutdown()

r = result
b = r.get('badges', {})
checks = {
    'lookups_by_hash_only': r.get('lookups') == sorted('/files/' + SHA[n] for n in FILES) and r.get('posted_before_upload') == 0,
    'badges': b.get('clean') == 'Clean' and b.get('flagged') == 'Flagged 5/68' and b.get('unknown') == 'Not scanned' and b.get('flaggedChip') is True,
    'details': '0 of 68' in (b.get('cleanTitle') or '') and 'Ember.Test.Flagged' in (b.get('flaggedTitle') or ''),
    'flagged_asks_before_open': r.get('open_flagged', {}).get('asked') is True and 'Open anyway' in r['open_flagged'].get('buttons', []) and r['open_flagged'].get('cancelled') is True,
    'upload_warns_first': "don't upload anything confidential" in (r.get('upload', {}).get('warning') or ''),
    'upload_sends_that_file_only': r.get('upload_posts') == ['/files'] and r.get('upload_carried_file') is True and r.get('other_files_never_sent') is True,
    'upload_result': r.get('upload', {}).get('during') in ('Uploading…', 'Scanning…') and r.get('upload', {}).get('after') == 'Clean',
    'kept_by_fingerprint': r.get('kept') == r.get('kept_expected'),
    'settings_test_key': (r.get('settings_good') or '').startswith('Works') and "didn't accept" in (r.get('settings_bad') or ''),
    'settings_items': all(t in r.get('settings_items', []) for t in ('Check attachments with VirusTotal', 'Check attachments when an email opens', 'Uploading a file to VirusTotal')),
}
result['checks'] = checks
(args.output_dir / 'virustotal.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
print('ALL PASS' if all(checks.values()) else 'FAIL: ' + ', '.join(k for k, v in checks.items() if not v))
raise SystemExit(0 if all(checks.values()) else 1)
