#!/usr/bin/env python3
"""RAM and CPU figures for the public install page (Performance). A brand-new Thunderbird profile
(tools/fresh_profile.py: nothing reaches the internet) with one account and an inbox of N synthetic emails over the
last 90 days, measured three ways, each after it has settled:
  1. Thunderbird alone (its own window open, Ember not installed);
  2. Ember installed and open (Ember-only mode: Thunderbird's window hidden), after its saved-mail cache is filled;
  3. Ember minimized.
Memory: macOS physical footprint (Activity Monitor's "Memory") summed over Thunderbird and its child processes.
CPU: processor time all of them used during a 60 s idle window, as a share of one core.
Writes JSON with the machine, versions and every sample.

  measure_public_perf.py --output FILE [--emails 2000] [--xpi XPI]
"""
import argparse, json, os, platform, re, subprocess, sys, time
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fresh_profile as fp

parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
parser.add_argument('--emails', type=int, default=2000)
parser.add_argument('--xpi')
parser.add_argument('--idle', type=int, default=60)
args = parser.parse_args()
PROJECT = os.path.dirname(HERE)
version = json.load(open(os.path.join(PROJECT, 'public', 'manifest.json')))['version']
xpi = args.xpi or os.path.join(PROJECT, f'thunderbird-spark-{version}.xpi')

def tree():
    roots = fp.pids()
    out, todo = set(roots), list(roots)
    while todo:
        kids = subprocess.run(['pgrep', '-P', str(todo.pop())], capture_output=True, text=True).stdout.split()
        for k in map(int, kids):
            if k not in out: out.add(k); todo.append(k)
    return sorted(out)

def footprint_mb(pids):
    total = 0.0
    for pid in pids:
        text = subprocess.run(['footprint', '-p', str(pid)], capture_output=True, text=True).stdout
        hit = re.search(r'Footprint:\s*([\d.]+)\s*(KB|MB|GB)', text)
        if hit: total += float(hit.group(1)) * {'KB': 1 / 1024, 'MB': 1, 'GB': 1024}[hit.group(2)]
    return round(total, 1)

def cpu_seconds(pids):
    out = subprocess.run(['ps', '-o', 'pid=,time=', '-p', ','.join(map(str, pids))], capture_output=True, text=True).stdout
    total = {}
    for line in out.strip().splitlines():
        pid, t = line.split()
        parts = [float(p) for p in t.replace('-', ':').split(':')]
        secs = 0.0
        for p in parts: secs = secs * 60 + p
        total[int(pid)] = secs
    return total

def measure(label):
    pids = tree()
    before = cpu_seconds(pids)
    time.sleep(args.idle)
    after = cpu_seconds(pids)
    used = sum(after[p] - before[p] for p in before if p in after)
    sample = {'label': label, 'processes': len(pids), 'memory_mb': footprint_mb(tree()), 'cpu_percent': round(100 * used / args.idle, 2), 'idle_seconds': args.idle}
    print(json.dumps(sample), flush=True)
    return sample

m = None
def x(script, values=()):
    reply = m._cmd("WebDriver:ExecuteScript", {"script": f"return (async () => {{ {script} }})();", "args": list(values)})
    return reply.get("value") if isinstance(reply, dict) else reply

result = {'machine': {'model': subprocess.run(['sysctl', '-n', 'hw.model'], capture_output=True, text=True).stdout.strip(),
                      'cpu': subprocess.run(['sysctl', '-n', 'machdep.cpu.brand_string'], capture_output=True, text=True).stdout.strip(),
                      'memory_gb': int(subprocess.run(['sysctl', '-n', 'hw.memsize'], capture_output=True, text=True).stdout) // 2**30,
                      'macos': platform.mac_ver()[0]},
          'emails': args.emails, 'ember': version, 'when': datetime.now().isoformat(timespec='minutes'), 'samples': []}
