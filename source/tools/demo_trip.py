#!/usr/bin/env python3
"""A fake Lisbon trip in the isolated fixture profile (port 2831), shown at five moments, with screenshots of the
real Ember: a week before, at the airport (then a gate change), just landed, before a meeting, after the trip.
Workers AI and Clef are a mock on 127.0.0.1; notifications go to a stand-in; nothing is fetched or sent.
The trip's times are set relative to now for each moment (the emails are re-added each time).

  demo_trip.py --output-dir DIR [--leave airport]
"""
import argparse, json, threading, time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
parser.add_argument('--leave', default='airport', help='moment left in place to explore')
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
m = spark.connect()
NY, LIS = ZoneInfo('America/New_York'), ZoneInfo('Europe/Lisbon')
loc = lambda dt, tz: dt.astimezone(tz).strftime('%Y-%m-%dT%H:%M')
NOW = datetime.now(timezone.utc).replace(second=0, microsecond=0)
state = {'dep': NOW, 'gate': 'B12', 'run': ''}


def trip_times(dep):
    """The whole trip from its departure: overnight to Lisbon, 4 nights, a walkthrough, a dinner, a car, home."""
    arr = dep + timedelta(hours=6, minutes=55)
    lis_day = lambda days, h, mi=0: datetime.combine((arr.astimezone(LIS) + timedelta(days=days)).date(), datetime.min.time(), LIS).replace(hour=h, minute=mi)
    return {
        'dep': dep, 'arr': arr, 'checkin': lis_day(0, 15), 'walk': lis_day(1, 10), 'dinner': lis_day(1, 20, 30),
        'car': lis_day(3, 9), 'carback': lis_day(4, 10), 'checkout': lis_day(4, 11), 'back': lis_day(4, 14, 45),
    }


def bookings_for(subject):
    t = trip_times(state['dep'])
    back_arr = t['back'] + timedelta(hours=7, minutes=45)
    if 'Booking confirmation' in subject or 'Gate change' in subject:
        gate = 'B27' if 'Gate change' in subject else 'B12'
        return [
            {'kind': 'flight', 'status': 'changed' if gate == 'B27' else 'confirmed', 'provider': 'TAP Air Portugal', 'number': 'TP 1351', 'from_code': 'JFK', 'from_city': 'New York', 'to_code': 'LIS', 'to_city': 'Lisbon', 'confirmation': 'QX7P2L', 'seat': '14C', 'gate': gate, 'terminal': '1',
             'start_local': loc(t['dep'], NY), 'start_timezone': 'America/New_York', 'end_local': loc(t['arr'], LIS), 'end_timezone': 'Europe/Lisbon'},
            {'kind': 'flight', 'status': 'confirmed', 'provider': 'TAP Air Portugal', 'number': 'TP 207', 'from_code': 'LIS', 'from_city': 'Lisbon', 'to_code': 'JFK', 'to_city': 'New York', 'confirmation': 'QX7P2L', 'seat': '22A',
             'start_local': loc(t['back'], LIS), 'start_timezone': 'Europe/Lisbon', 'end_local': loc(back_arr, NY), 'end_timezone': 'America/New_York'},
        ]
    if 'Atlantico' in subject:
        return [{'kind': 'car', 'status': 'confirmed', 'provider': 'Atlântico Car Rental', 'name': 'Terminal 1 arrivals desk', 'address': 'Aeroporto de Lisboa, Terminal 1', 'city': 'Lisbon', 'confirmation': 'ATL-7731',
                 'start_local': loc(t['car'], LIS), 'start_timezone': 'Europe/Lisbon', 'end_local': loc(t['carback'], LIS), 'end_timezone': 'Europe/Lisbon'}]
    if 'Film Forum' in subject:
        return [{'kind': 'event', 'status': 'confirmed', 'name': 'Film Forum walkthrough', 'address': 'LX Factory, Rua Rodrigues de Faria 103, Lisboa', 'city': 'Lisbon', 'start_local': loc(t['walk'], LIS), 'start_timezone': 'Europe/Lisbon'}]
    if 'Taberna' in subject:
        return [{'kind': 'restaurant', 'status': 'confirmed', 'name': 'Dinner at Taberna Alfama', 'address': 'Rua de São Miguel 20, Lisboa', 'city': 'Lisbon', 'confirmation': 'OT-55120', 'start_local': loc(t['dinner'], LIS), 'start_timezone': 'Europe/Lisbon'}]
    return []


