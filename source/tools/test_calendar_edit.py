#!/usr/bin/env python3
"""Making and changing events (0.1.124), isolated fixture profile only (port 2831), against the local mock EWS
(tools/ews_mock.py) with two Exchange test accounts.

Checks: quick add in the editor (+ button) makes an event with no invitations; double-click a time, add an invitee
and a weekly repeat, Send invites (one CreateItem with attendees and the recurrence); a bad time is refused; Edit
changes only what changed (UpdateItem, nobody told); Delete; Cancel meeting with a note (CancelCalendarItem);
Delete all of a series (RecurringMasterItemId); Remove from calendar for a cancelled invitation; and Create event
from an email that mentions times (the strip, the editor's title, invitees and time, then Send). Screenshots of the
editor in light and dark. Everything goes to the mock: no real invitation is ever sent. Removes the test accounts,
the test email and the certificate override, and puts back the settings it changed.

  test_calendar_edit.py --output-dir DIR
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
local_iso = lambda h, m=0, day=0: at(h, m, day).strftime('%Y-%m-%dT%H:%M:%SZ')
OLIVER = ('Oliver Grant', 'oliver@spark.test')
ME = ('Merritt (EWS test)', 'merritt-a@ews.test')
EVENTS = {
    'A': {
        'MEET': dict(subject='Partner call', start=at(15), end=at(16), my='Organizer', organizer=ME, attendees=[(OLIVER, 'Accept')]),
        'STAND': dict(subject='Standup', start=at(8, 30), end=at(8, 45), my='Organizer', type='Occurrence', series='S1', organizer=ME),
        'STAND2': dict(subject='Standup', start=at(8, 30, 1), end=at(8, 45, 1), my='Organizer', type='Occurrence', series='S1', organizer=ME),
        'GONE': dict(subject='Canceled: Vendor demo', start=at(18), end=at(19), my='Accept', cancelled=True, organizer=OLIVER, attendees=[(ME, 'Unknown')]),
    },
    'B': {'TRAILER': dict(subject='Trailer review', start=at(11), end=at(12), my='Accept')},
}
run = str(int(time.time()))
SUBJECT = f'Venue contract for the spring retreat {run}'

work = Path(tempfile.mkdtemp(dir=args.output_dir))
mock = EwsMock(work, EVENTS)
m = spark.connect()
def chrome(script, values=()):
    reply = m._cmd("WebDriver:ExecuteScript", {"script": script, "args": list(values)})
    return reply.get("value") if isinstance(reply, dict) else reply
def page(body):
    out = spark.run_in_app(m, body)
    if isinstance(out, str) and out.startswith('ERROR'):
        raise RuntimeError(out)
    return out
def sent(kind):
    return [b for w, b in mock.requests if kind in b]

HELPERS = r'''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { const v = test(); if (v) return v; await sleep(100); } return test(); };
const evByTitle = (title) => [...document.querySelectorAll('.calendar [data-key]')].find((b) => (b.getAttribute('aria-label') || '').startsWith(title + ','));
const pop = () => document.querySelector('.calendar .popover');
const ed = () => document.querySelector('.sheet[role="dialog"]');
const button = (root, text) => [...(root?.querySelectorAll('button') || [])].find((b) => b.textContent.trim() === text);
const set = (el, value, event = 'input') => { el.value = value; el.dispatchEvent(new Event(event, { bubbles: true })); };
const field = (label) => ed()?.querySelector(`[aria-label="${label}"]`);
const editor = () => ed() && ({ title: field('Title')?.value, where: field('Location')?.value, startDate: field('Start date')?.value, startTime: field('Start time')?.value, endTime: field('End time')?.value,
  allDay: field('All day')?.checked, repeat: field('Repeat')?.value ?? null, alert: field('Alert')?.value, calendar: field('Calendar')?.selectedOptions?.[0]?.textContent.trim(),
  invitees: [...ed().querySelectorAll('.chip-name')].map((c) => c.textContent.trim()), action: [...ed().querySelectorAll('.foot .btn')].pop()?.textContent.trim(),
  hint: ed().querySelector('.hint')?.textContent.trim(), problem: ed().querySelector('.problem')?.textContent.trim() || null, from: ed().querySelector('.from')?.textContent.trim() || null });
const toasts = () => [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim());
const openEvent = async (title) => {
  let el = evByTitle(title);
  for (let i = 0; !el && i < 2; i++) { button(document.querySelector('.calendar .nav'), 'Today').click(); await sleep(300); if (i) { document.querySelector('.calendar .nav button[aria-label^="Next"]').click(); } await until(() => evByTitle(title), 3000); el = evByTitle(title); }
  el.click(); await until(() => pop()?.querySelector('.actions button:not([disabled])') || pop()?.querySelector('.answers'), 6000); await sleep(200); return el;
};
'''
result = {}
accounts = []
try:
    accounts = mock.add_accounts(chrome)
    result['before'] = page("return await messenger.storage.local.get(['calendarMode', 'calendarHidden']);")
    page("location.reload(); return 1;")
    time.sleep(4)
    result['theme'] = page("const t = document.documentElement.dataset.theme || ''; document.documentElement.dataset.theme = 'light'; return t;")
    page(HELPERS + r'''[...document.querySelectorAll('.sidebar .item')].find((b) => b.textContent.trim() === 'Calendar').click();
await until(() => document.querySelector('.calendar .modes'));
[...document.querySelectorAll('.calendar .modes button')].find((b) => b.textContent.trim() === 'Week').click();
await until(() => evByTitle('Partner call'), 12000); return 1;''')

    # 1. Quick add from the + button.
    result['quick'] = page(HELPERS + r'''document.querySelector('.calendar .add').click(); await until(() => ed());
const opened = editor();
const quick = field('Quick event'); set(quick, 'Venue walkthrough tomorrow 1pm at Lakeside Lodge');
quick.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await sleep(200);
const filled = editor();
button(ed(), 'Add').click();
await until(() => !ed() && evByTitle('Venue walkthrough'), 10000); await sleep(300);
return { opened, filled, closed: !ed(), shown: !!evByTitle('Venue walkthrough'), toasts: toasts() };''')
    # 2. Double-click today at 10 AM, an invitee and a weekly repeat: Send.
    result['invite'] = page(HELPERS + r'''button(document.querySelector('.calendar .nav'), 'Today').click(); await sleep(400);
const col = [...document.querySelectorAll('.calendar .day-col')][[...document.querySelectorAll('.calendar .col-head')].findIndex((h) => h.classList.contains('today'))];
const rect = col.getBoundingClientRect();
col.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: rect.left + 10, clientY: rect.top + 10 * 52 + 10 }));
await until(() => ed());
const opened = editor();
set(field('Title'), 'Planning');
const who = ed().querySelector('#event-invitees'); set(who, 'priya@spark.test'); who.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
await sleep(200);
set(field('Repeat'), 'weekly', 'change'); await sleep(200);
const ready = editor();
button(ed(), 'Send').click();
await until(() => !ed(), 10000); await until(() => evByTitle('Planning'), 8000);
return { opened, ready, shown: !!evByTitle('Planning'), toasts: toasts() };''')
    # 3. A bad time is refused; Escape closes without saving.
    creates_before = len(sent('<t:CalendarItem>'))
    result['refused'] = page(HELPERS + r'''document.querySelector('.calendar .add').click(); await until(() => ed());
set(field('Start time'), '14:00', 'change'); await sleep(100); set(field('End time'), '13:00'); await sleep(100);
button(ed(), 'Add').click(); await sleep(400);
const problem = editor().problem;
ed().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await sleep(200);
return { problem, closed: !ed() };''')
    result['refusedSentNothing'] = len(sent('<t:CalendarItem>')) == creates_before
    # 4. Edit the quick-added event: new title and time; Save sends only those, telling nobody.
    result['edit'] = page(HELPERS + r'''await openEvent('Venue walkthrough');
const actions = [...pop().querySelectorAll('.actions button')].map((b) => b.textContent.trim());
button(pop(), 'Edit').click(); await until(() => ed());
const opened = editor();
set(field('Title'), 'Venue walkthrough (moved)'); set(field('Start time'), '15:00', 'change'); await sleep(200);
const ready = editor();
button(ed(), 'Save').click();
await until(() => !ed() && evByTitle('Venue walkthrough (moved)'), 10000);
return { actions, opened, ready, shown: !!evByTitle('Venue walkthrough (moved)'), toasts: toasts() };''')
    # 5. Delete it.
    result['delete'] = page(HELPERS + r'''await openEvent('Venue walkthrough (moved)');
button(pop(), 'Delete').click(); await sleep(200);
const ask = pop().querySelector('.confirm p')?.textContent.trim();
button(pop().querySelector('.confirm'), 'Delete').click();
await until(() => !evByTitle('Venue walkthrough (moved)'), 8000);
return { ask, gone: !evByTitle('Venue walkthrough (moved)'), toasts: toasts() };''')
    # 6. Cancel a meeting with a note.
    result['cancel'] = page(HELPERS + r'''await openEvent('Partner call');
button(pop(), 'Cancel meeting').click(); await sleep(200);
const ask = pop().querySelector('.confirm p')?.textContent.trim();
set(pop().querySelector('.confirm textarea'), 'Sorry, moving this to next week');
button(pop().querySelector('.confirm'), 'Cancel meeting').click();
await until(() => !evByTitle('Partner call'), 8000);
return { ask, gone: !evByTitle('Partner call'), toasts: toasts() };''')
    # 7. Delete all of a series.
    result['series'] = page(HELPERS + r'''await openEvent('Standup');
button(pop(), 'Delete').click(); await sleep(200);
const choices = [...pop().querySelectorAll('.confirm button')].map((b) => b.textContent.trim());
button(pop().querySelector('.confirm'), 'Delete all').click();
await until(() => !evByTitle('Standup'), 8000);
return { choices, gone: !evByTitle('Standup'), toasts: toasts() };''')
    # 8. A cancelled invitation: Remove from calendar.
    result['removeCancelled'] = page(HELPERS + r'''await openEvent('Canceled: Vendor demo');
const actions = [...pop().querySelectorAll('.actions button')].map((b) => b.textContent.trim());
button(pop(), 'Remove from calendar').click();
await until(() => !evByTitle('Canceled: Vendor demo'), 8000);
return { actions, gone: !evByTitle('Canceled: Vendor demo'), toasts: toasts() };''')

    # 9. From an email that mentions times.
    date = datetime.now(timezone.utc).strftime('%a, %d %b %Y %H:%M:%S +0000')
    lines = ['From: Priya Nair <priya@spark.test>', 'To: Merritt Franzmann <merritt@spark.test>', 'Cc: Dana Whitfield <dana@spark.test>', f'Subject: RE: {SUBJECT}', 'Date: ' + date,
             f'Message-ID: <venue-{run}@calendar-edit.test>', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', 'X-Mozilla-Status: 0000', '',
             'Hi,', '', "The contract looks good. Could we walk the venue together? I'm free tomorrow from 1 to 3, or Friday morning works too.", '', 'Thanks,', 'Priya', '']
    m.execute("""const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const f=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder);
