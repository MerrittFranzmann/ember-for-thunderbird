#!/usr/bin/env python3
"""Thunderbird's own calendars in Ember (1.0.2): a Gmail account's Google calendars, which Thunderbird syncs over
CalDAV. Isolated fixture profile only (port 2831), against the local mock CalDAV server (tools/caldav_mock.py) —
never Google. Thunderbird's calendar detection is pointed at the mock with the test-only pref
extensions.spark.testCalendarLocation.

A Gmail test account (IMAP to a closed local port, never fetched) has no calendar yet. Its mock server has
"Alex (Personal)" (writable: a coffee, Dana's invitation, a weekly meeting Alex organizes, an all-day birthday) and
"Holidays" (read-only: Founders Day).

Checks: the Calendar page offers "Connect Google Calendar · alex@gmail.com"; clicking it adds both calendars under
"Gmail test" with their events; the invitation can be accepted (PUT with PARTSTAT=ACCEPTED); own events offer
Edit/Delete, holidays are read-only; the editor lists Alex (Personal) but not Holidays; making an event with an
invitee, changing it, deleting one occurrence of the series (EXDATE) and deleting an event reach the server;
availability gives Alex's busy times from the calendar and Priya's from the server's free/busy; the agenda's read
includes the Google events; findInvitation finds Dana's meeting; hiding "Holidays". Screenshots light and dark.
Removes the account, the calendars, the pref, the certificate override and the settings it changed.

  test_google_calendar.py --output-dir DIR
"""
import argparse, json, re, tempfile, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
import spark
from caldav_mock import CalDavMock

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)

ME = 'alex@gmail.com'
midnight = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
at = lambda h, m=0, day=0: (midnight + timedelta(days=day, hours=h, minutes=m)).astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
day = lambda d=0: (midnight + timedelta(days=d)).strftime('%Y%m%d')


def vevent(uid, summary, start, end, extra=''):
    value = ';VALUE=DATE' if len(start) == 8 else ''
    return (f'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Ember tests//EN\r\nBEGIN:VEVENT\r\nUID:{uid}\r\nDTSTAMP:20260101T000000Z\r\n'
            f'DTSTART{value}:{start}\r\nDTEND{value}:{end}\r\nSUMMARY:{summary}\r\n{extra}END:VEVENT\r\nEND:VCALENDAR\r\n')


CALENDARS = {
    'personal': dict(name='Alex (Personal)', color='#16a765', events={
        'coffee.ics': vevent('coffee-1@ember.test', 'Coffee with Sam', at(9), at(9, 30), 'LOCATION:Blue Bottle\r\n'),
        'design.ics': vevent('design-1@ember.test', 'Design review', at(14), at(15),
                             'ORGANIZER;CN=Dana Whitfield:mailto:dana@ember.test\r\n'
                             'ATTENDEE;CN=Dana Whitfield;PARTSTAT=ACCEPTED;ROLE=CHAIR:mailto:dana@ember.test\r\n'
                             f'ATTENDEE;CN=Alex Morgan;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;ROLE=REQ-PARTICIPANT:mailto:{ME}\r\n'),
        'weekly.ics': vevent('weekly-1@ember.test', 'Weekly sync', at(11), at(11, 30),
                             f'RRULE:FREQ=WEEKLY\r\nORGANIZER;CN=Alex Morgan:mailto:{ME}\r\n'
                             'ATTENDEE;CN=Priya Nair;PARTSTAT=ACCEPTED:mailto:priya@ember.test\r\n'),
        'birthday.ics': vevent('bday-1@ember.test', "Sam's birthday", day(0), day(1), 'TRANSP:TRANSPARENT\r\n'),
    }),
    'holidays': dict(name='Holidays', color='#0b8043', read_only=True, events={
        'founders.ics': vevent('founders-1@ember.test', 'Founders Day', day(0), day(1), 'TRANSP:TRANSPARENT\r\n'),
    }),
}
BUSY = {'priya@ember.test': [(at(16), at(17))]}
SETTINGS = ['calendarMode', 'calendarHidden', 'calendarShown', 'calendarConnectHidden']

work = Path(tempfile.mkdtemp(dir=args.output_dir))
mock = CalDavMock(work, ME, CALENDARS, BUSY)
m = spark.connect()
def chrome(script, values=()):
    reply = m._cmd("WebDriver:ExecuteScript", {"script": script, "args": list(values)})
    return reply.get("value") if isinstance(reply, dict) else reply