class MockAI(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)) or b'{}')
        if self.path.endswith('/llm'):
            subject = body['messages'][1]['content'].split('\n')[1]
            answer = {'result': {'response': {'bookings': bookings_for(subject)}}, 'success': True}
        else:  # AI sorting (Clef): only receipts matter for the demo; below 75% the rules keep sorting.
            subject = str(body.get('state', {}).get('subject', ''))
            receipt = 0.95 if any(w in subject for w in ('receipt', 'Receipt', 'Your trip with Uber', 'Your invoice')) else 0.02
            answer = {'result': {'answers': {'kind': {'choice': 'updates', 'confidence': 0.5}, 'reply': 0.05, 'important': 0.1, 'receipt': receipt, 'promotion': 0.02}}, 'success': True}
        data = json.dumps(answer).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)
    def log_message(self, *a): pass


server = HTTPServer(('127.0.0.1', 0), MockAI)
threading.Thread(target=server.serve_forever, daemon=True).start()


def add(author, subject, body, sent, mid, html=False):
    date = sent.strftime('%a, %d %b %Y %H:%M:%S +0000')
    lines = ['From: ' + author, 'To: Merritt Franzmann <merritt@spark.test>', 'Subject: ' + subject, 'Date: ' + date, 'Message-ID: <%s-%s@demo-trip.test>' % (mid, state['run']), 'MIME-Version: 1.0',
             'Content-Type: %s; charset=utf-8' % ('text/html' if html else 'text/plain'), 'Content-Transfer-Encoding: 8bit', 'X-Mozilla-Status: 0000', '', body, '']
    m.execute("""const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const f=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder);
f.addMessage(%s.join('\\r\\n')); return 1;""" % json.dumps(lines))


def clean():
    return m.execute("""const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
let n=0; for (const name of ['Inbox']) { const f=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed(name);
const old=[...f.messages].filter((h)=>h.messageId.endsWith('@demo-trip.test') || h.messageId.endsWith('@trips.test')); n+=old.length; if (old.length) f.deleteMessages(old, null, true, false, null, false); } return n;""")


def fmt(dt, tz, f='%a %b %-d, %-I:%M %p'):
    return dt.astimezone(tz).strftime(f)


def gate_email(t):
    add('TAP Air Portugal <noreply@flytap.com>', 'Gate change for TP 1351 to Lisbon',
        'TP 1351 to Lisbon now departs from gate B27 (was B12). Boarding as planned. Booking QX7P2L.', min(NOW - timedelta(minutes=2), t['dep'] - timedelta(minutes=95)), 'gate')


