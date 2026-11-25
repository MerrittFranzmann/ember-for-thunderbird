#!/usr/bin/env python3
"""Trips in the real Ember, isolated fixture profile only (port 2831). Workers AI is a mock on 127.0.0.1 (pref
extensions.spark.clefEndpoint); notifications go to a stand-in alerts service; fixture mail is added locally.
Nothing is fetched or sent.

  1. A TAP booking (read by "Workers AI": out in 3 h from New York, back in 4 days) and a hotel confirmation
     (schema.org markup, read on this Mac) become one "Lisbon trip". An ad from the airline and a normal email
     are not asked about.
  2. Travel day: the sidebar has "Lisbon trip · Now", above the inbox the trip's card shows the flight, and the
     booking emails are folded out of the Smart Inbox list.
  3. A gate-change email: a notification "Gate changed: TP 1351 now leaves from B27" and the change pinned
     above the inbox.
  4. The trip page: header, Right now, day by day with home times, the trip's emails (one opens in the reader).
  5. Check-in reminder set for the return flight.

  test_trips.py --output-dir DIR
"""
import argparse, json, threading, time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
m = spark.connect()
RUN = int(time.time())
NY, LIS = ZoneInfo('America/New_York'), ZoneInfo('Europe/Lisbon')
now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
loc = lambda dt, tz: dt.astimezone(tz).strftime('%Y-%m-%dT%H:%M')
DEP, ARR = now + timedelta(hours=3), now + timedelta(hours=10)
CHECKIN, CHECKOUT = now + timedelta(hours=13), now + timedelta(days=4, hours=2)
BACK, HOME = now + timedelta(days=4, hours=5), now + timedelta(days=4, hours=12)
asked = []


def flight(gate):
    return [
        {'kind': 'flight', 'status': 'changed' if gate == 'B27' else 'confirmed', 'provider': 'TAP Air Portugal', 'number': 'TP 1351', 'from_code': 'JFK', 'from_city': 'New York', 'to_code': 'LIS', 'to_city': 'Lisbon', 'confirmation': 'QX%d' % (RUN % 10000), 'seat': '14C', 'gate': gate, 'terminal': '1',
         'start_local': loc(DEP, NY), 'start_timezone': 'America/New_York', 'end_local': loc(ARR, LIS), 'end_timezone': 'Europe/Lisbon'},
        {'kind': 'flight', 'status': 'confirmed', 'provider': 'TAP Air Portugal', 'number': 'TP 207', 'from_code': 'LIS', 'to_code': 'JFK', 'to_city': 'New York', 'confirmation': 'QX%d' % (RUN % 10000),
         'start_local': loc(BACK, LIS), 'start_timezone': 'Europe/Lisbon', 'end_local': loc(HOME, NY), 'end_timezone': 'America/New_York'},
    ]


