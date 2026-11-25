#!/usr/bin/env python3
"""What someone who downloads Ember gets: a brand-new Thunderbird profile (tools/fresh_profile.py: no accounts,
none of the fixture profile's prefs, nothing reaches the internet) installs the release XPI.

Checks:
- it installs and runs with Thunderbird's own defaults (no signing or Experiment prefs set by hand), opens Ember's
  window by itself and hides Thunderbird's;
- with no mail account, Ember shows its welcome; "Add an email account" shows Thunderbird's window with its
  account setup; once an account with mail exists, the welcome goes and the inbox shows that mail;
- AI agents: turning them on puts ember-mcp.mjs beside the (test) socket, and that server answers ember_status;
- updates, against a local mock of GitHub's releases (latest.json, the XPI behind a redirect): a release that
  isn't signed with the publisher's key is refused; a signed 1.0.x+1 downloads, checks out and installs.
Everything is removed afterwards (profile, socket, server copy, mock).

  test_fresh_install.py --output-dir DIR [--xpi XPI]
"""
import argparse, base64, hashlib, http.server, io, json, os, ssl, subprocess, sys, tempfile, threading, time, zipfile
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fresh_profile as fp
import publish_update

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
parser.add_argument('--xpi')
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
PROJECT = os.path.dirname(HERE)
version = json.load(open(os.path.join(PROJECT, 'public', 'manifest.json')))['version']
xpi = args.xpi or os.path.join(PROJECT, f'thunderbird-spark-{version}.xpi')
parts = version.split('.')
next_version = '.'.join(parts[:-1] + [str(int(parts[-1]) + 1)])

# The next release: the same build, its manifest saying next_version.
def rebuilt(src, new_version):
    out = io.BytesIO()
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == 'manifest.json':
                manifest = json.loads(data); manifest['version'] = new_version; data = json.dumps(manifest, indent=2).encode()
            zout.writestr(item, data)
    return out.getvalue()
next_xpi = rebuilt(xpi, next_version)
next_sha = hashlib.sha256(next_xpi).hexdigest()

# ---- A mock of GitHub's releases (HTTPS on 127.0.0.1; the XPI behind a redirect, as GitHub serves it) ----
work = Path(tempfile.mkdtemp(dir=args.output_dir))
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
                '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', work / 'key.pem', '-out', work / 'cert.pem'], check=True, capture_output=True)
