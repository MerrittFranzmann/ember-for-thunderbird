#!/usr/bin/env python3
"""Shared and extra calendars (0.1.126), isolated fixture profile only (port 2831), against the local mock EWS
(tools/ews_mock.py) with two Exchange test accounts.

Account A has an extra calendar ("US Holidays") and, in a deleted folder, one that must not show; its Outlook
calendar list links Dana's calendar (readable in full, through the linked folder) and a link nobody resolves.
Priya shares only busy times with subject and place; Oliver only busy times.

Checks: the sidebar lists Calendar, US Holidays (off), B's Calendar and Shared: Dana (off), nothing else; ticking
Dana reads her linked folder and shows her events read-only (no Edit/Delete/answers, "On Dana Whitfield's
calendar", her invitees); ticking US Holidays shows its all-day event; adding Priya (by "Name <address>") falls
back from a refused calendar read to free/busy with details ("Board prep", "busy only"); adding Oliver shows
"Busy"; an own meeting overlapping Dana's doesn't say it overlaps; the agenda's calendar read has none of the shared
events; hiding Dana and removing Priya; light and dark screenshots. Puts back the settings it changed, removes both
accounts and the certificate override. Never contacts an external server.

  test_shared_calendars.py --output-dir DIR
"""
import argparse, json, re, tempfile, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
import spark
from ews_mock import EwsMock

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)

midnight = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
at = lambda h, m=0, day=0: (midnight + timedelta(days=day, hours=h, minutes=m)).astimezone(timezone.utc)
DANA = ('Dana Whitfield', 'dana@spark.test')
SOFIA = ('Sofia Reyes', 'sofia@spark.test')
ME = ('Merritt (EWS test)', 'merritt-a@ews.test')
DN_DANA = '/o=ExchangeLabs/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=4f2a-dana'
DN_NOBODY = '/o=ExchangeLabs/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=9e1b-left'
EVENTS = {
    'A': {'SCRIPT': dict(subject='Script review', start=at(13, 30), end=at(14, 30), my='Organizer', organizer=ME),
          # An all-day event Exchange keeps as midnight to midnight UTC (7 PM to 7 PM in New York): today only.
          'BDAY': dict(subject='Tessie birthday', start=datetime(midnight.year, midnight.month, midnight.day, tzinfo=timezone.utc),
                       end=datetime(midnight.year, midnight.month, midnight.day, tzinfo=timezone.utc) + timedelta(days=1), all_day=True, my='Organizer')},
    'B': {'TRAILER': dict(subject='Trailer review', start=at(11), end=at(12), my='Accept')},
}
OTHERS = {
    'folders': {'A': {'FOLDER-HOL': ('US Holidays', {'HOL1': dict(subject='Founders Day', start=at(0), end=at(0, day=1), all_day=True, my='Organizer', busy='Free')})}},
    'links': {'A': [('Dana Whitfield', DN_DANA, '0A0B0C'), ('Former colleague', DN_NOBODY, '0D0E')]},
    'people': {DN_DANA: DANA},
    'mailboxes': {
        'dana@spark.test': dict(access='full', folders={'0A0B0C': 'DANA-CAL'}, events={
            'DANA1': dict(subject='Client pitch', start=at(13), end=at(14), my='Organizer', organizer=DANA, attendees=[(SOFIA, 'Accept')], body='Pitch deck v3', location='Room 4')}),
        'priya@spark.test': dict(access='busy', details=True, events={
            'P1': dict(subject='Board prep', start=at(10), end=at(11), location='Room 2'),
            'P2': dict(subject='Dentist', start=at(16), end=at(17), busy='OOF')}),
        'oliver@spark.test': dict(access='busy', details=False, events={'O1': dict(subject='Secret', start=at(15), end=at(15, 45))}),
    },
}
SETTINGS = ['calendarMode', 'calendarHidden', 'calendarShown', 'calendarPeople']

work = Path(tempfile.mkdtemp(dir=args.output_dir))
mock = EwsMock(work, EVENTS, others=OTHERS)
m = spark.connect()
def chrome(script, values=()):
    reply = m._cmd("WebDriver:ExecuteScript", {"script": script, "args": list(values)})
    return reply.get("value") if isinstance(reply, dict) else reply
def page(body):
    out = spark.run_in_app(m, body)
    if isinstance(out, str) and out.startswith('ERROR'):
        raise RuntimeError(out)
    return out