f.addMessage(%s.join('\\r\\n')); return 1;""" % json.dumps(lines))
    result['email'] = page(HELPERS + r'''const subject = %s;
document.querySelector('.sidebar .item.parent[aria-label^="Inbox"]').click();
const row = await until(() => [...document.querySelectorAll('.col-list .subject')].find((s) => s.textContent.includes(subject)), 20000);
if (!row) return { row: false };
row.click();
await until(() => document.querySelector('.email-event .create'), 10000); await sleep(300);
const strip = [...document.querySelectorAll('.email-event .time')].map((b) => b.textContent.trim());
const header = !!document.querySelector('.col-reader button[aria-label="Create event"]');
document.querySelector('.email-event .create').click();
await until(() => ed()); await sleep(300);
return { row: true, strip, header, editor: editor() };''' % json.dumps(SUBJECT))
    spark.app_shot(m, str(args.output_dir / 'editor-from-email-light.png'))
    page("document.documentElement.dataset.theme = 'dark'; return 1;")
    time.sleep(0.5)
    spark.app_shot(m, str(args.output_dir / 'editor-from-email-dark.png'))
    page("document.documentElement.dataset.theme = 'light'; return 1;")
    result['emailSend'] = page(HELPERS + r'''button(ed(), 'Send').click(); await until(() => !ed(), 10000); await sleep(300); return { closed: !ed(), toasts: toasts() };''')

    tomorrow = (midnight + timedelta(days=1))
    creates = sent('<t:CalendarItem>')
    updates = sent('<m:UpdateItem')
    deletes = sent('<m:DeleteItem')
    cancels = sent('<t:CancelCalendarItem>')
    q, inv, ed_ = result['quick'], result['invite'], result['edit']
    em = result.get('email', {})
    from_email = [c for c in creates if 'From the email' in c]
    result['requests'] = [(w, re.sub(r'<\?xml.*?<soap:Body>', '', b)[:600]) for w, b in mock.requests if 'FindItem' not in b and 'GetItem' not in b]
    result['checks'] = {
        'quick_add_fills_editor': q['opened']['title'] == '' and q['filled']['title'] == 'Venue walkthrough' and q['filled']['where'] == 'Lakeside Lodge' and q['filled']['startDate'] == tomorrow.strftime('%Y-%m-%d') and q['filled']['startTime'] == '13:00' and q['filled']['endTime'] == '14:00' and q['filled']['action'] == 'Add' and q['filled']['hint'] == 'Nobody is invited.',
        'quick_add_creates_quietly': len(creates) >= 1 and 'SendMeetingInvitations="SendToNone"' in creates[0] and '<t:Subject>Venue walkthrough</t:Subject>' in creates[0] and '<t:Location>Lakeside Lodge</t:Location>' in creates[0]
            and f'<t:Start>{(tomorrow + timedelta(hours=13)).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}</t:Start>' in creates[0] and 'StartTimeZone Id=' in creates[0] and q['shown'] and any('Added “Venue walkthrough”' in t for t in q['toasts']),
        'double_click_time': inv['opened']['startTime'] == '10:00' and inv['opened']['endTime'] == '11:00' and inv['opened']['startDate'] == midnight.strftime('%Y-%m-%d'),
        'invite_with_repeat': inv['ready']['invitees'] == ['priya@spark.test'] and inv['ready']['action'] == 'Send' and len(creates) >= 2 and 'SendMeetingInvitations="SendToAllAndSaveCopy"' in creates[1]
            and '<t:EmailAddress>priya@spark.test</t:EmailAddress>' in creates[1] and '<t:WeeklyRecurrence>' in creates[1] and inv['shown'] and any('Invitation sent for “Planning”' in t for t in inv['toasts']),
        'bad_time_refused': result['refused']['problem'] == 'The event ends before it starts.' and result['refused']['closed'] and result['refusedSentNothing'],
        'edit_only_changes': ed_['actions'] == ['Edit', 'Delete'] and ed_['opened']['title'] == 'Venue walkthrough' and ed_['opened']['repeat'] == 'none' and ed_['ready']['action'] == 'Save' and ed_['ready']['endTime'] == '16:00'
            and len(updates) == 1 and 'SendMeetingInvitationsOrCancellations="SendToNone"' in updates[0] and 'item:Subject' in updates[0] and 'calendar:Start' in updates[0] and 'calendar:Location' not in updates[0] and 'item:Body' not in updates[0]
            and ed_['shown'] and any('Saved “Venue walkthrough (moved)”' in t for t in ed_['toasts']),
        'delete': result['delete']['ask'] == 'Delete “Venue walkthrough (moved)”?' and result['delete']['gone'] and any('Deleted “Venue walkthrough (moved)”' in t for t in result['delete']['toasts']) and any('<t:ItemId Id="NEW1"/>' in d and 'SendMeetingCancellations="SendToNone"' in d for d in deletes),
        'cancel_meeting_with_note': result['cancel']['gone'] and len(cancels) == 1 and '<t:ReferenceItemId Id="MEET" ChangeKey="ck-MEET"/>' in cancels[0] and 'Sorry, moving this to next week' in cancels[0]
            and any('Cancelled “Partner call”' in t for t in result['cancel']['toasts']),
        'delete_series': result['series']['choices'] == ['Delete this one', 'Delete all', 'Keep'] and result['series']['gone'] and any('Deleted “Standup” and the rest of the series' in t for t in result['series']['toasts']) and any('<t:RecurringMasterItemId OccurrenceId="STAND"/>' in d for d in deletes) and 'STAND2' not in EVENTS['A'],
        'remove_cancelled': result['removeCancelled']['actions'] == ['Remove from calendar'] and result['removeCancelled']['gone'] and any('<t:ItemId Id="GONE"/>' in d and 'SendToNone' in d for d in deletes),
        'email_strip': em.get('row') and em.get('header') and len(em.get('strip', [])) == 2 and em['strip'][0].endswith('1 PM – 3 PM') and em['strip'][1].endswith('9 AM – 12 PM'),
        'email_editor': em.get('row') and em['editor']['title'] == SUBJECT and set(em['editor']['invitees']) == {'Priya Nair', 'Dana Whitfield'} and em['editor']['startTime'] == '13:00' and em['editor']['endTime'] == '15:00'
            and em['editor']['startDate'] == tomorrow.strftime('%Y-%m-%d') and em['editor']['action'] == 'Send' and SUBJECT in (em['editor']['from'] or ''),
        'email_send': result['emailSend']['closed'] and len(from_email) == 1 and '<t:EmailAddress>priya@spark.test</t:EmailAddress>' in from_email[0] and '<t:EmailAddress>dana@spark.test</t:EmailAddress>' in from_email[0] and 'merritt@spark.test' not in from_email[0],
        'only_mock_requests': all(w in ('A', 'B') for w, _ in mock.requests),
    }
finally:
    try:
        before = result.get('before') or {}
        page("await messenger.storage.local.set(%s); %s return 1;" % (json.dumps(before), "".join(f"await messenger.storage.local.remove('{k}');" for k in ('calendarMode', 'calendarHidden') if k not in before)))
        page("document.querySelector('.sheet .foot .btn')?.click(); document.documentElement.dataset.theme = %s; return 1;" % json.dumps(result.get('theme') or ''))
    except Exception as error:
        print('restore failed', error)
    m.execute("""const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const f=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox');
const old=[...f.messages].filter((h)=>h.messageId.endsWith('@calendar-edit.test')); if (old.length) f.deleteMessages(old, null, true, false, null, false); return old.length;""")
    mock.remove_accounts(chrome, accounts)
    mock.stop()
    try:
        spark.run_in_app(m, "document.querySelector('.sidebar .item.parent[aria-label^=\"Inbox\"]')?.click(); await new Promise(r => setTimeout(r, 300)); location.reload(); return 1;")
    except Exception:
        pass

(args.output_dir / 'calendar-edit.json').write_text(json.dumps(result, indent=2, ensure_ascii=False, default=str))
print(json.dumps(result.get('checks'), indent=2))
raise SystemExit(0 if result.get('checks') and all(result['checks'].values()) else 1)