der = subprocess.run(['openssl', 'x509', '-in', work / 'cert.pem', '-outform', 'DER'], check=True, capture_output=True).stdout
served = {'feed': None, 'hits': []}
class GitHub(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        served['hits'].append(self.path)
        if self.path.endswith('/releases/latest/download/latest.json'):
            if served['feed'] is None:
                self.send_response(404); self.end_headers(); return
            body = json.dumps(served['feed']).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(body); return
        if self.path.endswith(f'/releases/download/v{next_version}/ember-{next_version}.xpi'):
            self.send_response(302); self.send_header('Location', f'/objects/ember-{next_version}.xpi'); self.end_headers(); return
        if self.path == f'/objects/ember-{next_version}.xpi':
            self.send_response(200); self.send_header('Content-Type', 'application/octet-stream'); self.end_headers(); self.wfile.write(next_xpi); return
        self.send_response(404); self.end_headers()
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), GitHub)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER); context.load_cert_chain(work / 'cert.pem', work / 'key.pem')
server.socket = context.wrap_socket(server.socket, server_side=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
port = server.server_address[1]
RELEASES = f'https://127.0.0.1:{port}/MerrittFranzmann/ember-for-thunderbird/releases/'
FEED = f'{RELEASES}latest/download/latest.json'
def feed_for(signature_of):
    feed = {'version': next_version, 'url': f'{RELEASES}download/v{next_version}/ember-{next_version}.xpi', 'sha256': next_sha, 'notes': f'{RELEASES}tag/v{next_version}'}
    feed['signature'] = publish_update.sign(*signature_of)
    return feed

def x(script, values=()):
    """Run chrome JS (async allowed) in the fresh Thunderbird."""
    reply = m._cmd("WebDriver:ExecuteScript", {"script": f"return (async () => {{ {script} }})();", "args": list(values)})
    return reply.get("value") if isinstance(reply, dict) else reply

result, checks = {}, {}
m = None
mcp_copy = os.path.join(os.path.dirname(fp.SOCKET), 'ember-mcp.mjs')
try:
    fp.create(feed_url=FEED)
    m = fp.launch()
    import spark
    x('''const [port, der] = arguments;
const cert = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB).constructX509FromBase64(der);
Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).rememberValidityOverride("127.0.0.1", port, {}, cert, false);
return 1;''', [port, base64.b64encode(der).decode()])
    result['install'] = m._cmd('Addon:Install', {'path': os.path.abspath(xpi), 'temporary': False})
    for _ in range(80):
        if x("return [...Services.wm.getEnumerator('mail:extensionPopup')].some(w => w.document.querySelector('browser')?.currentURI?.spec.endsWith('/app.html'))"): break
        time.sleep(0.25)
    # Out of the user's way: the second display.
    x("for (const w of Services.wm.getEnumerator(null)) { try { w.moveTo(2560, 60); } catch {} } return 1;")
    time.sleep(4)
    result['state'] = x('''const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
const a = await AddonManager.getAddonByID('thunderbird-spark@merrittfranzmann');
const ember = [...Services.wm.getEnumerator('mail:extensionPopup')].find(w => w.document.querySelector('browser')?.currentURI?.spec.endsWith('/app.html'));
const mains = [...Services.wm.getEnumerator('mail:3pane')];
return { version: a?.version, active: a?.isActive, name: a?.name, userSet: ['xpinstall.signatures.required', 'extensions.experiments.enabled'].filter(p => Services.prefs.prefHasUserValue(p)),
  title: ember?.document.title };''')
    result['window'] = spark.run_in_app(m, "return await messenger.sparkWindow.state();")
    st = result['state']
    checks['installs_with_defaults'] = st['version'] == version and st['active'] and st['name'] == 'Ember for Thunderbird' and st['userSet'] == []
    checks['opens_ember_only'] = st['title'] == 'Ember' and result['window'].get('sparkOnly') is True and result['window'].get('mainVisible') is False

    # Welcome, and Thunderbird's account setup.
    result['welcome'] = spark.run_in_app(m, r'''const until = async (f, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { const v = f(); if (v) return v; await new Promise(r => setTimeout(r, 100)); } return f(); };
await until(() => document.querySelector('.welcome'));
document.documentElement.dataset.theme = 'light';
const w = document.querySelector('.welcome');
return { title: w?.querySelector('h1')?.textContent.trim(), button: w?.querySelector('button')?.textContent.trim() };''')
    spark.app_shot(m, str(args.output_dir / 'fresh-welcome.png'))
    spark.run_in_app(m, "document.querySelector('.welcome button').click(); await new Promise(r => setTimeout(r, 2500)); return 1;")
    result['windowAfterClick'] = spark.run_in_app(m, "return await messenger.sparkWindow.state();")
    result['setup'] = x('''const w = Services.wm.getMostRecentWindow('mail:3pane');
const shown = !!w.docShell?.treeOwner?.QueryInterface(Ci.nsIBaseWindow).visibility;
const hub = [...w.document.querySelectorAll('*')].filter(e => /account-?hub/i.test(e.localName + ' ' + e.id) && (e.open || e.getBoundingClientRect().width > 0)).map(e => e.localName + '#' + e.id);
return { shown, hub, state: null };''')
    result['afterClick'] = spark.run_in_app(m, "return document.querySelector('.welcome .next')?.textContent.trim() || null;")
    checks['welcome_opens_account_setup'] = result['welcome'] == {'title': 'Welcome to Ember', 'button': 'Add an email account'} and result['windowAfterClick'].get('mainVisible') is True and len(result['setup']['hub']) >= 1 and bool(result['afterClick'])
    # The user sets an account up (here: made directly, with one email in its Inbox; no server is contacted).
    x('''const w = Services.wm.getMostRecentWindow('mail:3pane');
for (const d of w.document.querySelectorAll('dialog')) if (d.open) d.close();
for (const e of w.document.querySelectorAll('*')) if (/account-?hub/i.test(e.localName + ' ' + e.id) && typeof e.close === 'function' && e.open) e.close();
const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const server = MailServices.accounts.createIncomingServer('new.user', '127.0.0.1', 'pop3');
server.port = 1; server.loginAtStartUp = false; server.doBiff = false; server.prettyName = 'new.user@fresh.test';
const account = MailServices.accounts.createAccount(); account.incomingServer = server;
const identity = MailServices.accounts.createIdentity(); identity.email = 'new.user@fresh.test'; identity.fullName = 'New User'; account.addIdentity(identity);
const root = server.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder);
let inbox; try { inbox = server.rootFolder.getChildNamed('Inbox'); } catch { inbox = root.createLocalSubfolder('Inbox'); }
inbox.setFlag(Ci.nsMsgFolderFlags.Inbox);
const date = new Date().toUTCString();
inbox.QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage(`From - ${date}\\r\\nFrom: Dana Whitfield <dana@fresh.test>\\r\\nTo: New User <new.user@fresh.test>\\r\\nSubject: Welcome aboard\\r\\nDate: ${date}\\r\\nMessage-ID: <welcome@fresh.test>\\r\\nContent-Type: text/plain; charset=UTF-8\\r\\n\\r\\nGlad you're here.\\r\\n`);
return 1;''')
    result['inbox'] = spark.run_in_app(m, r'''const until = async (f, ms = 15000) => { for (let i = 0; i < ms / 200; i++) { const v = f(); if (v) return v; await new Promise(r => setTimeout(r, 200)); } return f(); };
await until(() => !document.querySelector('.welcome'));
const row = await until(() => [...document.querySelectorAll('[role="option"]')].find(r => r.textContent.includes('Welcome aboard')), 20000);
return { welcomeGone: !document.querySelector('.welcome'), row: !!row };''')
    x("for (const w of Services.wm.getEnumerator(null)) { try { w.moveTo(2560, 60); } catch {} } return 1;")
    spark.app_shot(m, str(args.output_dir / 'fresh-inbox.png'))
    checks['account_appears'] = result['inbox'] == {'welcomeGone': True, 'row': True}

    # AI agents: the server installs itself and answers.
    spark.run_in_app(m, "await messenger.storage.local.set({ agentAccess: true }); await new Promise(r => setTimeout(r, 3000)); return 1;")
    result['mcpFile'] = os.path.exists(mcp_copy)
    if result['mcpFile']:
        requests = '\n'.join(json.dumps(r) for r in [
            {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'fresh-test', 'version': '1'}}},
            {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
            {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/call', 'params': {'name': 'ember_status', 'arguments': {}}}]) + '\n'
        proc = subprocess.Popen(['node', mcp_copy], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env={**os.environ, 'SPARK_AGENT_SOCKET': fp.SOCKET})
        proc.stdin.write(requests); proc.stdin.flush()
        answer = None
        for _ in range(3):
            line = proc.stdout.readline()
            if '"id":2' in line.replace(' ', ''): answer = json.loads(line); break
        proc.kill()
        status = json.loads(answer['result']['content'][0]['text']) if answer and 'result' in answer else answer
        result['mcp'] = status
    checks['agents_work'] = result['mcpFile'] and isinstance(result.get('mcp'), dict) and result['mcp'].get('ember') == version

    # Updates: an unsigned release is refused; a signed one installs.
    served['feed'] = feed_for((next_version, 'f' * 64))  # signed, but for another file
    result['tampered'] = spark.run_in_app(m, "return await messenger.runtime.sendMessage({type: 'spark:update', install: 'now'});")
    time.sleep(2)
    result['afterTampered'] = x("const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs'); return (await AddonManager.getAddonByID('thunderbird-spark@merrittfranzmann')).version;")
    checks['unsigned_release_refused'] = result['afterTampered'] == version and "isn't signed" in json.dumps(result['tampered'])
    served['feed'] = feed_for((next_version, next_sha))
    try:
        result['update'] = spark.run_in_app(m, "return await messenger.runtime.sendMessage({type: 'spark:update', install: 'now'});")
    except Exception as error:
        result['update'] = f'(page restarted: {error})'
    for _ in range(60):
        time.sleep(0.5)
        now = x("const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs'); const a = await AddonManager.getAddonByID('thunderbird-spark@merrittfranzmann'); return [a.version, a.isActive];")
        if now[0] == next_version: break
    result['afterUpdate'] = now
    checks['signed_update_installs'] = now == [next_version, True] and any(h.startswith('/objects/') for h in served['hits'])
    result['hits'] = served['hits']
finally:
    fp.remove()
    for path in (mcp_copy,):
        if os.path.exists(path): os.remove(path)
    server.shutdown()
    subprocess.run(['rm', '-rf', str(work)])

result['checks'] = checks
(args.output_dir / 'fresh-install.json').write_text(json.dumps(result, indent=2, default=str))
print(json.dumps(checks, indent=2))
raise SystemExit(0 if checks and all(checks.values()) and len(checks) == 7 else 1)
