#!/usr/bin/env python3
"""The Calendar page (0.1.123), isolated fixture profile only (port 2831), against a local mock EWS with two
Exchange accounts (A and B).

Account A's week: a team sync with a Teams link (accepted), an all-day event, two overlapping meetings (one
tentative), an unanswered invitation, the user's own meeting with attendees' answers, a cancelled meeting, a
declined one (never shown), and a meeting named after an email in the inbox (for "Emails about this"). Account B:
one meeting.

Checks the sidebar item, Week (columns, today, now line, lanes, looks, all-day row), the popover (Join, invitees
and their answers, Emails about this, Accept sends AcceptItem for that event), hiding a calendar, Month, Year,
Day with its side panel, the keys (D W M Y, arrows, T), search, and light/dark screenshots. Puts back the
settings it changed, removes both accounts and the certificate override. Never contacts an external server.

  test_calendar_page.py --output-dir DIR
"""
import argparse, base64, http.server, json, re, ssl, subprocess, tempfile, threading, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)

midnight = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
at = lambda h, m=0, day=0: (midnight + timedelta(days=day, hours=h, minutes=m)).astimezone(timezone.utc)
iso = lambda d: d.strftime('%Y-%m-%dT%H:%M:%SZ')
TEAMS = 'https://teams.microsoft.com/l/meetup-join/19%3acal%40thread.v2/0'
DANA = ('Dana Whitfield', 'dana@spark.test')
OLIVER = ('Oliver Grant', 'oliver@spark.test')
SOFIA = ('Sofia Reyes', 'sofia@spark.test')
ME = ('Merritt (EWS test)', 'merritt@ews.test')
# id: subject, start, end, my answer, extra
EVENTS = {
    'A': {
        'SYNC': dict(subject='Weekly team sync', start=at(9), end=at(9, 30), my='Accept', body=f'Agenda in the doc.\n\n{"_" * 40}\nMicrosoft Teams meeting\nJoin: {TEAMS}', location='Microsoft Teams Meeting', organizer=DANA, attendees=[(ME, 'Unknown'), (OLIVER, 'Unknown')]),
        'RETREAT': dict(subject='Spring retreat planning', start=at(0), end=at(0, day=1), my='Organizer', all_day=True),
        'BUDGET': dict(subject='Budget review', start=at(14), end=at(15), my='Accept', organizer=DANA, attendees=[(ME, 'Unknown')], body='Walk through slide 7 before the board call.'),
        'MIX': dict(subject='Sound mix review', start=at(14, 30), end=at(15, 15), my='Tentative', location='Mix stage', busy='Tentative'),
        'CHECK': dict(subject='Edit check-in', start=at(16), end=at(16, 30), my='NoResponseReceived', organizer=OLIVER, attendees=[(ME, 'Unknown')]),
        'OWN': dict(subject='Board packet prep', start=at(11), end=at(12), my='Organizer', organizer=ME, attendees=[(OLIVER, 'Accept'), (DANA, 'Tentative'), (SOFIA, 'NoResponseReceived')]),
        'OFFSITE': dict(subject='Ember offsite', start=at(17), end=at(17, 45), my='Accept', organizer=DANA, attendees=[(ME, 'Unknown')]),
        'CANCEL': dict(subject='Canceled: Vendor demo', start=at(19), end=at(20), my='Accept', cancelled=True),
        'NOPE': dict(subject='Declined thing', start=at(8), end=at(8, 30), my='Decline'),
    },
    'B': {
        'TRAILER': dict(subject='Trailer review', start=at(11), end=at(12), my='Accept', location='Edit Bay 2'),
    },
}
esc = lambda s: str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
def envelope(body):
    return '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' + body + '</s:Body></s:Envelope>'
NS = 'xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"'
def ok(kind, inner=''):
    return envelope(f'<m:{kind}Response {NS}><m:ResponseMessages><m:{kind}ResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>{inner}</m:{kind}ResponseMessage></m:ResponseMessages></m:{kind}Response>')