def seed(moment):
    """The trip's emails as they'd have arrived by this moment."""
    t = trip_times(state['dep'])
    booked = min(NOW - timedelta(days=1), t['dep'] - timedelta(days=21))
    add('TAP Air Portugal <noreply@flytap.com>', 'Booking confirmation QX7P2L - New York to Lisbon',
        f"""Dear Merritt Franzmann,\n\nThank you for flying with TAP Air Portugal. Your booking is confirmed.\n\nBooking reference: QX7P2L\n\nOUTBOUND\nTP 1351 · {fmt(t['dep'], NY)}\nNew York (JFK) Terminal 1 → Lisbon (LIS) Terminal 1\nArrives {fmt(t['arr'], LIS)} (Lisbon time)\nSeat 14C · Economy\n\nRETURN\nTP 207 · {fmt(t['back'], LIS)}\nLisbon (LIS) → New York (JFK)\nSeat 22A · Economy\n\nOnline check-in opens 36 hours before departure.\n\nObrigado,\nTAP Air Portugal""", booked, 'tap-booking')
    hotel = ('<p>Hi Merritt,</p><p>Your stay at <b>Casa do Rio Hotel</b> is confirmed. Breakfast is included and the room is paid.</p>'
             f'<p>Check-in: {fmt(t["checkin"], LIS)} (from 3 PM; bags from 8 AM)<br>Check-out: {fmt(t["checkout"], LIS)}<br>Confirmation number: CR-48213</p>'
             '<p>Rua das Flores 41, 1200-193 Lisboa, Portugal · +351 21 000 4821</p><p>Booking.com</p>'
             '<script type="application/ld+json">' + json.dumps({'@context': 'http://schema.org', '@type': 'LodgingReservation', 'reservationNumber': 'CR-48213', 'reservationStatus': 'http://schema.org/Confirmed',
             'checkinTime': t['checkin'].isoformat(), 'checkoutTime': t['checkout'].isoformat(),
             'reservationFor': {'@type': 'LodgingBusiness', 'name': 'Casa do Rio Hotel', 'address': {'@type': 'PostalAddress', 'streetAddress': 'Rua das Flores 41', 'postalCode': '1200-193', 'addressLocality': 'Lisbon', 'addressCountry': 'PT'}}}) + '</script>')
    add('Booking.com <noreply@booking.com>', 'Your booking is confirmed: Casa do Rio Hotel, Lisbon', hotel, booked + timedelta(hours=2), 'hotel', html=True)
    add('Atlantico Car Rental <reservations@atlanticorentacar.com>', 'Atlantico reservation ATL-7731 confirmed',
        f"""Hello Merritt,\n\nYour car is reserved.\nPick-up: {fmt(t['car'], LIS)}, Terminal 1 arrivals desk, Lisbon Airport\nReturn: {fmt(t['carback'], LIS)}, same location\nReservation ATL-7731 · Compact (Renault Clio or similar)\nPlease bring your driving licence and a credit card.\n\nAtlântico""", booked + timedelta(days=3), 'car')
    add('Eventbrite <noreply@eventbrite.com>', 'Your ticket: Lisbon Film Forum venue walkthrough',
        f"""Hi Merritt,\n\nYour registration is confirmed.\nLisbon Film Forum: venue walkthrough\n{fmt(t['walk'], LIS)} (Lisbon time)\nLX Factory, Rua Rodrigues de Faria 103, Building G, 2nd floor, Lisboa\nOrder #4471902 · 1 ticket\n\nHosted by Marco Bellini and Ana Costa.""", booked + timedelta(days=9), 'walk')
    add('OpenTable <reservations@opentable.com>', 'Your reservation at Taberna Alfama is confirmed',
        f"""Your table for 4 at Taberna Alfama is confirmed: {fmt(t['dinner'], LIS)}.\nRua de São Miguel 20, Lisboa · Confirmation OT-55120""", booked + timedelta(days=10), 'dinner')
    if moment in ('landed', 'meeting', 'after'):
        gate_email(t)
    if moment in ('meeting', 'after'):
        add('Uber Receipts <noreply@uber.com>', 'Your trip with Uber: Lisbon Airport to Rua das Flores', 'Total €18.40 · Thanks for riding, Merritt.', t['arr'] + timedelta(hours=1), 'uber1')
    if moment == 'after':
        add('Casa do Rio Hotel <frontdesk@casadorio.pt>', 'Your invoice from Casa do Rio Hotel', 'Invoice CR-48213: 4 nights, €612.00, paid by card ending 4421.', t['checkout'] - timedelta(hours=2), 'hotel-invoice')
        add('Atlantico Car Rental <reservations@atlanticorentacar.com>', 'Your receipt for reservation ATL-7731', 'Rental total €96.30 including fuel. Thank you!', t['carback'] + timedelta(hours=1), 'car-receipt')
        add('Uber Receipts <noreply@uber.com>', 'Your trip with Uber: Rua das Flores to Lisbon Airport', 'Total €16.10.', t['checkout'] + timedelta(hours=1), 'uber2')
    add('Priya Shah <priya@northwind.test>', 'Edit budget for the spring series', 'Two options attached. Could you pick one by Monday?', NOW - timedelta(minutes=40), 'priya')