try:
    fp.create(feed_url='off')
    m = fp.launch()
    import spark
    result['thunderbird'] = x("return Services.appinfo.version;")
    # One account with N emails spread over 90 days (a few senders, newsletters and notifications among them).
    now = datetime.now(timezone.utc)
    senders = [('Priya Shah', 'priya@northwind.example'), ('Dana Whitfield', 'dana@northwind.example'), ('Marcus Lee', 'marcus@northwind.example'),
               ('The Weekly Brief', 'news@weeklybrief.example'), ('Northwind Builds', 'noreply@builds.northwind.example'), ('Sofia Reyes', 'sofia@northwind.example')]
    raws = []
    for i in range(args.emails):
        who = senders[i % len(senders)]
        date = (now - timedelta(minutes=i * (90 * 24 * 60 // args.emails))).strftime('%a, %d %b %Y %H:%M:%S +0000')
        body = ('Hi Alex,\r\n\r\n' + 'Here is the update on item %d. ' % i * 12 + '\r\n\r\nThanks,\r\n' + who[0].split()[0])
        extra = 'List-Unsubscribe: <mailto:u@weeklybrief.example>\r\n' if 'news@' in who[1] else ''
        raws.append(f'From: {who[0]} <{who[1]}>\r\nTo: Alex Morgan <alex@northwind.example>\r\nSubject: Update {i}: planning notes\r\nDate: {date}\r\nMessage-ID: <perf-{i}@northwind.example>\r\n{extra}MIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n{body}\r\n')
    x('''const [messages] = arguments;
const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const server = MailServices.accounts.createIncomingServer('alex', '127.0.0.1', 'pop3');
server.port = 1; server.loginAtStartUp = false; server.doBiff = false; server.prettyName = 'Northwind';
const account = MailServices.accounts.createAccount(); account.incomingServer = server;
const identity = MailServices.accounts.createIdentity(); identity.email = 'alex@northwind.example'; identity.fullName = 'Alex Morgan'; account.addIdentity(identity);
let inbox = null; try { inbox = server.rootFolder.getChildNamed('Inbox'); } catch {}
inbox ||= server.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder).createLocalSubfolder('Inbox');
inbox.setFlag(Ci.nsMsgFolderFlags.Inbox);
for (const raw of messages) inbox.QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage(raw);
for (const w of Services.wm.getEnumerator('mail:3pane')) { w.moveTo(2560, 60); w.resizeTo(1440, 900); }
return inbox.getTotalMessages(false);''', [raws])
    # Thunderbird alone: its window on the inbox.
    x("const w = Services.wm.getMostRecentWindow('mail:3pane'); const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs'); const inbox = MailServices.accounts.accounts.find((a) => a.incomingServer.type === 'pop3').incomingServer.rootFolder.getChildNamed('Inbox'); w.gTabmail.currentAbout3Pane.displayFolder(inbox); return 1;")
    # Settled: Thunderbird's search index has caught up with the new mail (it indexes in the background).
    for _ in range(120):
        time.sleep(5)
        if not x("const {GlodaIndexer} = ChromeUtils.importESModule('resource:///modules/gloda/GlodaIndexer.sys.mjs'); return GlodaIndexer.indexing;"): break
    time.sleep(30)
    result['samples'].append(measure('Thunderbird alone'))
    # Ember: install, let it fill its saved-mail cache, then measure.
    m._cmd('Addon:Install', {'path': os.path.abspath(xpi), 'temporary': False})
    time.sleep(8)
    x("for (const w of Services.wm.getEnumerator('mail:extensionPopup')) { w.moveTo(2560, 60); w.resizeTo(1440, 900); } return 1;")
    for _ in range(120):
        status = spark.run_in_app(m, "const {cacheStatus} = await messenger.storage.local.get('cacheStatus'); return JSON.stringify(cacheStatus || {});")
        try: s = json.loads(status)
        except Exception: s = {}
        if s.get('phase') == 'ready' or (s.get('phase') == 'idle' and s.get('lastCompletedAt')): break
        time.sleep(5)
    result['cache'] = s
    time.sleep(45)
    result['samples'].append(measure('Ember open'))
    x("for (const w of Services.wm.getEnumerator('mail:extensionPopup')) w.minimize(); return 1;")
    time.sleep(30)
    result['samples'].append(measure('Ember minimized'))
finally:
    fp.remove()
open(args.output, 'w').write(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