def sent(*parts):
    return [b for w, b in mock.requests if all(p in b for p in parts)]

HELPERS = r'''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { const v = test(); if (v) return v; await sleep(100); } return test(); };
const evByTitle = (title) => [...document.querySelectorAll('.calendar [data-key]')].find((b) => (b.getAttribute('aria-label') || '').startsWith(title + ','));
const pop = () => document.querySelector('.calendar .popover');
const side = () => document.querySelector('.cal-side');
const rows = () => [...side().querySelectorAll('.cal')].map((b) => ({ name: b.querySelector('.name').textContent.trim(), on: b.getAttribute('aria-checked') === 'true', flag: b.querySelector('.flag')?.textContent.trim() || '' }));
const heads = () => [...side().querySelectorAll('.account')].map((h) => h.textContent.trim());
const row = (name) => [...side().querySelectorAll('.cal')].find((b) => b.querySelector('.name').textContent.trim() === name);
const button = (root, text) => [...(root?.querySelectorAll('button') || [])].find((b) => b.textContent.trim() === text);
const key = (k) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
const card = (c) => c && ({ title: c.querySelector('h2')?.textContent.trim(), cal: c.querySelector('.cal')?.textContent.trim(), note: c.querySelector('.shared-note')?.textContent.trim() || '',
  warn: [...c.querySelectorAll('.warn')].map((w) => w.textContent.trim()), people: [...c.querySelectorAll('.people .name')].map((n) => n.textContent.trim()),
  buttons: [...c.querySelectorAll('.actions button, .answers button')].map((b) => b.textContent.trim()), notes: c.querySelector('.notes')?.textContent.trim() || '' });
const openCard = async (title) => { key('Escape'); await sleep(150); evByTitle(title).click(); await until(() => pop()?.querySelector('h2')?.textContent.trim() === title || pop()?.querySelector('h2')?.textContent.trim() === 'Busy', 4000); await sleep(500); return card(pop()); };
const saved = async () => messenger.storage.local.get(['calendarShown', 'calendarPeople']);
'''
result = {}
accounts = []
try:
    accounts = mock.add_accounts(chrome)
    result['before'] = page("return await messenger.storage.local.get(%s);" % json.dumps(SETTINGS))
    page("await messenger.storage.local.remove(['calendarShown', 'calendarPeople']); location.reload(); return 1;")
    time.sleep(4)
    result['theme'] = page("const t = document.documentElement.dataset.theme || ''; document.documentElement.dataset.theme = 'light'; return t;")
    page(HELPERS + r'''[...document.querySelectorAll('.sidebar .item')].find((b) => b.textContent.trim() === 'Calendar').click();
await until(() => document.querySelector('.calendar .modes'));
[...document.querySelectorAll('.calendar .modes button')].find((b) => b.textContent.trim() === 'Week').click();
button(document.querySelector('.calendar .nav'), 'Today').click();
await until(() => evByTitle('Script review'), 12000); return 1;''')

    # 1. The list: own calendars and the extra one, then Shared with Dana (both off).
    result['list'] = page(HELPERS + r'''await until(() => row('Dana Whitfield'), 12000); await sleep(300);
const cells = [...document.querySelectorAll('.calendar .all-day')];
const birthday = cells.map((c, i) => [...c.querySelectorAll('[data-key]')].some((b) => b.getAttribute('aria-label').startsWith('Tessie birthday,')) ? i : -1).filter((i) => i >= 0);
const today = [...document.querySelectorAll('.calendar .col-head')].findIndex((h) => h.classList.contains('today'));
return { birthday, today, heads: heads(), rows: rows(), hint: side().querySelector('.empty')?.textContent.trim() || '', link: !!button(side(), 'Add a calendar'), shown: !!evByTitle('Client pitch') };''')

    # 2. Tick Dana: her linked folder, read-only.
    result['dana'] = page(HELPERS + r'''row('Dana Whitfield').click();
await until(() => evByTitle('Client pitch'), 10000); await sleep(300);
const look = getComputedStyle(evByTitle('Client pitch')).getPropertyValue('--c').trim();
const c = await openCard('Client pitch');
await until(() => pop()?.querySelector('.people .name'), 4000); await sleep(200);
return { row: rows().find((r) => r.name === 'Dana Whitfield'), label: evByTitle('Client pitch').getAttribute('aria-label'), color: look, card: card(pop()), saved: await saved() };''')

    # 3. Own meeting at the same time: no overlap with Dana's.
    result['own'] = page(HELPERS + "return await openCard('Script review');")

    # 4. Tick US Holidays.
    result['holidays'] = page(HELPERS + r'''key('Escape'); await sleep(150); row('US Holidays').click();
await until(() => evByTitle('Founders Day'), 10000);
return { inAllDay: !!evByTitle('Founders Day')?.closest('.all-day'), card: await openCard('Founders Day') };''')

    # 5. Add Priya by "Name <address>": busy times with what she shares.
    page(HELPERS + r'''key('Escape'); await sleep(150);
button(side(), 'Add a calendar').click(); await until(() => side().querySelector('#calendar-add-person'));
const input = side().querySelector('#calendar-add-person');
input.value = 'Priya Nair <priya@spark.test>'; input.dispatchEvent(new Event('input', { bubbles: true }));
input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await sleep(400); return 1;''')
    spark.app_shot(m, str(args.output_dir / 'shared-calendars-add.png'))
    result['priya'] = page(HELPERS + r'''const chips = [...side().querySelectorAll('.chip-name')].map((c) => c.textContent.trim());
button(side(), 'Add').click();
await until(() => evByTitle('Board prep') && rows().find((r) => r.name === 'Priya Nair')?.flag, 12000); await sleep(300);
return { chips, row: rows().find((r) => r.name === 'Priya Nair'), formClosed: !side().querySelector('#calendar-add-person'), label: evByTitle('Board prep')?.getAttribute('aria-label'),
  dentist: !!evByTitle('Dentist'), card: await openCard('Board prep'), saved: await saved() };''')

    # 6. Add Oliver: only when he's busy.
    result['oliver'] = page(HELPERS + r'''key('Escape'); await sleep(150);
button(side(), 'Add a calendar').click(); await until(() => side().querySelector('#calendar-add-person'));
const input = side().querySelector('#calendar-add-person');
input.value = 'oliver@spark.test'; input.dispatchEvent(new Event('input', { bubbles: true }));
input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await sleep(250);
button(side(), 'Add').click();
await until(() => evByTitle('Busy'), 12000); await sleep(300);
return { rows: rows(), card: await openCard('Busy'), secret: !!evByTitle('Secret') };''')

    # Screenshots with every calendar shown.
    page(HELPERS + "key('Escape'); await sleep(300); return 1;")
    spark.app_shot(m, str(args.output_dir / 'shared-calendars-light.png'))
    page(HELPERS + "document.documentElement.dataset.theme = 'dark'; await sleep(200); evByTitle('Client pitch').click(); await sleep(700); return 1;")
    spark.app_shot(m, str(args.output_dir / 'shared-calendars-dark.png'))
    page(HELPERS + "key('Escape'); document.documentElement.dataset.theme = 'light'; return 1;")

    # 7. The agenda's own read (calendarView) has none of the shared events.
    result['agenda'] = page(r'''const now = new Date(); const s = new Date(now); s.setHours(0, 0, 0, 0); const e = new Date(s); e.setDate(e.getDate() + 1);
const view = await messenger.sparkCalendar.calendarView(s.toISOString(), e.toISOString(), {}); return view.events.map((x) => x.subject).sort();''')

    # 8. Hide Dana; remove Priya.
    result['hide'] = page(HELPERS + r'''row('Dana Whitfield').click(); await until(() => !evByTitle('Client pitch'), 6000);
const hidden = !evByTitle('Client pitch');
const r = row('Priya Nair').closest('.row'); r.querySelector('.remove').click();
await until(() => !row('Priya Nair') && !evByTitle('Board prep'), 6000);
return { hidden, priyaGone: !row('Priya Nair'), eventsGone: !evByTitle('Board prep'), rows: rows(), saved: await saved() };''')

    a_key = accounts[0]
    dana_key = f'{a_key}|dana@spark.test|DANA-CAL'
    l, d, p, o, h = result['list'], result['dana'], result['priya'], result['oliver'], result['hide']
    other_reads = sent('<m:FindItem', 'calendar:Start')
    result['requests'] = [(w, re.sub(r'<\?xml.*?<soap:Body>', '', b)[:400]) for w, b in mock.requests if 'GetItem' not in b]
    result['checks'] = {
        'list': l['heads'] == ['Calendar test A', 'Calendar test B', 'Shared'] and [(r['name'], r['on']) for r in l['rows']] == [('Calendar', True), ('US Holidays', False), ('Calendar', True), ('Dana Whitfield', False)]
            and l['link'] and not l['shown'],
        'all_day_on_its_date': l['birthday'] == [l['today']],
        'discovery_requests': len(sent('<m:FindFolder Traversal="Deep">')) >= 1 and len(sent('<m:FindItem Traversal="Associated">')) >= 1
            and len(sent('<m:ResolveNames')) >= 2 and len(sent('Format="HexEntryId" Id="0A0B0C" Mailbox="dana@spark.test"')) >= 1,
        'dana_shown': d['row']['on'] and d['label'].startswith('Client pitch, Dana Whitfield,') and d['saved']['calendarShown'] == [dana_key]
            and len(sent('<m:ParentFolderIds><t:FolderId Id="DANA-CAL"/>')) >= 1,
        'dana_read_only': d['card']['title'] == 'Client pitch' and d['card']['cal'] == 'Dana Whitfield' and d['card']['note'] == "On Dana Whitfield's calendar. You can see it, not change it."
            and d['card']['buttons'] == [] and 'Sofia Reyes' in d['card']['people'] and d['card']['notes'] == 'Pitch deck v3',
        'no_overlap_with_shared': result['own']['title'] == 'Script review' and result['own']['warn'] == [] and result['own']['buttons'] == ['Edit', 'Delete'],
        'extra_calendar': result['holidays']['inAllDay'] and result['holidays']['card']['note'] == 'In your “US Holidays” calendar. Ember shows it but doesn\'t change it.' and result['holidays']['card']['buttons'] == [],
        'priya_busy_with_details': p['chips'] == ['Priya Nair'] and p['formClosed'] and p['row'] == {'name': 'Priya Nair', 'on': True, 'flag': 'busy only'} and p['dentist']
            and p['card']['title'] == 'Board prep' and p['card']['note'] == 'Priya Nair shares only the subject, place and time.' and p['card']['buttons'] == []
            and p['saved']['calendarPeople'] == [{'accountId': a_key, 'email': 'priya@spark.test', 'name': 'Priya Nair'}] and f'{a_key}|priya@spark.test' in p['saved']['calendarShown']
            and len(sent('<t:Mailbox><t:EmailAddress>priya@spark.test</t:EmailAddress>', 'calendar:Start')) >= 1 and len(sent('<t:Address>priya@spark.test</t:Address>', '<t:RequestedView>Detailed</t:RequestedView>')) >= 1,
        'oliver_busy_only': any(r['name'] == 'oliver@spark.test' and r['flag'] == 'busy only' for r in o['rows']) and o['card']['title'] == 'Busy' and not o['secret']
            and o['card']['note'] == "oliver@spark.test shares only when they're busy.",
        'agenda_untouched': result['agenda'] == ['Script review', 'Tessie birthday', 'Trailer review'],
        'hide_and_remove': h['hidden'] and h['priyaGone'] and h['eventsGone'] and dana_key not in h['saved']['calendarShown'] and h['saved']['calendarPeople'] == [{'accountId': a_key, 'email': 'oliver@spark.test', 'name': ''}],
        'no_trashed_or_unresolved': not any(r['name'] in ('Old calendar', 'Former colleague') for r in l['rows'] + o['rows']),
        'only_mock_requests': all(w in ('A', 'B') for w, _ in mock.requests),
    }
finally:
    try:
        before = result.get('before') or {}
        page("await messenger.storage.local.set(%s); %s return 1;" % (json.dumps(before), "".join(f"await messenger.storage.local.remove('{k}');" for k in SETTINGS if k not in before)))
        page("document.documentElement.dataset.theme = %s; return 1;" % json.dumps(result.get('theme') or ''))
    except Exception as error:
        print('restore failed', error)
    mock.remove_accounts(chrome, accounts)
    mock.stop()
    try:
        spark.run_in_app(m, "document.querySelector('.sidebar .item.parent[aria-label^=\"Inbox\"]')?.click(); await new Promise(r => setTimeout(r, 300)); location.reload(); return 1;")
    except Exception:
        pass

(args.output_dir / 'shared-calendars.json').write_text(json.dumps(result, indent=2, ensure_ascii=False, default=str))
print(json.dumps(result.get('checks'), indent=2))
raise SystemExit(0 if result.get('checks') and all(result['checks'].values()) else 1)
