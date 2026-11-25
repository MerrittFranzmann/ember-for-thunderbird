#!/usr/bin/env python3
"""Screenshots for the public install page (release/screenshots). A brand-new Thunderbird profile
(tools/fresh_profile.py: nothing reaches the internet) with Ember installed, a fictional inbox (Alex Morgan at
Northwind, reserved .example addresses), a mock Exchange calendar with colleagues' calendars (tools/ews_mock.py) and
a staged Claude Code session through Ember's own MCP server. Each capture is Ember's window (or Thunderbird's, for
the reading comparison) framed as a macOS window. The profile and the mock are removed afterwards.

  make_screenshots.py --output-dir DIR [--xpi XPI] [--scale 2] [--raw-dir DIR]
--raw-dir also keeps each Ember capture unframed (the video's source); --scale sets the pixels per point.
"""
import argparse, base64, json, os, subprocess, sys, tempfile, time
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fresh_profile as fp
from ews_mock import EwsMock

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
parser.add_argument('--xpi')
parser.add_argument('--scale', type=float, default=2)
parser.add_argument('--raw-dir', type=Path)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
PROJECT = os.path.dirname(HERE)
version = json.load(open(os.path.join(PROJECT, 'public', 'manifest.json')))['version']
xpi = args.xpi or os.path.join(PROJECT, f'thunderbird-spark-{version}.xpi')