answers = {}
def item(i, e, details=False):
    my = answers.get(i, e['my'])
    xml = (f'<t:CalendarItem><t:ItemId Id="{i}" ChangeKey="ck-{i}"/><t:Subject>{esc(e["subject"])}</t:Subject><t:Start>{iso(e["start"])}</t:Start><t:End>{iso(e["end"])}</t:End>'
           f'<t:IsAllDayEvent>{"true" if e.get("all_day") else "false"}</t:IsAllDayEvent><t:Location>{esc(e.get("location", ""))}</t:Location>'
           f'<t:LegacyFreeBusyStatus>{e.get("busy", "Busy")}</t:LegacyFreeBusyStatus><t:UID>uid-{i}</t:UID><t:MyResponseType>{my}</t:MyResponseType>'
           f'<t:IsCancelled>{"true" if e.get("cancelled") else "false"}</t:IsCancelled>')
    if details:
        xml += f'<t:Body BodyType="Text">{esc(e.get("body", ""))}</t:Body>'
        if e.get('organizer'):
            xml += f'<t:Organizer><t:Mailbox><t:Name>{esc(e["organizer"][0])}</t:Name><t:EmailAddress>{e["organizer"][1]}</t:EmailAddress></t:Mailbox></t:Organizer>'
        if e.get('attendees'):
            xml += '<t:RequiredAttendees>' + ''.join(f'<t:Attendee><t:Mailbox><t:Name>{esc(n)}</t:Name><t:EmailAddress>{a}</t:EmailAddress></t:Mailbox><t:ResponseType>{r}</t:ResponseType></t:Attendee>' for (n, a), r in e['attendees']) + '</t:RequiredAttendees>'
    return xml + '</t:CalendarItem>'
requests = []