def page(body):
    out = spark.run_in_app(m, body)
    if isinstance(out, str) and out.startswith('ERROR'):
        raise RuntimeError(out)
    return out
def sent(method, *parts):
    return [(p, b) for meth, p, h, b in mock.requests if meth == method and all(x in b or x in p for x in parts)]

HELPERS = r'''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { const v = test(); if (v) return v; await sleep(100); } return test(); };
const evByTitle = (title) => [...document.querySelectorAll('.calendar [data-key]')].find((b) => (b.getAttribute('aria-label') || '').startsWith(title + ','));
const pop = () => document.querySelector('.calendar .popover');
const side = () => document.querySelector('.cal-side');
const rows = () => [...side().querySelectorAll('.cal')].map((b) => ({ name: b.querySelector('.name').textContent.trim(), on: b.getAttribute('aria-checked') === 'true' }));
const heads = () => [...side().querySelectorAll('.account')].map((h) => h.textContent.trim());
const row = (name) => [...side().querySelectorAll('.cal')].find((b) => b.querySelector('.name').textContent.trim() === name);
const button = (root, text) => [...(root?.querySelectorAll('button') || [])].find((b) => b.textContent.trim() === text);
const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
const card = (c) => c && ({ title: c.querySelector('h2')?.textContent.trim(), note: c.querySelector('.shared-note')?.textContent.trim() || '',
  buttons: [...c.querySelectorAll('.actions button, .answers button')].map((b) => b.textContent.trim()), people: [...c.querySelectorAll('.people .name')].map((n) => n.textContent.trim()) });
const openCard = async (title) => { key('Escape'); await sleep(150); evByTitle(title).click(); await until(() => pop()?.querySelector('h2')?.textContent.trim() === title, 4000); await sleep(600); return card(pop()); };
const calId = async (name) => (await messenger.sparkCalendar.calendars()).find((c) => c.name === name)?.accountId;
'''
result = {}
account = None
try:
    mock.trust(chrome)
    account = chrome('''const [location, me] = arguments;
const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
Services.prefs.setStringPref("extensions.spark.testCalendarLocation", location);
const server = MailServices.accounts.createIncomingServer("alex.gmail.test", "127.0.0.1", "imap");
server.port = 1; server.loginAtStartUp = false; server.doBiff = false; server.prettyName = "Gmail test";
server.authMethod = Ci.nsMsgAuthMethod.passwordCleartext; server.password = "ember-test-password";
const account = MailServices.accounts.createAccount(); account.incomingServer = server;
const identity = MailServices.accounts.createIdentity(); identity.email = me; identity.fullName = "Alex Morgan"; account.addIdentity(identity);
return account.key;''', [mock.location, ME])
    result['before'] = page("return await messenger.storage.local.get(%s);" % json.dumps(SETTINGS))
    page("await messenger.storage.local.remove(['calendarConnectHidden']); location.reload(); return 1;")
    time.sleep(4)
    result['theme'] = page("const t = document.documentElement.dataset.theme || ''; document.documentElement.dataset.theme = 'light'; return t;")
    page(HELPERS + r'''[...document.querySelectorAll('.sidebar .item')].find((b) => b.textContent.trim() === 'Calendar').click();
await until(() => document.querySelector('.calendar .modes'));
[...document.querySelectorAll('.calendar .modes button')].find((b) => b.textContent.trim() === 'Week').click();
button(document.querySelector('.calendar .nav'), 'Today').click(); return 1;''')

    # 1. The offer to connect, then connecting.
    result['offer'] = page(HELPERS + r'''const offer = await until(() => [...side().querySelectorAll('.connect .add-link')].find((b) => b.textContent.includes('alex@gmail.com')), 10000);
return { text: offer ? offer.querySelector('.two-lines').innerText.replace(/\s+/g, ' ').trim() : '', heads: heads() };''')
    spark.app_shot(m, str(args.output_dir / 'google-calendar-offer.png'))
    result['connect'] = page(HELPERS + r'''[...side().querySelectorAll('.connect .add-link')].find((b) => b.textContent.includes('alex@gmail.com')).click();
await until(() => row('Alex (Personal)'), 30000);
await until(() => evByTitle('Coffee with Sam') && evByTitle('Founders Day'), 30000); await sleep(400);
const toast = [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()).join(' | ');
return { heads: heads(), rows: rows(), offerGone: ![...side().querySelectorAll('.connect')].length, toast,
  coffee: evByTitle('Coffee with Sam')?.getAttribute('aria-label'), weekly: !!evByTitle('Weekly sync'), birthday: !!evByTitle("Sam's birthday")?.closest('.all-day'),
  founders: !!evByTitle('Founders Day')?.closest('.all-day'), color: getComputedStyle(evByTitle('Coffee with Sam')).getPropertyValue('--c').trim(),
  list: await messenger.sparkCalendar.calendars() };''')

    # 2. Cards: the invitation, an own event, a read-only one.
    result['cards'] = page(HELPERS + r'''const design = await openCard('Design review');
const coffee = await openCard('Coffee with Sam');
const founders = await openCard('Founders Day');
key('Escape'); return { design, coffee, founders };''')

    # 3. Accept the invitation from its card.
    result['accept'] = page(HELPERS + r'''await openCard('Design review');
button(pop(), 'Accept').click();
await until(() => [...document.querySelectorAll('.toast')].some((t) => /Accepted/.test(t.textContent)), 10000);
const toast = [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()).join(' | ');
key('Escape'); await sleep(300);
const id = await calId('Alex (Personal)');
const s = new Date(); s.setHours(0, 0, 0, 0); const e = new Date(s); e.setDate(e.getDate() + 1);
const view = await messenger.sparkCalendar.calendarView(s.toISOString(), e.toISOString(), {});
return { toast, response: view.events.find((x) => x.subject === 'Design review')?.response, id };''')

    # 4. The editor's calendar list.
    result['editor'] = page(HELPERS + r'''key('Escape'); await sleep(150); key('n');
const select = await until(() => document.querySelector('select[aria-label="Calendar"]'), 5000);
const options = select ? [...select.options].map((o) => o.textContent.trim()) : [];
key('Escape'); await sleep(200);
const cancel = [...document.querySelectorAll('button')].find((b) => /^(Cancel|Discard)$/.test(b.textContent.trim()) && b.closest('[role="dialog"], .editor'));
cancel?.click(); await sleep(200);
return { options };''')

    # 5. Make, change and delete through the Experiment (as the editor does).
    result['edits'] = page(HELPERS + r'''const id = await calId('Alex (Personal)');
const start = new Date(); start.setHours(17, 0, 0, 0); const end = new Date(start); end.setHours(18);
const made = await messenger.sparkCalendar.createEvent(id, { subject: 'Ember launch', location: 'Studio', body: 'Bring the demo', start: start.toISOString(), end: end.toISOString(),
  allDay: false, freeBusy: 'Busy', reminder: 15, attendees: [{ name: 'Priya Nair', email: 'priya@ember.test' }], recurrence: null, timeZone: '' });
const details = await messenger.sparkCalendar.eventDetails(id, made.id);
await messenger.sparkCalendar.updateEvent(id, made.id, { subject: 'Ember launch party', freeBusy: 'Tentative' }, { send: true });
const changed = await messenger.sparkCalendar.eventDetails(id, made.id);
// One occurrence of the weekly series (next week's), then the coffee.
const s = new Date(); s.setHours(0, 0, 0, 0); const e = new Date(s); e.setDate(e.getDate() + 14);
const weekly = (await messenger.sparkCalendar.calendarView(s.toISOString(), e.toISOString(), {})).events.filter((x) => x.subject === 'Weekly sync');
const occurrence = await messenger.sparkCalendar.eventDetails(id, weekly[1].id);
await messenger.sparkCalendar.deleteEvent(id, weekly[1].id, {});
const after = (await messenger.sparkCalendar.calendarView(s.toISOString(), e.toISOString(), {})).events.filter((x) => x.subject === 'Weekly sync').length;
const coffee = (await messenger.sparkCalendar.calendarView(s.toISOString(), e.toISOString(), {})).events.find((x) => x.subject === 'Coffee with Sam');
await messenger.sparkCalendar.deleteEvent(id, coffee.id, {});
let refused = '';
try { await messenger.sparkCalendar.createEvent(await calId('Holidays'), { subject: 'Nope', start: start.toISOString(), end: end.toISOString() }); } catch (x) { refused = String(x.message || x); }
return { made, details: { subject: details.subject, location: details.location, body: details.body, reminder: details.reminder, response: details.response, attendees: details.attendees, type: details.type },
  changed: { subject: changed.subject, freeBusy: changed.freeBusy }, weeklyBefore: weekly.length, weeklyAfter: after, occurrenceType: occurrence.type, refused };''')

    # 6. Availability: Alex from the calendar, Priya from the server's free/busy.
    result['availability'] = page(HELPERS + r'''const id = await calId('Alex (Personal)');
const s = new Date(); s.setHours(0, 0, 0, 0); const e = new Date(s); e.setDate(e.getDate() + 1);
const people = await messenger.sparkCalendar.availability(id, ['alex@gmail.com', 'priya@ember.test', 'nobody@ember.test'], s.toISOString(), e.toISOString());
const t = (iso) => new Date(iso).toTimeString().slice(0, 5);
return people.map((p) => ({ email: p.email, busy: p.busy.map((b) => `${t(b.start)}-${t(b.end)} ${b.type}`).sort(), error: p.error || '' }));''')

    # 7. The agenda's read and the invitation lookup.
    result['agenda'] = page(r'''const s = new Date(); s.setHours(0, 0, 0, 0); const e = new Date(s); e.setDate(e.getDate() + 1);
const view = await messenger.sparkCalendar.calendarView(s.toISOString(), e.toISOString(), { details: true });
const found = await messenger.sparkCalendar.findInvitation('design-1@ember.test');
const none = await messenger.sparkCalendar.findInvitation('coffee-1@ember.test');
return { subjects: view.events.map((x) => x.subject).sort(), errors: view.errors, found, none,
  bodies: view.events.filter((x) => x.subject === 'Ember launch party').map((x) => x.body) };''')

    # Screenshots, then hide Holidays.
    page(HELPERS + "key('Escape'); location.reload(); return 1;")
    time.sleep(4)
    page(HELPERS + r'''document.documentElement.dataset.theme = 'light';
[...document.querySelectorAll('.sidebar .item')].find((b) => b.textContent.trim() === 'Calendar').click();
await until(() => document.querySelector('.calendar .modes'));
await until(() => evByTitle('Design review'), 15000); await sleep(500); return 1;''')
    spark.app_shot(m, str(args.output_dir / 'google-calendar-light.png'))
    page(HELPERS + "document.documentElement.dataset.theme = 'dark'; await sleep(200); evByTitle('Design review').click(); await sleep(800); return 1;")
    spark.app_shot(m, str(args.output_dir / 'google-calendar-dark.png'))
    result['hide'] = page(HELPERS + r'''key('Escape'); document.documentElement.dataset.theme = 'light';
row('Holidays').click(); await until(() => !evByTitle('Founders Day'), 6000);
return { hidden: !evByTitle('Founders Day'), row: rows().find((r) => r.name === 'Holidays'), saved: (await messenger.storage.local.get('calendarHidden')).calendarHidden };''')

    o, c, cards, acc, ed, av, ag, h = result['offer'], result['connect'], result['cards'], result['accept'], result['edits'], result['availability'], result['agenda'], result['hide']
    puts = [(p, b) for meth, p, hd, b in mock.requests if meth == 'PUT']
    deletes = [p for meth, p, hd, b in mock.requests if meth == 'DELETE']
    personal = [x for x in c['list'] if x['name'] == 'Alex (Personal)']
    holidays = [x for x in c['list'] if x['name'] == 'Holidays']
    avail = {p['email']: p for p in av}
    result['requests'] = [(meth, p, b[:300]) for meth, p, hd, b in mock.requests]
    result['checks'] = {
        'offer': o['text'] == 'Connect Google Calendar alex@gmail.com',
        'connected': 'Gmail test' in c['heads'] and ('Alex (Personal)', True) in [(r['name'], r['on']) for r in c['rows']] and ('Holidays', True) in [(r['name'], r['on']) for r in c['rows']]
            and c['offerGone'] and 'Added 2 calendars from Gmail test' in c['toast'],
        'listed': len(personal) == 1 and personal[0]['kind'] == 'thunderbird' and personal[0]['group'] == 'Gmail test' and personal[0]['email'] == ME and not personal[0]['readOnly']
            and len(holidays) == 1 and holidays[0]['readOnly'],
        'events_shown': c['coffee'] == 'Coffee with Sam, 9 AM to 9:30 AM, Blue Bottle' and c['weekly'] and c['birthday'] and c['founders'] and c['color'].lower() == '#16a765',
        'invitation_card': cards['design']['buttons'] == ['Accept', 'Maybe', 'Decline'] and 'Dana Whitfield' in cards['design']['people'],
        'own_card': cards['coffee']['buttons'] == ['Edit', 'Delete'],
        'read_only_card': cards['founders']['buttons'] == [] and cards['founders']['note'] == 'In your “Holidays” calendar, which Thunderbird reads but can\'t change.',
        'accepted': acc['response'] == 'accept' and 'Accepted' in acc['toast']
            and any('design' in p and re.search(r'PARTSTAT=ACCEPTED[^\r\n]*\r?\n?[^\r\n]*mailto:alex@gmail\.com|mailto:alex@gmail\.com', b.replace('\r\n ', '')) and re.search(r'ATTENDEE[^\n]*PARTSTAT=ACCEPTED[^\n]*alex@gmail\.com', b.replace('\r\n ', '')) for p, b in puts),
        'editor_calendars': 'Alex (Personal) (Gmail test)' in result['editor']['options'] and not any(x.startswith('Holidays') for x in result['editor']['options']),
        'created': ed['details']['subject'] == 'Ember launch' and ed['details']['location'] == 'Studio' and ed['details']['body'] == 'Bring the demo' and ed['details']['reminder'] == 15
            and ed['details']['response'] == 'organizer' and ed['made']['invited'] and ed['details']['type'] == 'Single'
            and any(a['email'] == 'priya@ember.test' for a in ed['details']['attendees'])
            and any('SUMMARY:Ember launch\r\n' in b and 'priya@ember.test' in b.replace('\r\n ', '') and 'ORGANIZER' in b for p, b in puts),
        'changed': ed['changed'] == {'subject': 'Ember launch party', 'freeBusy': 'Tentative'} and any('SUMMARY:Ember launch party' in b and 'X-MICROSOFT-CDO-BUSYSTATUS:TENTATIVE' in b for p, b in puts),
        'occurrence_deleted': ed['occurrenceType'] == 'Occurrence' and ed['weeklyBefore'] == 2 and ed['weeklyAfter'] == 1 and any('weekly' in p and 'EXDATE' in b for p, b in puts),
        'event_deleted': any('coffee' in p for p in deletes),
        'read_only_refused': 'can\'t add events' in ed['refused'],
        'availability': avail.get(ME, {}).get('busy') and all('Free' not in b for b in avail[ME]['busy']) and any(b.endswith('Busy') for b in avail[ME]['busy'])
            and len(avail.get('priya@ember.test', {}).get('busy', [])) == 1 and bool(avail.get('nobody@ember.test', {}).get('error')),
        'agenda': 'Design review' in ag['subjects'] and 'Founders Day' in ag['subjects'] and 'Coffee with Sam' not in ag['subjects'] and not ag['errors'] and ag['bodies'] == ['Bring the demo'],
        'find_invitation': bool(ag['found']) and ag['found']['response'] == 'accept' and ag['none'] is None,
        'hide': h['hidden'] and h['row'] == {'name': 'Holidays', 'on': False} and any(k.startswith('cal:') for k in h['saved'] or []),
        'only_mock_requests': len(mock.requests) > 0,
    }