ME = ('Alex Morgan', 'alex@northwind.example')
PRIYA = ('Priya Shah', 'priya@northwind.example')
DANA = ('Dana Whitfield', 'dana@northwind.example')
MARCUS = ('Marcus Lee', 'marcus@northwind.example')
now = datetime.now(timezone.utc)
midnight = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
at = lambda h, m=0, day=0: (midnight + timedelta(days=day, hours=h, minutes=m)).astimezone(timezone.utc)
b64 = lambda data: base64.b64encode(data).decode()
PDF = b64(b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj 4 0 obj<</Length 60>>stream\nBT /F1 28 Tf 72 700 Td (Northwind press release) Tj ET\nendstream endobj 5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF")
OFFICE = b64(b'PK\x03\x04' + bytes(400))

# The email for the reading comparison: what Outlook sends (tiny mixed fonts, colours, spacer paragraphs).
OUTLOOK = """<html><head><style>p{margin:0 0 6px}</style></head><body style="background:#fff">
<div style="font-family:'Comic Sans MS',cursive;font-size:17pt;color:#6b6b6b">Hi Alex,</div>
<p style="font-family:'Times New Roman',serif;font-size:8pt;color:#a3a3a3;line-height:1.0">Thanks for sending the new site over &#8211; the team <b>really</b> likes the navigation, and the new pricing page reads much more clearly than before.</p>
<p style="font-family:'Courier New',monospace;font-size:14pt;color:#3a3a3a;line-height:1.1">Two small notes:</p>
<ol style="font-family:Georgia,serif;font-size:7pt;color:#b5b5b5;line-height:1.0"><li>The &#8220;Compare plans&#8221; table is hard to read on a phone.</li><li>Could the FAQ open with billing questions?</li></ol>
<p style="font-family:Verdana,sans-serif;font-size:19pt;color:#808080;line-height:0.95">Happy to jump on a call Thursday if that's easier.</p>
<p style="font-family:Arial,sans-serif;font-size:9pt;color:#d0021b"><b>We need the final version by Friday noon.</b></p>
<p style="font-family:'Brush Script MT',cursive;font-size:26pt;color:#4f4f4f;line-height:1">Hannah</p>
<div style="font-family:'Arial Narrow',Arial,sans-serif;font-size:7pt;color:#ababab">Head of Digital | ClientCo | T: +1 (555) 010-4477 | <a href="https://clientco.example">clientco.example</a></div>
<div style="font-family:Tahoma,sans-serif;font-size:6pt;color:#c4c4c4">CONFIDENTIALITY NOTICE: This e-mail and any attachments are for the sole use of the intended recipient(s).</div>
</body></html>"""

# (hours ago, from, subject, body (text, or ('html', text, html)), extra headers, id, in reply to, attachments)
MAIL = [
    (0.4, PRIYA, 'Venue shortlist for the spring offsite',
     "Hi Alex,\n\nI've narrowed it down to three: Lakeside Lodge, the Harbor Loft and Cedar Hall.\n\nLakeside has the best breakout rooms and the lake walk; the Harbor Loft is ten minutes from the airport; Cedar Hall is the cheapest by a mile but needs its own catering.\n\nCould we pick one by Thursday? I'll hold the dates until then.\n\nThanks,\nPriya", {}, 'venue', None, []),
    (0.9, DANA, 'Re: Q3 budget review',
     "Thanks Marcus, this is clear. Two questions before Friday:\n\n1. Can we move the travel line into Q4?\n2. Is the design contractor still at the old rate?\n\nAlex, could you add the offsite estimate?\n\nDana", {}, 'budget2', 'budget1', []),
    (1.4, ('Northwind Builds', 'noreply@builds.northwind.example'), 'Build passed: website main #482',
     "All 312 checks passed in 4m 12s.\n\nDeployed to staging.", {'Auto-Submitted': 'auto-generated'}, 'build', None, []),
    (1.6, MARCUS, 'Draft press release: can you take a look?',
     "Hi Alex,\n\nHere's the draft for the launch announcement. The quote from Olivia is still a placeholder.\n\nAny edits by tomorrow noon would be great.\n\nMarcus", {}, 'press', None, [('press-release-draft.pdf', 'application/pdf', PDF)]),
    (2.6, ('The Weekly Brief', 'news@weeklybrief.example'), 'Five ideas for calmer mornings',
     "This week: why your first hour matters, a 10-minute planning ritual, and the case for a later inbox.", {'List-Unsubscribe': '<mailto:unsubscribe@weeklybrief.example>', 'List-Id': '<brief.weeklybrief.example>'}, 'brief', None, []),
    (17.0, PRIYA, 'Invitation: Design review @ Thu 2 PM', "Design review: homepage and onboarding. Thu 2–3 PM, Studio B.", {}, 'invite', None, []),
    (20.0, MARCUS, 'Q3 budget review',
     "Hi both,\n\nAttached is the Q3 summary. We're 4% under overall; travel and events are the big swings.\n\nMarcus", {}, 'budget1', None, [('Q3-summary.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', OFFICE)]),
    (26.0, ('Sofia Reyes', 'sofia@northwind.example'), 'Lunch Thursday?', "Cafe Rio at 12:30? I want to hear how the hiring went.", {}, 'lunch', None, []),
    (29.0, ('Jordan Kim', 'jordan@studio.example'), 'Photos from the workshop', "Here's the album from Tuesday. The whiteboard shots came out well.", {}, 'photos', None, 'PHOTOS'),
    (31.0, ('Paper & Co.', 'receipts@paperco.example'), 'Your receipt from Paper & Co.', "Thanks for your order. Total: $42.80.", {}, 'receipt', None, []),
    (52.0, ('Olivia Grant', 'olivia@northwind.example'), 'Welcome to the team, Hannah!', "Everyone, please give Hannah a warm welcome. She joins the design team on Monday.", {}, 'welcome', None, [('onboarding-plan.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', OFFICE)]),
    (98.0, ('Hannah Brooks', 'hannah@clientco.example'), 'Re: Feedback on the new site', ('html', "Thanks for sending the new site over.", OUTLOOK), {}, 'feedback', None, []),
]

EVENTS = {'A': {}}
def ev(key, subject, start, end, **extra):
    EVENTS['A'][key] = dict(subject=subject, start=start, end=end, my=extra.pop('my', 'Accept'), **extra)
for d in range(-2, 4):
    ev(f'STAND{d}', 'Team standup', at(9, 0, d), at(9, 30, d), organizer=PRIYA)
ev('ONE', '1:1 with Dana', at(11, 0), at(11, 30), location="Dana's office")
ev('BUDGET', 'Q3 budget review', at(15, 0), at(16, 0), my='Tentative', busy='Tentative', location='Room 4')
ev('CLIENT', 'Client call: Harbor Studio', at(13, 0, -1), at(14, 0, -1), location='Microsoft Teams Meeting')
ev('PLAN', 'Spring offsite planning', at(10, 0, 1), at(11, 30, 1), my='Organizer', organizer=ME)
ev('FOCUS', 'Focus time', at(14, 0, 1), at(16, 0, 1), my='Organizer', busy='Free')
ev('LUNCH', 'Lunch with Sofia', at(12, 30, 2), at(13, 30, 2), location='Cafe Rio')
ev('DESIGN', 'Design review', at(14, 0, 2), at(15, 0, 2), location='Studio B', organizer=PRIYA, attendees=[(ME, 'Unknown'), (MARCUS, 'Accept')])
ev('HIRING', 'Hiring sync', at(16, 0, -1), at(16, 45, -1))
ev('OFFSITE', 'Spring offsite', at(0, 0, 3), at(0, 0, 4), all_day=True, my='Organizer')
# Colleagues: Dana's calendar is in Alex's Outlook list and shared in full; Priya shares busy times with subject and place.
DN_DANA = '/o=ExchangeLabs/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=7c1e-dana'
cal = lambda subject, start, end, **extra: dict(subject=subject, start=start, end=end, my='Organizer', **extra)
OTHERS = {
    'links': {'A': [('Dana Whitfield', DN_DANA, '0A0B0C')]},
    'people': {DN_DANA: DANA},
    'mailboxes': {
        'dana@northwind.example': dict(access='full', folders={'0A0B0C': 'DANA-CAL'}, events={
            'D1': cal('Finance close', at(13, 0), at(14, 0), location='Room 2'),
            'D2': cal('Board prep', at(10, 0, 1), at(12, 0, 1), location='Boardroom'),
            'D3': cal('Interview: design lead', at(11, 0, 2), at(12, 0, 2)),
            'D4': cal('Vendor review', at(15, 30, -1), at(16, 30, -1))}),
        'priya@northwind.example': dict(access='busy', details=True, events={
            'P1': cal('Site visit: Lakeside', at(13, 0, 1), at(14, 30, 1), location='Lakeside Lodge'),
            'P2': cal('Agency call', at(16, 0, 1), at(17, 0, 1)),
            'P3': cal('Workshop prep', at(10, 0, 2), at(11, 30, 2)),
            'P4': cal('Dentist', at(8, 0, 1), at(9, 0, 1), busy='OOF')}),
    },
}

def message(hours, who, subject, body, headers, mid, reply_to, attachments):
    date = (now - timedelta(hours=hours)).strftime('%a, %d %b %Y %H:%M:%S +0000')
    head = [f'From: {who[0]} <{who[1]}>', f'To: {ME[0]} <{ME[1]}>', f'Subject: {subject}', f'Date: {date}', f'Message-ID: <{mid}@northwind.example>', 'MIME-Version: 1.0']
    if reply_to: head += [f'In-Reply-To: <{reply_to}@northwind.example>', f'References: <{reply_to}@northwind.example>']
    head += [f'{k}: {v}' for k, v in headers.items()]
    if isinstance(body, tuple):
        _, text, html = body
        content = ('Content-Type: multipart/alternative; boundary="alt"', f'--alt\nContent-Type: text/plain; charset=UTF-8\n\n{text}\n--alt\nContent-Type: text/html; charset=UTF-8\n\n{html}\n--alt--')
    else:
        content = ('Content-Type: text/plain; charset=UTF-8', body)
    if attachments:
        head.append('Content-Type: multipart/mixed; boundary="mix"')
        text = f'--mix\n{content[0]}\n\n{content[1]}\n' + ''.join(
            f'--mix\nContent-Type: {kind}; name="{name}"\nContent-Disposition: attachment; filename="{name}"\nContent-Transfer-Encoding: base64\n\n{data}\n' for name, kind, data in attachments) + '--mix--'
    else:
        head.append(content[0])
        text = content[1]
    return '\r\n'.join(head) + '\r\n\r\n' + text.replace('\n', '\r\n') + '\r\n'

# A canvas in Thunderbird's chrome does the drawing (photos, window frames, the comparison).
CANVAS = r'''
const canvas = (w, h) => { const c = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas'); c.width = w; c.height = h; return c; };
const image = (data) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = 'data:image/png;base64,' + data; });
const png = (c) => c.toDataURL('image/png').split(',')[1];
/** A screenshot (2x) of Ember's window, which draws under its own title bar: rounded corners, a shadow, and the
 *  traffic lights where macOS puts them (the page's capture can't include them: macOS draws them). */
async function frame(data, title, dark) {
  const shot = await image(data);
  const radius = 22, pad = 90;
  const c = canvas(shot.width + pad * 2, shot.height + pad * 2), g = c.getContext('2d');
  const x0 = pad, y0 = pad - 20, w = shot.width, h = shot.height;
  const round = () => { g.beginPath(); g.roundRect(x0, y0, w, h, radius); };
  g.save(); g.shadowColor = 'rgba(0,0,0,0.32)'; g.shadowBlur = 70; g.shadowOffsetY = 28; round(); g.fillStyle = dark ? '#1c1c1e' : '#f5f5f7'; g.fill(); g.restore();
  g.save(); round(); g.clip(); g.drawImage(shot, x0, y0); g.restore();
  round(); g.lineWidth = 1.5; g.strokeStyle = dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.14)'; g.stroke();
  [['#ff5f57', '#e0443e'], ['#febc2e', '#dea123'], ['#28c840', '#1aab29']].forEach(([fill, edge], i) => {
    g.beginPath(); g.arc(x0 + 38 + i * 40, y0 + 28, 12, 0, Math.PI * 2); g.fillStyle = fill; g.fill(); g.lineWidth = 1; g.strokeStyle = edge; g.stroke();
  });
  return png(c);
}
'''
HELP = r'''const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 20000) => { for (let i = 0; i < ms / 150; i++) { const v = f(); if (v) return v; await sleep(150); } return f(); };
const row = (text) => [...document.querySelectorAll('[role="option"]')].find((r) => r.textContent.includes(text));
const side = (text) => [...document.querySelectorAll('.sidebar .item')].find((b) => b.textContent.trim().startsWith(text));
const inbox = async () => { document.querySelector('.sidebar .item.parent[aria-label^="Inbox"]')?.click(); await sleep(900); };
const open = async (subject, text) => { await until(() => row(subject), 25000); row(subject).click(); await until(() => document.body.innerText.includes(text), 20000); await sleep(900); };
const ev = (t) => [...document.querySelectorAll('.calendar [data-key]')].find((b) => (b.getAttribute('aria-label') || '').startsWith(t + ','));
const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
'''

work = Path(tempfile.mkdtemp(dir=args.output_dir))
mock = EwsMock(work, EVENTS, others=OTHERS)
m = None
agent = None
def x(script, values=()):
    reply = m._cmd("WebDriver:ExecuteScript", {"script": f"return (async () => {{ {script} }})();", "args": list(values)})
    return reply.get("value") if isinstance(reply, dict) else reply
def save(name, data):
    (args.output_dir / name).write_bytes(base64.b64decode(data))
def framed(name, title='Ember', dark=False):
    x("for (const w of Services.wm.getEnumerator('mail:extensionPopup')) if (w.outerWidth !== 1440 || w.outerHeight !== 900) w.resizeTo(1440, 900); return 1;")
    time.sleep(0.6)
    raw = args.output_dir / f'.raw-{name}'
    spark.app_shot(m, str(raw), args.scale)
    if args.raw_dir:
        args.raw_dir.mkdir(parents=True, exist_ok=True)
        (args.raw_dir / name).write_bytes(raw.read_bytes())
    save(name, x(CANVAS + "const [d, t, k] = arguments; return await frame(d, t, k);", [b64(raw.read_bytes()), title, dark]))
    raw.unlink()
    print('saved', name, flush=True)

TARGETS = {}
def state(name, target=None):
    """Video frames (--raw-dir only): the window as it is now, and where `target` (JS for an element) is, in points."""
    if not args.raw_dir:
        return
    if target:
        TARGETS[name] = app("const el = (" + target + "); const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height];")
    spark.app_shot(m, str(args.raw_dir / name), args.scale)
    print('state', name, flush=True)
TAB = "[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === %s && b.getBoundingClientRect().top < 140)"

try:
    fp.create(feed_url='off')
    m = fp.launch()
    import spark
    def app(body):
        out = spark.run_in_app(m, HELP + body)
        if isinstance(out, str) and out.startswith('ERROR'): raise RuntimeError(out[:600])
        return out
    # Photos for the attachments: three landscapes drawn here.
    photos = x(CANVAS + r'''const out = [];
for (const [sky1, sky2, hill1, hill2, sun] of [['#ffb88c', '#de6262', '#3a3f58', '#232537', '#ffe29f'], ['#a1c4fd', '#c2e9fb', '#4b7f52', '#2e5233', '#fff6d5'], ['#2b5876', '#4e4376', '#1d1f33', '#111222', '#f6f1d1']]) {
  const c = canvas(1200, 800), g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 800); sky.addColorStop(0, sky1); sky.addColorStop(1, sky2); g.fillStyle = sky; g.fillRect(0, 0, 1200, 800);
  g.fillStyle = sun; g.beginPath(); g.arc(820, 300, 90, 0, Math.PI * 2); g.fill();
  for (const [color, base, amp] of [[hill1, 520, 90], [hill2, 620, 70]]) { g.fillStyle = color; g.beginPath(); g.moveTo(0, 800); for (let x = 0; x <= 1200; x += 20) g.lineTo(x, base + Math.sin(x / 140 + base) * amp); g.lineTo(1200, 800); g.fill(); }
  out.push(png(c));
}
return out;''')
    for i, item in enumerate(MAIL):
        if item[7] == 'PHOTOS':
            MAIL[i] = item[:7] + ([(f'workshop-{n}.png', 'image/png', data) for n, data in enumerate(photos, 1)],)
    # Accounts: Local Folders (Drafts), the mail account with its inbox, and the mock Exchange calendar, before Ember starts.
    x('''const [messages, me, port, der] = arguments;
const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
MailServices.accounts.createLocalMailAccount();
const localRoot = MailServices.accounts.localFoldersServer.rootFolder;
let drafts = null; try { drafts = localRoot.getChildNamed('Drafts'); } catch {}
drafts ||= localRoot.QueryInterface(Ci.nsIMsgLocalMailFolder).createLocalSubfolder('Drafts');
drafts.setFlag(Ci.nsMsgFolderFlags.Drafts);
const server = MailServices.accounts.createIncomingServer('alex', '127.0.0.1', 'pop3');
server.port = 1; server.loginAtStartUp = false; server.doBiff = false; server.prettyName = 'Northwind';
const account = MailServices.accounts.createAccount(); account.incomingServer = server;
const identity = MailServices.accounts.createIdentity(); identity.email = me[1]; identity.fullName = me[0]; identity.draftsFolderURI = drafts.URI; account.addIdentity(identity);
MailServices.accounts.defaultAccount = account;
let inbox = null; try { inbox = server.rootFolder.getChildNamed('Inbox'); } catch {}
inbox ||= server.rootFolder.QueryInterface(Ci.nsIMsgLocalMailFolder).createLocalSubfolder('Inbox');
inbox.setFlag(Ci.nsMsgFolderFlags.Inbox);
for (const raw of messages) inbox.QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage(raw);
for (const h of inbox.msgDatabase.enumerateMessages()) if (!/Venue shortlist|Re: Q3 budget|Draft press|Invitation/.test(h.mime2DecodedSubject)) h.markRead(true);
const cert = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB).constructX509FromBase64(der);
Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).rememberValidityOverride("127.0.0.1", port, {}, cert, false);
const ews = MailServices.accounts.createIncomingServer('alex@northwind.example', '127.0.0.1', 'ews');
ews.setStringValue('ews_url', `https://127.0.0.1:${port}/EWS/A/Exchange.asmx`);
ews.authMethod = Ci.nsMsgAuthMethod.passwordCleartext; ews.password = 'demo';
ews.loginAtStartUp = false; ews.doBiff = false; ews.prettyName = 'Northwind';
const cal = MailServices.accounts.createAccount(); cal.incomingServer = ews;
const calId = MailServices.accounts.createIdentity(); calId.email = me[1]; calId.fullName = me[0]; cal.addIdentity(calId);
Services.prefs.setStringPref('extensions.spark.lock.testAuth', 'pass');
return 1;''', [[message(*mail) for mail in MAIL], list(ME), mock.port, b64(mock.der)])
    m._cmd('Addon:Install', {'path': os.path.abspath(xpi), 'temporary': False})
    for _ in range(80):
        if x("return [...Services.wm.getEnumerator('mail:extensionPopup')].some(w => w.document.querySelector('browser')?.currentURI?.spec.endsWith('/app.html'))"): break
        time.sleep(0.25)
    x("for (const w of Services.wm.getEnumerator('mail:extensionPopup')) { w.moveTo(2560, 60); w.resizeTo(1440, 900); } for (const w of Services.wm.getEnumerator('mail:3pane')) { try { w.moveTo(2560, 60); } catch {} } return 1;")
    time.sleep(6)
    app("await messenger.storage.local.set({ theme: 'light' }); await sleep(800); return 1;")

    app("await open('Venue shortlist', 'Lakeside Lodge'); return 1;")
    framed('inbox.png')
    if args.raw_dir:
        # The Smart Inbox's sections, clicked in turn.
        for name in ['People', 'Calendar', 'Newsletters']:
            TARGETS[f'tab-{name.lower()}'] = app("const el = " + TAB % json.dumps(name) + "; const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height];")
            app("(" + TAB % json.dumps(name) + ").click(); await sleep(900); return 1;")
            state(f'tab-{name.lower()}.png')
        app("(" + TAB % json.dumps('All') + ").click(); await sleep(700); await open('Venue shortlist', 'Lakeside Lodge'); return 1;")
    app("await open('Q3 budget review', 'travel line'); return 1;")
    framed('thread.png')
    # Reading: the same Outlook email in Ember and in Thunderbird's own window.
    app("for (const b of [...document.querySelectorAll('[aria-expanded=\"false\"]')].filter((b) => /This week|This month/.test(b.textContent))) b.click(); await sleep(600); await open('Feedback on the new site', 'Compare plans'); return 1;")
    if args.raw_dir:
        spark.app_shot(m, str(args.raw_dir / 'reading-window.png'), args.scale)
    # Ember's message body (the email's frame in the reader, with the card's margin), at 2x.
    rect = app("const f = [...document.querySelectorAll('iframe')].filter((f) => f.getBoundingClientRect().width > 300).pop(); const r = f.getBoundingClientRect(); return [r.left - 28, r.top - 6, r.width + 56, Math.min(r.height + 28, 700)];")
    ember_body = spark.chrome_async(m, """const ex = __sparkBrowser(); const [x0, y0, w, h] = %s;
const bmp = await ex.browser.browsingContext.currentWindowGlobal.drawSnapshot(new DOMRect(x0, y0, w, h), %s, 'white');
const c = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0);
return c.toDataURL('image/png').split(',')[1];""" % (json.dumps(rect), args.scale))
    # The same email in Thunderbird's own message window (light, like Ember here), cropped to the same size.
    tb_body = x(CANVAS + r'''const [w, h] = arguments;
Services.prefs.setIntPref('ui.systemUsesDarkTheme', 0);
const {MailUtils} = ChromeUtils.importESModule('resource:///modules/MailUtils.sys.mjs');
const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const inbox = MailServices.accounts.accounts.find((a) => a.incomingServer.type === 'pop3').incomingServer.rootFolder.getChildNamed('Inbox');
const hdr = [...inbox.msgDatabase.enumerateMessages()].find((h) => h.mime2DecodedSubject.includes('Feedback on the new site'));
const win = MailUtils.openMessageInNewWindow(hdr);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 80 && win.document.readyState !== 'complete'; i++) await sleep(100);
win.moveTo(2560, 60); win.resizeTo(w + 40, 900); await sleep(3000);
const pane = win.document.getElementById('messageBrowser').contentDocument.getElementById('messagepane');
const bmp = await pane.browsingContext.currentWindowGlobal.drawSnapshot(new DOMRect(0, 0, w, h), arguments[2], 'white');
const c = canvas(bmp.width, bmp.height); c.getContext('2d').drawImage(bmp, 0, 0);
win.close(); Services.prefs.clearUserPref('ui.systemUsesDarkTheme');
return png(c);''', [rect[2], rect[3], args.scale])
    if args.raw_dir:
        (args.raw_dir / 'reading-ember.png').write_bytes(base64.b64decode(ember_body))
        (args.raw_dir / 'reading-thunderbird.png').write_bytes(base64.b64decode(tb_body))
    save('reading-comparison.png', x(CANVAS + r'''const [a, b] = arguments;
const [left, right] = [await image(a), await image(b)];
const label = 110, gap = 60, pad = 50, w = left.width + right.width + gap + pad * 2, h = Math.max(left.height, right.height) + label + pad;
const c = canvas(w, h), g = c.getContext('2d');
g.fillStyle = '#f4f4f6'; g.fillRect(0, 0, w, h);
const card = (img, x, title, color, note) => {
  g.save(); g.shadowColor = 'rgba(0,0,0,0.12)'; g.shadowBlur = 30; g.shadowOffsetY = 8; g.beginPath(); g.roundRect(x, label, img.width, img.height, 18); g.fillStyle = '#fff'; g.fill(); g.restore();
  g.save(); g.beginPath(); g.roundRect(x, label, img.width, img.height, 18); g.clip(); g.drawImage(img, x, label); g.restore();
  g.font = '700 40px -apple-system, system-ui, sans-serif'; g.textAlign = 'left'; g.fillStyle = color; g.fillText(title, x + 6, 62);
  const tw = g.measureText(title).width;
  g.font = '500 28px -apple-system, system-ui, sans-serif'; g.fillStyle = '#8a8a90'; g.fillText(note, x + 6 + tw + 18, 62);
};
card(left, pad, 'Thunderbird', '#55555c', 'as sent');
card(right, pad + left.width + gap, 'Ember', '#e8622c', 'easy to read');
return png(c);''', [tb_body, ember_body]))
    print('saved reading-comparison.png', flush=True)
    # Attachments.
    # Attachments come from Ember's saved mail, which a new profile fills in the first minute or two.
    app("side('Attachments').click(); return 1;")
    for _ in range(60):
        if app("return !!document.querySelector('.files .file') || /hidden by filters/.test(document.body.innerText) && !/^0 files · 0/.test(document.body.innerText);"): break
        time.sleep(3)
        app("side('Inbox')?.click(); await sleep(300); side('Attachments').click(); return 1;")
    app("[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Show all received files')?.click(); await until(() => document.querySelector('.files .file'), 10000); await sleep(1500); return 1;")
    framed('attachments.png')
    # A Claude Code session through Ember's MCP server: look, bring two to the top with notes, draft a reply, hold time.
    app("await messenger.storage.local.set({ agentAccess: true }); await sleep(3000); return 1;")
    agent = subprocess.Popen(['node', os.path.join(os.path.dirname(fp.SOCKET), 'ember-mcp.mjs')], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env={**os.environ, 'SPARK_AGENT_SOCKET': fp.SOCKET})
    seq = [0]
    def rpc(method, params=None):
        seq[0] += 1
        agent.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': seq[0], 'method': method, 'params': params or {}}) + '\n'); agent.stdin.flush()
        while True:
            reply = json.loads(agent.stdout.readline())
            if reply.get('id') == seq[0]: return reply
    def tool(name, arguments):
        result = rpc('tools/call', {'name': name, 'arguments': arguments})['result']
        if result.get('isError'): print('agent error', name, result['content'][0]['text'], flush=True)
        return result.get('structuredContent') or {}
    rpc('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'claude-code', 'title': 'Claude Code', 'version': '2.0'}})
    emails = tool('find_emails', {'limit': 20, 'reason': 'find what needs you this morning'}).get('emails', [])
    ids = {e['subject']: e['id'] for e in emails}
    tool('read_email', {'id': ids['Venue shortlist for the spring offsite'], 'reason': 'check the venue question'})
    if args.raw_dir:
        app("await inbox(); await open('Venue shortlist', 'Lakeside Lodge'); return 1;")
        state('agent-0.png')
    tool('mark_emails', {'ids': [ids['Venue shortlist for the spring offsite']], 'top': True, 'needs_reply': True, 'note': 'Pick a venue by Thursday: Priya is holding the dates', 'reason': 'bring what needs you to the top'})
    if args.raw_dir:
        time.sleep(2)
        state('agent-1.png')
    tool('mark_emails', {'ids': [ids['Draft press release: can you take a look?']], 'top': True, 'needs_reply': True, 'note': 'Marcus needs edits by noon tomorrow', 'reason': 'bring what needs you to the top'})
    tool('draft_reply', {'id': ids['Lunch Thursday?'], 'text': "Cafe Rio at 12:30 works. See you Thursday!\n\nAlex", 'reason': 'answer Sofia about lunch'})
    tool('calendar_events', {'days': 3, 'reason': 'see when you are free this week'})
    tool('hold_time', {'title': 'Venue walkthrough', 'start': at(15, 0, 2).isoformat(), 'end': at(16, 0, 2).isoformat(), 'invite': ['priya@northwind.example'], 'location': 'Lakeside Lodge', 'reason': 'hold time to see the venue'})
    time.sleep(2)
    app("await inbox(); await until(() => [...document.querySelectorAll('.viewport .sec')].some((s) => s.textContent.trim().startsWith('Top')), 15000); await open('Venue shortlist', 'Lakeside Lodge'); return 1;")
    framed('top-of-inbox.png')
    app("document.querySelector('.sidebar .agent-btn').click(); await sleep(2500); return 1;")
    framed('agent-activity.png')
    # Calendar: the week with an event open; then colleagues' calendars; then Find a time.
    app(r'''side('Calendar').click();
await until(() => document.querySelector('.calendar .modes'));
[...document.querySelectorAll('.calendar .modes button')].find((b) => b.textContent.trim() === 'Week').click();
await until(() => ev('Design review'), 15000); await sleep(800);
ev('Design review').click(); await until(() => document.querySelector('.calendar .popover .people li'), 8000); await sleep(800); return 1;''')
    framed('calendar.png')
    app(r'''key('Escape'); await sleep(300);
const calRow = (name) => [...document.querySelectorAll('.cal-side .cal')].find((b) => b.querySelector('.name')?.textContent.trim() === name);
await until(() => calRow('Dana Whitfield'), 15000); calRow('Dana Whitfield').click();
await until(() => ev('Board prep'), 10000);
[...document.querySelectorAll('.cal-side button')].find((b) => b.textContent.trim() === 'Add a calendar').click();
await until(() => document.querySelector('#calendar-add-person'));
const input = document.querySelector('#calendar-add-person');
input.value = 'Priya Shah <priya@northwind.example>'; input.dispatchEvent(new Event('input', { bubbles: true }));
input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await sleep(300);
[...document.querySelectorAll('.cal-side button')].find((b) => b.textContent.trim() === 'Add').click();
await until(() => ev('Site visit: Lakeside'), 15000); await sleep(600);
ev('Board prep').click(); await until(() => document.querySelector('.calendar .popover .shared-note'), 8000); await sleep(800); return 1;''')
    framed('shared-calendars.png')
    app(r'''key('Escape'); await sleep(300);
document.querySelector('.calendar .add').click(); await until(() => document.querySelector('.sheet[role="dialog"]'));
const ed = document.querySelector('.sheet[role="dialog"]');
const title = ed.querySelector('[aria-label="Title"]'); title.value = 'Venue decision'; title.dispatchEvent(new Event('input', { bubbles: true }));
const day = ed.querySelector('[aria-label="Start date"]'); const d = new Date(); d.setDate(d.getDate() + 1); day.value = d.toLocaleDateString('en-CA'); day.dispatchEvent(new Event('change', { bubbles: true }));
const start = ed.querySelector('[aria-label="Start time"]'); start.value = '13:00'; start.dispatchEvent(new Event('change', { bubbles: true })); await sleep(200);
const who = ed.querySelector('#event-invitees');
for (const person of ['Priya Shah <priya@northwind.example>', 'Dana Whitfield <dana@northwind.example>']) { who.value = person; who.dispatchEvent(new Event('input', { bubbles: true })); who.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await sleep(300); }
await until(() => ed.querySelector('.avail') && ed.querySelectorAll('.avail .slot, .avail button').length, 15000); await sleep(1200); return 1;''')
    framed('availability.png')
    if args.raw_dir:
        # Quick add, then the invitees one at a time (their busy times appear).
        app("document.querySelector('.sheet .foot .btn')?.click(); await sleep(300); key('Escape'); await sleep(400); document.querySelector('.calendar .add').click(); await until(() => document.querySelector('.sheet[role=\"dialog\"]')); await sleep(600); return 1;")
        QUICK = "document.querySelector('.sheet[role=\"dialog\"] [aria-label=\"Quick event\"]')"
        state('ed-0.png', QUICK)
        for i, text in enumerate(['Venue decision', 'Venue decision tomorrow 1pm', 'Venue decision tomorrow 1pm at Lakeside Lodge'], 1):
            app("const q = " + QUICK + "; q.value = " + json.dumps(text) + "; q.dispatchEvent(new Event('input', { bubbles: true })); await sleep(250); return 1;")
            state(f'ed-q{i}.png')
        app("const q = " + QUICK + "; q.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await sleep(700); return 1;")
        WHO = "document.querySelector('#event-invitees')"
        state('ed-1.png', WHO)
        for i, person in enumerate(['Priya Shah <priya@northwind.example>', 'Dana Whitfield <dana@northwind.example>'], 2):
            app("const who = " + WHO + "; who.value = " + json.dumps(person) + "; who.dispatchEvent(new Event('input', { bubbles: true })); who.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await sleep(300); const ed = document.querySelector('.sheet[role=\"dialog\"]'); await until(() => ed.querySelector('.avail') && ed.querySelectorAll('.avail .slot, .avail button').length, 15000); await sleep(1300); return 1;")
            state(f'ed-{i}.png', WHO if i == 2 else "[...document.querySelectorAll('.sheet[role=\"dialog\"] .avail button')].find((b) => /12:00/.test(b.textContent)) || document.querySelector('.sheet[role=\"dialog\"] .avail button')")
    # Dark mode.
    app("document.querySelector('.sheet .foot .btn')?.click(); await sleep(300); key('Escape'); await messenger.storage.local.set({ theme: 'dark' }); await sleep(800); await inbox(); await open('Q3 budget review', 'travel line'); return 1;")
    framed('dark.png', dark=True)
    if args.raw_dir:
        # The same screen in light, for the video's switch to dark.
        app("await messenger.storage.local.set({ theme: 'light' }); await sleep(900); return 1;")
        spark.app_shot(m, str(args.raw_dir / 'dark-as-light.png'), args.scale)
    # The lock screen.
    app("await messenger.storage.local.set({ theme: 'light', lockEnabled: true }); await sleep(1500); await messenger.sparkLock.lock(); await sleep(2500); return 1;")
    framed('lock.png')
    if args.raw_dir:
        TARGETS['unlock'] = app("const el = document.querySelector('.unlock'); const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height];")
        app("document.querySelector('.unlock').click(); await sleep(2500); return 1;")
        state('unlocked.png')
        (args.raw_dir / 'targets.json').write_text(json.dumps(TARGETS, indent=1))
finally:
    if agent:
        try: agent.stdin.close(); agent.wait(timeout=5)
        except Exception: agent.kill()
    fp.remove()
    leftover = os.path.join(os.path.dirname(fp.SOCKET), 'ember-mcp.mjs')
    if os.path.exists(leftover): os.remove(leftover)
    mock.stop()
print('screenshots in', args.output_dir)