class EWS(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
        which = 'B' if '/B/' in self.path else 'A'
        events = EVENTS[which]
        requests.append((which, body))
        reply = None
        if '<m:FindItem' in body and 'calendar:Start' in body:
            m = re.search(r'StartDate="([^"]+)" EndDate="([^"]+)"', body)
            start, end = (datetime.fromisoformat(v.replace('Z', '+00:00')) for v in m.groups())
            shown = ''.join(item(i, e) for i, e in events.items() if e['start'] < end and e['end'] > start)
            reply = ok('FindItem', f'<m:RootFolder IncludesLastItemInRange="true"><t:Items>{shown}</t:Items></m:RootFolder>')
        elif '<m:GetItem' in body:
            ids = re.findall(r'<t:ItemId Id="([^"]+)"/>', body)
            reply = ok('GetItem', '<m:Items>' + ''.join(item(i, events[i], details='item:Body' in body) for i in ids if i in events) + '</m:Items>')
        elif '<m:CreateItem' in body:
            for kind, word in (('AcceptItem', 'Accept'), ('TentativelyAcceptItem', 'Tentative'), ('DeclineItem', 'Decline')):
                hit = re.search(rf'<t:{kind}><t:ReferenceItemId Id="([^"]+)"', body)
                if hit: answers[hit.group(1)] = word
            reply = ok('CreateItem', '<m:Items/>')
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

m = spark.connect()
def chrome(script, values=()):
    reply = m._cmd("WebDriver:ExecuteScript", {"script": script, "args": list(values)})
    return reply.get("value") if isinstance(reply, dict) else reply
accounts = chrome('''
const [port, der] = arguments;
const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const cert = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB).constructX509FromBase64(der);
Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).rememberValidityOverride("127.0.0.1", port, {}, cert, false);
const keys = [];
for (const [which, address] of [["A", "merritt@ews.test"], ["B", "merritt@ews-b.test"]]) {
  const server = MailServices.accounts.createIncomingServer(address, "127.0.0.1", "ews");
  server.setStringValue("ews_url", `https://127.0.0.1:${port}/EWS/${which}/Exchange.asmx`);
  server.authMethod = Ci.nsMsgAuthMethod.passwordCleartext;
  server.password = "spark-test-password";
  server.loginAtStartUp = false; server.doBiff = false;
  server.prettyName = which === "A" ? "Calendar test A" : "Calendar test B";
  const account = MailServices.accounts.createAccount();
  account.incomingServer = server;
  const identity = MailServices.accounts.createIdentity(); identity.email = address; identity.fullName = "Merritt (EWS test)";
  account.addIdentity(identity);
  keys.push(account.key);
}
return keys;''', [port, base64.b64encode(der).decode()])

def page(body):
    out = spark.run_in_app(m, body)
    if isinstance(out, str) and out.startswith('ERROR'):
        raise RuntimeError(out)
    return out

HELPERS = r'''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { const v = test(); if (v) return v; await sleep(100); } return test(); };
const evByTitle = (title) => [...document.querySelectorAll('.calendar [data-key]')].find((b) => (b.getAttribute('aria-label') || '').startsWith(title + ','));
const mode = (label) => [...document.querySelectorAll('.calendar .modes button')].find((b) => b.textContent.trim() === label);
const pop = () => document.querySelector('.calendar .popover');
const card = (root) => root && ({
  title: root.querySelector('h2')?.textContent.trim(), where: root.querySelector('.where')?.textContent.trim() || null,
  when: root.querySelector('.when')?.textContent.replace(/\s+/g, ' ').trim(), cal: root.querySelector('.cal')?.textContent.trim(),
  join: root.querySelector('a.join')?.getAttribute('href') || null, warn: [...root.querySelectorAll('.warn')].map((w) => w.textContent.trim()),
  people: [...root.querySelectorAll('.people li')].map((li) => [li.querySelector('.name')?.textContent.trim(), li.querySelector('.mark')?.textContent.trim(), li.querySelector('.note')?.textContent.trim() || null]),
  organized: !!root.querySelector('.block h3 span'), emails: [...root.querySelectorAll('.email:not(.more) span')].map((s) => s.textContent.trim()), brief: root.querySelector('.email.more')?.textContent.trim() || null,
  notes: root.querySelector('.notes')?.textContent.trim() || null,
  answers: [...root.querySelectorAll('.answers button')].map((b) => [b.textContent.trim(), b.getAttribute('aria-pressed')]),
});
const key = (k) => { document.activeElement?.blur?.(); window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); };
'''
result = {}
try:
    before = page("return await messenger.storage.local.get(['calendarMode', 'calendarHidden']);")
    result['before'] = before
    # The page asks Thunderbird for the calendars when it first opens: reload so it sees the two test accounts.
    page("location.reload(); return 1;")
    time.sleep(4)
    # Light first (the test profile's own Appearance may be Dark); the theme is put back at the end.
    result['theme'] = page("const t = document.documentElement.dataset.theme || ''; document.documentElement.dataset.theme = 'light'; return t;")
    # An email in the inbox names one meeting, and the More list (read before the calendar replaces it).
    inbox = page(r'''document.querySelector('.sidebar .item.parent[aria-label^="Inbox"]')?.click();
for (let i = 0; i < 60 && !document.querySelector('.col-list .subject'); i++) await new Promise((r) => setTimeout(r, 100));
const more = document.querySelector('.sidebar .item.more'); const open = more?.getAttribute('aria-expanded') === 'true';
if (!open) more?.click(); await new Promise((r) => setTimeout(r, 200));
const items = [...document.querySelectorAll('.sidebar .more-items .label')].map((l) => l.textContent.trim());
if (!open) more?.click();
return { subjects: [...document.querySelectorAll('.col-list .subject')].map((s) => s.textContent.trim()).filter((s) => s.length >= 6 && !s.startsWith('Responses:')), items };''')
    OFFSITE = 'Team offsite agenda' if 'Team offsite agenda' in inbox['subjects'] else inbox['subjects'][0]
    EVENTS['A']['OFFSITE']['subject'] = OFFSITE
    result['offsiteSubject'], result['moreItems'] = OFFSITE, inbox['items']
    result['sidebar'] = page(HELPERS + r'''
const item = await until(() => [...document.querySelectorAll('.sidebar .item')].find((b) => b.textContent.trim() === 'Calendar'));
item.click();
await until(() => document.querySelector('.calendar'));
mode('Week').click();
await until(() => evByTitle('Weekly team sync'), 12000);
await sleep(300);
return { item: !!item, current: item.getAttribute('aria-current'),
  calendars: [...document.querySelectorAll('.cal-side .account')].map((h) => h.textContent.trim()), boxes: [...document.querySelectorAll('.cal-side .cal')].map((b) => b.getAttribute('aria-checked')),
  mini: document.querySelectorAll('.cal-side .mini-grid button').length, miniToday: !!document.querySelector('.cal-side .mini-grid button.today'), agendaHidden: !document.querySelector('.sidebar .agenda') };''')
    WEEK = HELPERS + r'''
const today = document.querySelector('.calendar .col-head.today');
const lane = (t) => { const b = evByTitle(t); return b && { width: b.style.width, left: b.style.left, cls: b.className.replace(/svelte-\w+/g, '').trim().split(/\s+/) }; };
return { title: document.querySelector('.calendar h1')?.textContent.trim(), cols: document.querySelectorAll('.calendar .col-head').length,
  pressed: [...document.querySelectorAll('.calendar .modes button[aria-pressed="true"]')].map((b) => b.textContent.trim()),
  today: today?.textContent.replace(/\s+/g, ' ').trim(), todayIsRed: !!today && getComputedStyle(today.querySelector('.num')).backgroundColor !== 'rgba(0, 0, 0, 0)',
  nowLine: !!document.querySelector('.calendar .now-line'), nowLabel: document.querySelector('.calendar .now-label')?.textContent.trim() || null,
  titles: [...document.querySelectorAll('.calendar .day-col [data-key]')].map((b) => b.querySelector('.ev-title')?.textContent.trim()),
  allDay: [...document.querySelectorAll('.calendar .all-day [data-key]')].map((b) => b.textContent.trim()),
  budget: lane('Budget review'), mix: lane('Sound mix review'), check: lane('Edit check-in'), cancel: lane('Canceled: Vendor demo'), sync: lane('Weekly team sync'), trailer: lane('Trailer review'), own: lane('Board packet prep'),
  tint: (() => { const b = evByTitle('Weekly team sync'); const s = b && getComputedStyle(b); return s && [s.backgroundColor, s.color, s.boxShadow]; })(),
  scrolled: document.querySelector('.calendar .grid-scroll')?.scrollTop };'''
    result['week'] = page(WEEK)
    # Popovers: the team sync (Join, organizer), my own meeting (answers), the offsite (its emails).
    result['sync'] = page(HELPERS + r'''evByTitle('Weekly team sync').click(); await until(() => pop()?.querySelector('.people li')); await sleep(200); return card(pop());''')
    spark.app_shot(m, str(args.output_dir / 'calendar-week-light.png'))
    result['own'] = page(HELPERS + r'''evByTitle('Board packet prep').click(); await until(() => pop()?.querySelector('h2')?.textContent.includes('Board') && pop().querySelector('.people li')); await sleep(200); return card(pop());''')
    result['offsite'] = page(HELPERS + r'''const name = %s; evByTitle(name).click(); await until(() => pop()?.querySelector('h2')?.textContent.trim() === name && pop().querySelector('.people li')); await sleep(300); return card(pop());''' % json.dumps(OFFSITE))
    result['cancel'] = page(HELPERS + r'''evByTitle('Canceled: Vendor demo').click(); await until(() => pop()?.querySelector('h2')?.textContent.includes('Vendor')); await sleep(200); const c = card(pop()); key('Escape'); await sleep(200); return { ...c, closedByEsc: !pop() };''')
    # Answer the unanswered invitation.
    result['accept'] = page(HELPERS + r'''evByTitle('Edit check-in').click(); await until(() => pop()?.querySelector('.answers button')); await sleep(200);
const c = card(pop());
[...pop().querySelectorAll('.answers button')].find((b) => b.textContent.trim() === 'Accept').click();
await until(() => evByTitle('Edit check-in') && !evByTitle('Edit check-in').className.includes('unanswered') && [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('Edit check-in')), 10000);
await sleep(1500);
return { before: c, after: evByTitle('Edit check-in')?.className.includes('unanswered'), pressed: [...(pop()?.querySelectorAll('.answers button[aria-pressed="true"]') || [])].map((b) => b.textContent.trim()), toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()) };''')
    # Dark theme screenshot with a popover open.
    page(HELPERS + "document.documentElement.dataset.theme = 'dark'; evByTitle('Board packet prep').click(); await sleep(600); return 1;")
    spark.app_shot(m, str(args.output_dir / 'calendar-week-dark.png'))
    result['darkTint'] = page(HELPERS + "const b = evByTitle('Weekly team sync'); const s = getComputedStyle(b); return [s.backgroundColor, s.color];")
    page(HELPERS + "key('Escape'); document.documentElement.dataset.theme = 'light'; return 1;")
    # Hide calendar B, then show it again.
    result['hide'] = page(HELPERS + r'''const box = [...document.querySelectorAll('.cal-side .cal')][1]; box.click();
await until(() => !evByTitle('Trailer review')); const hidden = !evByTitle('Trailer review'); const saved = (await messenger.storage.local.get('calendarHidden')).calendarHidden;
box.click(); await until(() => evByTitle('Trailer review')); return { hidden, saved, back: !!evByTitle('Trailer review'), box: box.getAttribute('aria-checked') };''')
    # Keys: M, Y, D, W; arrows and T.
    result['keys'] = page(HELPERS + r'''const title = () => document.querySelector('.calendar h1').textContent.trim();
const pressed = () => document.querySelector('.calendar .modes button[aria-pressed="true"]').textContent.trim();
const out = {};
key('m'); await sleep(400); out.m = [pressed(), title(), document.querySelectorAll('.calendar .m-cell').length];
key('y'); await sleep(300); out.y = [pressed(), title(), document.querySelectorAll('.calendar .y-month').length];
key('d'); await sleep(400); out.d = [pressed(), title()];
const first = () => document.querySelector('.calendar .col-head')?.getAttribute('aria-label');
key('w'); await sleep(300); const week = first();
key('ArrowRight'); await sleep(300); out.next = first() !== week;
key('t'); await sleep(300); out.today = first() === week;
out.saved = (await messenger.storage.local.get('calendarMode')).calendarMode;
return out;''')
    # Month view: today, events in cells.
    result['month'] = page(HELPERS + r'''mode('Month').click(); await until(() => document.querySelector('.calendar .m-num.today')); await until(() => evByTitle('Weekly team sync'), 8000); await sleep(300);
const cell = document.querySelector('.calendar .m-num.today').closest('.m-cell');
return { cells: document.querySelectorAll('.calendar .m-cell').length, todayItems: [...cell.querySelectorAll('.m-title')].map((t) => t.textContent.trim()), more: cell.querySelector('.m-more')?.textContent.trim() || null };''')
    spark.app_shot(m, str(args.output_dir / 'calendar-month-light.png'))
    result['monthPop'] = page(HELPERS + r'''const more = document.querySelector('.calendar .m-num.today').closest('.m-cell').querySelector('[data-key]'); more.click(); await until(() => pop()?.querySelector('h2')); await sleep(200); const t = pop()?.querySelector('h2')?.textContent.trim(); key('Escape'); return t;''')
    # Year view.
    result['year'] = page(HELPERS + r'''mode('Year').click(); await sleep(300); return { months: document.querySelectorAll('.calendar .y-month').length, current: document.querySelector('.calendar .y-name.current')?.textContent.trim(), today: !!document.querySelector('.calendar .y-day.today') };''')
    spark.app_shot(m, str(args.output_dir / 'calendar-year-light.png'))
    # Day view with its side panel.
    result['day'] = page(HELPERS + r'''mode('Day').click(); await until(() => evByTitle('Budget review'), 8000); await sleep(200);
const empty = document.querySelector('.calendar .day-panel .pick')?.textContent.trim();
evByTitle('Budget review').click(); await until(() => document.querySelector('.calendar .day-panel .notes')); await sleep(200);
return { cols: document.querySelectorAll('.calendar .col-head').length, empty, panel: card(document.querySelector('.calendar .day-panel')), popover: !!pop() };''')
    spark.app_shot(m, str(args.output_dir / 'calendar-day-light.png'))
    # Search.
    result['search'] = page(HELPERS + r'''mode('Week').click(); await sleep(300);
const input = document.querySelector('.calendar .cal-search input'); input.focus(); input.value = 'budget'; input.dispatchEvent(new Event('input', { bubbles: true }));
await until(() => document.querySelector('.calendar .results button'), 8000);
const found = [...document.querySelectorAll('.calendar .results .r-title')].map((t) => t.textContent.trim());
document.querySelector('.calendar .results button').click();
await until(() => pop()?.querySelector('h2')); await sleep(300);
const shown = pop()?.querySelector('h2')?.textContent.trim(); key('Escape');
return { found, shown, cleared: !document.querySelector('.calendar .results') };''')
    week, sync, own, offsite, cancel = result['week'], result['sync'], result['own'], result['offsite'], result['cancel']
    sb = result['sidebar']
    result['checks'] = {
        'sidebar_item_and_calendars': sb['item'] and sb['current'] == 'page' and len(sb['calendars']) >= 2 and sb['boxes'][:2] == ['true', 'true'] and sb['mini'] == 42 and sb['miniToday'] and sb['agendaHidden'],
        'invitations_renamed': 'Invitations' in result['moreItems'] and 'Calendar' not in result['moreItems'],
        'week_grid': week['cols'] == 7 and week['pressed'] == ['Week'] and week['todayIsRed'] and week['nowLine'] and bool(week['nowLabel']),
        'events_shown_declined_left_out': all(t in week['titles'] for t in ['Weekly team sync', 'Budget review', 'Sound mix review', 'Edit check-in', 'Board packet prep', 'Trailer review', OFFSITE]) and 'Declined thing' not in week['titles'],
        'all_day_row': week['allDay'] == ['Spring retreat planning'],
        # Two lanes cascade (1.0.12): the first reaches under the second (85%), the second keeps its half.
        'overlaps_side_by_side': '0%' in week['budget']['left'] and '85%' in week['budget']['width'] and '50%' in week['mix']['left'] and '50%' in week['mix']['width']
            and '85%' in week['own']['width'] and '50%' in week['trailer']['width'],
        'looks': 'unanswered' in week['check']['cls'] and 'tentative' in week['mix']['cls'] and 'cancelled' in week['cancel']['cls'] and 'busy' in week['sync']['cls'],
        'tinted_with_edge': bool(week['tint']) and 'inset' in (week['tint'][2] or '') and week['tint'][0] != 'rgba(0, 0, 0, 0)',
        'dark_tint_differs': result['darkTint'] != week['tint'][:2],
        'popover_join_and_people': sync['join'] == TEAMS and sync['people'][0] == ['Dana Whitfield', '✓', 'organizer'] and any(p[0] == 'You' for p in sync['people']) and sync['notes'] == 'Agenda in the doc.' and sync['answers'] == [['Accept', 'true'], ['Maybe', 'false'], ['Decline', 'false']],
        'own_meeting_answers': own['organized'] and ['Oliver Grant', '✓', 'accepted'] in own['people'] and ['Dana Whitfield', '?', 'maybe'] in own['people'] and ['Sofia Reyes', '', 'no answer'] in own['people'] and own['answers'] == [] and any('Overlaps' in w and 'Trailer review' in w for w in own['warn']),
        'emails_about_this': len(offsite['emails']) >= 1 and all(OFFSITE.lower() in s.lower() for s in offsite['emails']) and bool(offsite['brief']),
        'cancelled_said_and_esc_closes': any('cancelled' in w for w in cancel['warn']) and cancel['answers'] == [] and cancel['closedByEsc'],
        'accept_sends_accept_item': any(w == 'A' and '<t:AcceptItem><t:ReferenceItemId Id="CHECK"' in b and 'SendAndSaveCopy' in b for w, b in requests),
        'accept_updates_event': result['accept']['before']['answers'] == [['Accept', 'false'], ['Maybe', 'false'], ['Decline', 'false']] and result['accept']['after'] is False and any('Accepted “Edit check-in”' in t and 'Oliver Grant' in t for t in result['accept']['toasts']),
        'hide_calendar': result['hide']['hidden'] and len(result['hide']['saved']) == 1 and result['hide']['back'] and result['hide']['box'] == 'true',
        'keys': result['keys']['m'][0] == 'Month' and result['keys']['m'][2] in (35, 42, 28) and result['keys']['y'][0] == 'Year' and result['keys']['y'][2] == 12 and result['keys']['d'][0] == 'Day' and result['keys']['next'] and result['keys']['today'] and result['keys']['saved'] == 'week',
        'month_view': result['month']['cells'] in (28, 35, 42) and 'Spring retreat planning' in result['month']['todayItems'] and (bool(result['month']['more']) or len(result['month']['todayItems']) >= 9) and bool(result['monthPop']),
        'year_view': result['year']['months'] == 12 and bool(result['year']['current']) and result['year']['today'],
        'day_view_panel': result['day']['cols'] == 1 and result['day']['empty'] == 'Pick an event to see it here.' and result['day']['panel']['title'] == 'Budget review' and result['day']['panel']['notes'] == 'Walk through slide 7 before the board call.' and not result['day']['popover'],
        'search': result['search']['found'] == ['Budget review'] and result['search']['shown'] == 'Budget review' and result['search']['cleared'],
        'only_local_requests': all(w in ('A', 'B') for w, _ in requests),
    }
finally:
    try:
        page("await messenger.storage.local.set(%s); %s return 1;" % (json.dumps({k: v for k, v in (result.get('before') or {}).items()}),
             "".join(f"await messenger.storage.local.remove('{k}');" for k in ('calendarMode', 'calendarHidden') if k not in (result.get('before') or {}))))
    except Exception as error:
        print('restore failed', error)
    chrome('''
const [keys, port] = arguments;
const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
for (const key of keys) { const account = MailServices.accounts.getAccount(key); if (account) MailServices.accounts.removeAccount(account, true); }
Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).clearValidityOverride("127.0.0.1", port, {});
return true;''', [accounts, port])
    server.shutdown()
    subprocess.run(['rm', '-rf', str(work)])
    try:
        # Back to the inbox and the profile's own theme, with the calendar list read again (the test accounts are gone).
        spark.run_in_app(m, "document.documentElement.dataset.theme = %s; return 1;" % json.dumps(result.get('theme') or ''))
        spark.run_in_app(m, "document.querySelector('.sidebar .item.parent[aria-label^=\"Inbox\"]')?.click(); await new Promise(r => setTimeout(r, 300)); location.reload(); return 1;")
    except Exception:
        pass

(args.output_dir / 'calendar-page.json').write_text(json.dumps(result, indent=2, ensure_ascii=False))
print(json.dumps(result, indent=2, ensure_ascii=False))
raise SystemExit(0 if result.get('checks') and all(result['checks'].values()) else 1)