HELP = r"""const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn, label, ms = 60000) => { const t = Date.now(); let v; while (!(v = await fn())) { if (Date.now() - t > ms) throw new Error('Timed out: ' + label); await pause(200); } return v; };
const byText = (sel, text) => [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(text));
"""


def app(js, seconds=240):
    for _ in range(60):
        here = spark.run_in_app(m, "return location.href;")
        if isinstance(here, str) and 'app.html' in here: break
        time.sleep(1)
    start = ("const root = document.documentElement; root.removeAttribute('data-demo');"
             "(async () => { %s %s })().then((v) => root.setAttribute('data-demo', JSON.stringify({ ok: true, v: v === undefined ? null : v })),"
             "(e) => root.setAttribute('data-demo', JSON.stringify({ ok: false, e: String(e) }))); return true;") % (HELP, js)
    spark.run_in_app(m, start)
    end = time.time() + seconds
    while time.time() < end:
        r = spark.run_in_app(m, "return document.documentElement.getAttribute('data-demo');")
        if isinstance(r, str) and r.startswith('ERROR'): raise RuntimeError(r)
        if r:
            r = json.loads(r)
            if not r['ok']: raise RuntimeError(r['e'])
            return r['v']
        time.sleep(0.4)
    raise TimeoutError('step')


def size(w, h):
    m.execute("""for (const win of Services.wm.getEnumerator('mail:extensionPopup')) { const b = win.document.querySelector('browser'); if (b?.currentURI?.spec.includes('/app.html')) { win.resizeTo(%d, %d); } } return 1;""" % (w, h))
    time.sleep(1.2)


def shot(name):
    spark.app_shot(m, str(args.output_dir / name))
    print('  ', name)


m.execute("""const registrar=Components.manager.QueryInterface(Ci.nsIComponentRegistrar);const contract='@mozilla.org/alerts-service;1';
if (!window.__demoCID) { window.__demoAlerts=[]; window.__demoOrigCID=registrar.contractIDToCID(contract); window.__demoCID=Components.ID('{'+Services.uuid.generateUUID().toString().slice(1,-1)+'}');
const fake={showAlert(alert){window.__demoAlerts.push({title:alert.title,text:alert.text});},showAlertNotification(){},closeAlert(){},QueryInterface:ChromeUtils.generateQI(['nsIAlertsService'])};
window.__demoFactory={createInstance(iid){return fake.QueryInterface(iid);},QueryInterface:ChromeUtils.generateQI(['nsIFactory'])};
registrar.registerFactory(window.__demoCID,'Demo alerts',contract,window.__demoFactory); }
Services.prefs.setStringPref('extensions.spark.clefEndpoint', %s); return 1;""" % json.dumps('http://127.0.0.1:%d' % server.server_port))

def clock(at):
    """Ember's trip clock at this moment (storage clockOffset; 0 = real time)."""
    offset = 0 if at is None else int((at - datetime.now(timezone.utc)).total_seconds() * 1000)
    spark.run_in_app(m, "await messenger.storage.local.set({ clockOffset: %d }); return true;" % offset)
    time.sleep(1.5)


def capture(name, inbox=True):
    size(1500, 1000)
    if inbox:
        app("document.querySelector('.sidebar .item')?.click(); await pause(1500); return true;")
        shot(f'{name}-inbox.png')
    app("""byText('.sidebar .item', 'Lisbon trip').click(); await wait(() => document.querySelector('.trip-page h2'), 'trip page'); await pause(1500); return true;""")
    size(1100, 1900)
    shot(f'{name}-trip.png')