class MockAI(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
        if self.path.endswith('/llm'):
            text = body['messages'][1]['content']
            asked.append(text.split('\n')[1])
            bookings = flight('B27') if 'Gate change' in text else flight('B12') if 'Your TAP booking' in text else []
            answer = {'result': {'response': {'bookings': bookings}}, 'success': True}
        else:  # AI sorting's Clef requests while aiSort is on
            answer = {'result': {'answers': {'kind': {'choice': 'updates', 'confidence': 0.9}}}, 'success': True}
        data = json.dumps(answer).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
    def log_message(self, *a): pass


server = HTTPServer(('127.0.0.1', 0), MockAI)
threading.Thread(target=server.serve_forever, daemon=True).start()


def add(lines):
    m.execute("""const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const f=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder);
f.addMessage(%s.join('\\r\\n')); return 1;""" % json.dumps(lines))


def mail(author, subject, body, minutes_ago, html=False, mid=None):
    date = (now - timedelta(minutes=minutes_ago)).strftime('%a, %d %b %Y %H:%M:%S +0000')
    add(['From: ' + author, 'To: merritt@spark.test', 'Subject: ' + subject, 'Date: ' + date, 'Message-ID: <%s@trips.test>' % mid, 'MIME-Version: 1.0',
         'Content-Type: %s; charset=utf-8' % ('text/html' if html else 'text/plain'), 'X-Mozilla-Status: 0000', '', body, ''])


HOTEL = ('<p>Your stay is confirmed.</p><script type="application/ld+json">{"@context":"http://schema.org","@type":"LodgingReservation","reservationNumber":"CR-%d",'
         '"checkinTime":"%s","checkoutTime":"%s","reservationFor":{"@type":"LodgingBusiness","name":"Casa do Rio Hotel","address":{"streetAddress":"Rua das Flores 41","postalCode":"1200-193","addressLocality":"Lisbon","addressCountry":"PT"}}}</script>') % (
    RUN, CHECKIN.astimezone(LIS).isoformat(), CHECKOUT.astimezone(LIS).isoformat())
SUBJ = {'book': 'Your TAP booking %d' % RUN, 'hotel': 'Reservation confirmed: Casa do Rio %d' % RUN, 'ad': 'Fly to Lisbon from $99 %d' % RUN, 'gate': 'Gate change for TP 1351 %d' % RUN}

HELP = r"""const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, label, ms = 40000) => { const t = Date.now(); let v; while (!(v = await fn())) { if (Date.now() - t > ms) throw new Error('Timed out: ' + label); await pause(150); } return v; };
const byText = (sel, text) => [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(text));
const subjects = () => [...document.querySelectorAll('.row .subject')].map((s) => s.textContent);
"""


def app(js, seconds=90):
    start = ("const root = document.documentElement; root.removeAttribute('data-test-result');"
             "(async () => { %s %s })().then((v) => root.setAttribute('data-test-result', JSON.stringify({ ok: true, v: v === undefined ? null : v })),"
             "(e) => root.setAttribute('data-test-result', JSON.stringify({ ok: false, e: String(e) }))); return true;") % (HELP, js)
    spark.run_in_app(m, start)
    end = time.time() + seconds
    while time.time() < end:
        r = spark.run_in_app(m, "return document.documentElement.getAttribute('data-test-result');")
        if r:
            r = json.loads(r)
            if not r['ok']: raise RuntimeError(r['e'])
            return r['v']
        time.sleep(0.3)
    raise TimeoutError('step')


def clean():
    """Earlier runs' fixture emails out of the test Inbox (their flights would merge with this run's)."""
    return m.execute("""const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const f=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox');
const old=[...f.messages].filter((h)=>h.messageId.endsWith('@trips.test'));
if (old.length) f.deleteMessages(old, null, true, false, null, false); return old.length;""")


def alerts():
    return m.execute("return window.__tripAlerts.map(a => ({ title: a.title, text: a.text }));")


KEYS = ['aiSort', 'clefAccount', 'clefToken', 'travel', 'foldTripMail', 'travelAnswers', 'travelBookings', 'travelStatus', 'aiCategories', 'aiSortStatus']
m.execute("""const registrar=Components.manager.QueryInterface(Ci.nsIComponentRegistrar);const contract='@mozilla.org/alerts-service;1';
window.__tripAlerts=[]; window.__tripOrigCID=registrar.contractIDToCID(contract);
window.__tripCID=Components.ID('{'+Services.uuid.generateUUID().toString().slice(1,-1)+'}');
const fake={showAlert(alert){window.__tripAlerts.push({title:alert.title,text:alert.text,name:alert.name});},showAlertNotification(){},closeAlert(){},QueryInterface:ChromeUtils.generateQI(['nsIAlertsService'])};
window.__tripFactory={createInstance(iid){return fake.QueryInterface(iid);},QueryInterface:ChromeUtils.generateQI(['nsIFactory'])};
registrar.registerFactory(window.__tripCID,'Trips test alerts',contract,window.__tripFactory);
Services.prefs.setStringPref('extensions.spark.clefEndpoint', %s); return 1;""" % json.dumps('http://127.0.0.1:%d' % server.server_port))
before = spark.run_in_app(m, "return await messenger.storage.local.get(%s);" % json.dumps(KEYS))
result = {}
print('removed earlier fixtures:', clean())
time.sleep(2)
try:
    mail('TAP Air Portugal <noreply@flytap.com>', SUBJ['book'], 'Booking QX. Flight TP 1351 departs JFK Terminal 1 tonight, seat 14C. Return TP 207. Confirmation code QX7P2L.', 5, mid='book-%d' % RUN)
    mail('Booking.com <noreply@booking.com>', SUBJ['hotel'], HOTEL, 4, html=True, mid='hotel-%d' % RUN)
    mail('TAP Air Portugal <deals@flytap.com>', SUBJ['ad'], 'Sale! Lisbon from $99. Book by Sunday.', 3, mid='ad-%d' % RUN)
    mail('Ada Lovelace <ada@analytical.test>', 'Lunch %d' % RUN, 'Lunch on Friday?', 2, mid='lunch-%d' % RUN)
    spark.run_in_app(m, "await messenger.storage.local.set({ aiSort: true, clefAccount: '0123456789abcdef0123456789abcdef', clefToken: '%s', travel: true, foldTripMail: true, travelAnswers: {}, travelBookings: null }); return true;" % ('t' * 40))

    # 1. The background reads them (the cache saves the new mail first: ask until the trip is there).
    r = app("""const bookings = await wait(async () => { await messenger.runtime.sendMessage({ type: 'spark:travel' }); const b = (await messenger.storage.local.get('travelBookings')).travelBookings || []; return b.filter((x) => x.mid.includes('%d')).length >= 3 && b; }, 'bookings', 60000);
const answers = (await messenger.storage.local.get('travelAnswers')).travelAnswers;
return { bookings: bookings.filter((x) => x.mid.includes('%d')).map((b) => [b.kind, b.number || b.name, b.gate || '']), answers: Object.fromEntries(Object.entries(answers).filter(([k]) => k.includes('%d')).map(([k, v]) => [k.split('-')[0], v.src])) };""" % (RUN, RUN, RUN))
    assert sorted(r['bookings']) == sorted([['flight', 'TP 1351', 'B12'], ['hotel', 'Casa do Rio Hotel', ''], ['flight', 'TP 207', '']]), r
    assert r['answers'] == {'book': 'ai', 'hotel': 'markup', 'ad': 'none'}, r
    assert not any('Lunch' in a for a in asked) and not any('$99' in a for a in asked) and sum(SUBJ['book'] in a for a in asked) == 1, asked
    result['read'] = r

    # 2. Travel day: sidebar, the strip's flight card, folded mail.
    r = app("""document.querySelector('.sidebar .item')?.click(); await pause(800);
const side = await wait(() => byText('.sidebar .item', 'Lisbon trip'), 'sidebar trip');
const strip = await wait(() => document.querySelector('.trip.now .card') && document.querySelector('.trip.now'), 'trip card');
await wait(() => subjects().some((s) => s.includes('%s')), 'inbox listed');
const parts = (el) => [...el.querySelectorAll('b, small, .label, .count')].map((e) => e.textContent.trim()).join(' | ');
return { side: parts(side), head: parts(strip.querySelector('.head')), card: parts(strip.querySelector('.card')),
  folded: !subjects().some((s) => s.includes('%s') || s.includes('%s')), adListed: subjects().some((s) => s.includes('%s')) };""" % (SUBJ['ad'], SUBJ['book'], SUBJ['hotel'], SUBJ['ad']))
    assert r['side'] == 'Lisbon trip | Now' and 'travel day' in r['head'] and r['card'].startswith('TP 1351 to Lisbon · leaves') and 'Gate B12' in r['card'] and 'Seat 14C' in r['card'], r
    assert r['folded'] and r['adListed'], r
    result['travel_day'] = r
    spark.app_shot(m, str(args.output_dir / 'inbox.png'))

    # 3. The gate changes.
    m.execute("window.__tripAlerts = []; return 1;")
    mail('TAP Air Portugal <noreply@flytap.com>', SUBJ['gate'], 'Gate change: TP 1351 now departs from gate B27, boarding as planned. Confirmation QX7P2L.', 1, mid='gate-%d' % RUN)
    r = app("""await wait(async () => { await messenger.runtime.sendMessage({ type: 'spark:travel' }); const b = (await messenger.storage.local.get('travelBookings')).travelBookings || []; return b.some((x) => x.number === 'TP 1351' && x.gate === 'B27'); }, 'gate change', 60000);
const card = await wait(() => document.querySelector('.trip.now .card .warn-line') && document.querySelector('.trip.now .card'), 'change on the flight card');
return { warn: card.querySelector('.warn-line').textContent.trim(), card: [...card.querySelectorAll('b, small')].map((e) => e.textContent.trim()).join(' | '), separate: !!document.querySelector('.change') };""")
    end = time.time() + 10
    while time.time() < end and not alerts(): time.sleep(0.3)
    got = alerts()
    assert any(a['title'] == 'Gate changed: TP 1351 now leaves from B27' for a in got), got
    assert r['warn'] == 'Gate changed: TP 1351 now leaves from B27' and 'Gate B27 (was B12)' in r['card'] and not r['separate'], r
    result['change'] = {'pinned': r, 'notification': got}
    spark.app_shot(m, str(args.output_dir / 'change.png'))

    # 4. The trip page.
    r = app("""byText('.sidebar .item', 'Lisbon trip').click();
await wait(() => document.querySelector('.trip-page .head h2'), 'trip page');
await wait(() => document.querySelectorAll('.trip-page .mail li').length >= 3, 'trip emails', 30000);
const page = document.querySelector('.trip-page');
const out = { eyebrow: page.querySelector('.eyebrow').textContent, title: page.querySelector('h2').textContent, clock: page.querySelector('.clock')?.textContent || '',
  now: [...page.querySelectorAll('section[aria-label="Right now"] .card b')].map((b) => b.textContent),
  days: [...page.querySelectorAll('.day')].map((d) => [d.querySelector('.date').textContent, [...d.querySelectorAll('li')].map((li) => li.querySelector('.time').textContent.replace(/\\s+/g, ' ').trim() + ' | ' + li.querySelector('.what b').textContent + (li.querySelector('.badge') ? ' [' + li.querySelector('.badge').textContent + ']' : ''))]),
  emails: [...page.querySelectorAll('.mail li span')].map((s) => s.textContent) };
page.querySelector('.mail li button').click();
await wait(() => document.querySelector('.reader .reply-bar'), 'reader');
out.reader = !!document.querySelector('.reader');
return out;""")
    assert r['eyebrow'] == 'Travel day' and r['title'].startswith('Lisbon, ') and r['clock'].startswith('Lisbon '), r
    assert r['now'] and r['now'][0].startswith('TP 1351 to Lisbon'), r
    flat = [i for d in r['days'] for i in d[1]]
    assert any('Flight TP 1351 · JFK → LIS [updated]' in i for i in flat) and any('Land in Lisbon' in i and 'home' in i and 'updated' not in i for i in flat) and any('Check in, Casa do Rio Hotel' in i for i in flat) and any('Flight TP 207' in i for i in flat), r['days']
    assert sum(SUBJ['book'] in e or SUBJ['hotel'] in e or SUBJ['gate'] in e for e in r['emails']) == 3 and r['reader'], r
    result['page'] = r
    spark.app_shot(m, str(args.output_dir / 'trip.png'))

    # 5. Check-in reminder for the return flight.
    r = spark.run_in_app(m, "return (await messenger.alarms.getAll()).filter((a) => a.name.startsWith('spark-travel-checkin:')).map((a) => [a.name, Math.round((a.scheduledTime - Date.now()) / 3600000)]);")
    assert any('tp207' in a[0] for a in r), r
    result['checkin'] = r
    print(json.dumps(result, indent=2))
except Exception:
    print('DEBUG asked', len(asked), asked[-5:])
    print('DEBUG status', spark.run_in_app(m, "const s = await messenger.storage.local.get(['travelStatus','aiSortStatus']); return { travel: s.travelStatus, ai: s.aiSortStatus && { state: s.aiSortStatus.state, sorted: s.aiSortStatus.sorted, total: s.aiSortStatus.total }, now: Date.now() };"))
    raise
finally:
    spark.run_in_app(m, "await messenger.storage.local.set(%s); for (const a of await messenger.alarms.getAll()) if (a.name.startsWith('spark-travel-checkin:')) await messenger.alarms.clear(a.name); return true;" % json.dumps({k: before.get(k, v) for k, v in {'aiSort': False, 'clefAccount': '', 'clefToken': '', 'travel': True, 'foldTripMail': True, 'travelAnswers': {}, 'travelBookings': [], 'travelStatus': None, 'aiCategories': {}, 'aiSortStatus': None}.items()}))
    m.execute("Services.prefs.clearUserPref('extensions.spark.clefEndpoint'); const registrar=Components.manager.QueryInterface(Ci.nsIComponentRegistrar); registrar.registerFactory(window.__tripOrigCID,'','@mozilla.org/alerts-service;1',null); try{registrar.unregisterFactory(window.__tripCID,window.__tripFactory);}catch(e){} return 1;")
    server.shutdown()
    clean()
(args.output_dir / 'trips.json').write_text(json.dumps(result, indent=2) + '\n')
print('PASS')