finally:
    try:
        before = result.get('before') or {}
        page("await messenger.storage.local.set(%s); %s return 1;" % (json.dumps(before), "".join(f"await messenger.storage.local.remove('{k}');" for k in SETTINGS if k not in before)))
        page("document.documentElement.dataset.theme = %s; return 1;" % json.dumps(result.get('theme') or ''))
    except Exception as error:
        print('restore failed', error)
    try:
        result['cleanup'] = chrome('''const [key, port] = arguments;
const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const {cal} = ChromeUtils.importESModule('resource:///modules/calendar/calUtils.sys.mjs');
let removed = 0;
for (const c of cal.manager.getCalendars()) { if (String(c.uri.spec).includes(`localhost:${port}`)) { cal.manager.removeCalendar(c); removed++; } }
const account = key && MailServices.accounts.getAccount(key); if (account) MailServices.accounts.removeAccount(account, true);
Services.prefs.clearUserPref("extensions.spark.testCalendarLocation");
return removed;''', [account, mock.port])
    except Exception as error:
        print('cleanup failed', error)
    mock.untrust(chrome)
    mock.stop()
    try:
        spark.run_in_app(m, "document.querySelector('.sidebar .item.parent[aria-label^=\"Inbox\"]')?.click(); await new Promise(r => setTimeout(r, 300)); location.reload(); return 1;")
    except Exception:
        pass

(args.output_dir / 'google-calendar.json').write_text(json.dumps(result, indent=2, ensure_ascii=False, default=str))
print(json.dumps(result.get('checks'), indent=2))
ok = result.get('checks') and all(result['checks'].values())
print('ALL PASS' if ok else 'FAIL')
raise SystemExit(0 if ok else 1)