notes = {}
try:
    # One trip in real time: TAP's overnight flight leaves about 75 minutes from now.
    dep = (NOW + timedelta(minutes=75)).replace(minute=(NOW.minute // 5) * 5) + timedelta(minutes=5)
    state['dep'] = dep; state['run'] = 'live%d' % time.time()
    t = trip_times(dep)
    back_arr = t['back'] + timedelta(hours=7, minutes=45)
    print('departure', dep.isoformat())
    clean(); time.sleep(2.5)
    spark.run_in_app(m, "await messenger.storage.local.set({ clockOffset: 0, aiSort: true, clefAccount: '0123456789abcdef0123456789abcdef', clefToken: '%s', travel: true, foldTripMail: true, travelAnswers: {}, travelBookings: null, aiCategories: {} }); return true;" % ('d' * 40))
    seed('before')
    app("""await messenger.runtime.sendMessage({ type: 'spark:cache', command: 'refresh' }).catch(() => {});
await wait(async () => { await messenger.runtime.sendMessage({ type: 'spark:travel' }); const b = (await messenger.storage.local.get('travelBookings')).travelBookings || []; return b.length >= 6; }, 'bookings', 180000);
document.querySelector('.sidebar .item')?.click(); await pause(1200); await wait(() => byText('.sidebar .item', 'Lisbon trip'), 'sidebar'); return true;""")

    print('before'); clock(dep - timedelta(days=5, hours=1)); capture('before')

    print('airport')  # real time: the gate changes while you wait
    clock(None)
    m.execute("window.__demoAlerts = []; return 1;")
    gate_email(t)
    app("""await messenger.runtime.sendMessage({ type: 'spark:cache', command: 'refresh' }).catch(() => {});
await wait(async () => { await messenger.runtime.sendMessage({ type: 'spark:travel' }); const b = (await messenger.storage.local.get('travelBookings')).travelBookings || []; return b.some((x) => x.gate === 'B27'); }, 'gate change', 180000); await pause(1500); return true;""")
    end = time.time() + 10
    while time.time() < end and not m.execute("return window.__demoAlerts.length;"): time.sleep(0.3)
    notes['airport'] = m.execute("return window.__demoAlerts.map(a => [a.title, a.text]);")
    print('   notification', notes['airport'])
    capture('airport')

    print('landed'); clock(t['arr'] + timedelta(minutes=35)); capture('landed')
    print('meeting'); clock(t['walk'] - timedelta(minutes=40)); capture('meeting')

    print('after')
    for author, subject, body, when, mid in [
        ('Uber Receipts <noreply@uber.com>', 'Your trip with Uber: Lisbon Airport to Rua das Flores', 'Total EUR 18.40. Thanks for riding, Merritt.', t['arr'] + timedelta(hours=1), 'uber1'),
        ('Casa do Rio Hotel <frontdesk@casadorio.pt>', 'Your invoice from Casa do Rio Hotel', 'Invoice CR-48213: 4 nights, EUR 612.00, paid by card ending 4421.', t['checkout'] - timedelta(hours=2), 'hotel-invoice'),
        ('Atlantico Car Rental <reservations@atlanticorentacar.com>', 'Your receipt for reservation ATL-7731', 'Rental total EUR 96.30 including fuel. Thank you!', t['carback'] + timedelta(hours=1), 'car-receipt'),
        ('Uber Receipts <noreply@uber.com>', 'Your trip with Uber: Rua das Flores to Lisbon Airport', 'Total EUR 16.10.', t['checkout'] + timedelta(hours=1), 'uber2'),
    ]:
        add(author, subject, body, when, mid)
    app("""await messenger.runtime.sendMessage({ type: 'spark:cache', command: 'refresh' }).catch(() => {});
await wait(async () => { const a = (await messenger.storage.local.get('aiCategories')).aiCategories || {}; return Object.keys(a).filter((k) => /uber|invoice|receipt/.test(k)).length >= 4; }, 'receipts sorted', 180000); await pause(1500); return true;""")
    clock(back_arr + timedelta(hours=20)); capture('after', inbox=False)
finally:
    # Left as it really is: the trip leaves in about an hour (real time), the receipts (dated next week) removed.
    spark.run_in_app(m, "await messenger.storage.local.set({ clockOffset: 0, aiSort: false }); return true;")
    m.execute("""const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const f=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox');
const r=[...f.messages].filter((h)=>/^(uber|hotel-invoice|car-receipt)/.test(h.messageId) && h.messageId.endsWith('@demo-trip.test')); if (r.length) f.deleteMessages(r, null, true, false, null, false);
Services.prefs.clearUserPref('extensions.spark.clefEndpoint'); return 1;""")
    size(1300, 900)
    server.shutdown()
(args.output_dir / 'demo.json').write_text(json.dumps(notes, indent=2) + '\n')
print('done')
