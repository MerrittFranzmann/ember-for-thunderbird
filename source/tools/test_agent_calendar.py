#!/usr/bin/env python3
"""Scheduling (0.1.125), isolated fixture profile only (port 2831), against the local mock EWS (tools/ews_mock.py)
and the real mcp/spark-mcp.mjs over stdio (a temporary agent socket).

As Claude Code: calendar_events, find_free_times (the user's and Priya's busy times, an outside address Exchange
can't see), hold_time with Priya to invite (a CreateItem inviting nobody). Then in Ember: Agent Activity's rows and
To review, Invite Priya (an UpdateItem adding her, sent), a second hold removed (DeleteItem), a third kept (no
request). The editor's Availability (rows, busy blocks, a free time picked), and "Share my availability" from an
email (a reply with the free times, discarded unsent). Everything goes to the mock; nothing is sent. Restores the
agent setting, socket pref, activity, test accounts, the test email and the certificate override.

  test_agent_calendar.py --output-dir DIR
"""
import argparse, json, os, re, subprocess, tempfile, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
import spark
from ews_mock import EwsMock

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
SOCKET = '/private/tmp/claude-503/spark-agent-calendar.sock'
SERVER = Path(__file__).resolve().parent.parent / 'mcp' / 'spark-mcp.mjs'

# A weekday at least a day ahead, so the free times are in working hours whatever the test runs.
midnight = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
day = midnight + timedelta(days=1)
while day.weekday() >= 5: day += timedelta(days=1)
at = lambda h, m=0: (day + timedelta(hours=h, minutes=m)).astimezone(timezone.utc)
DAY = day.strftime('%Y-%m-%d')
EVENTS = {'A': {
    'BOARD': dict(subject='Board prep', start=at(11), end=at(12), my='Organizer'),
    'LUNCH': dict(subject='Lunch', start=at(12), end=at(13), my='Organizer', busy='Free'),
}}
BUSY = {'priya@spark.test': [(at(9), at(11)), (at(13), at(14))]}
run = str(int(time.time()))

work = Path(tempfile.mkdtemp(dir=args.output_dir))
mock = EwsMock(work, EVENTS, BUSY)
m = spark.connect()
def chrome(script, values=()):
    reply = m._cmd("WebDriver:ExecuteScript", {"script": script, "args": list(values)})
    return reply.get("value") if isinstance(reply, dict) else reply
def page(body):
    out = spark.run_in_app(m, body)
    if isinstance(out, str) and out.startswith('ERROR'):
        raise RuntimeError(out)
    return out
PROFILE_SOCKET = m.execute("return Services.prefs.getStringPref('extensions.spark.agentSocket', '');")

class Agent:
    def __init__(self):
        self.p = subprocess.Popen(['node', str(SERVER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env={**os.environ, 'SPARK_AGENT_SOCKET': SOCKET})
        self.n = 0
        self.rpc('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'claude-code', 'version': '1'}})
    def rpc(self, method, params=None):
        self.n += 1
        self.p.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': self.n, 'method': method, 'params': params or {}}) + '\n'); self.p.stdin.flush()
        while True:
            message = json.loads(self.p.stdout.readline())
            if message.get('id') == self.n: return message
    def tool(self, name, arguments=None):
        result = self.rpc('tools/call', {'name': name, 'arguments': arguments or {}})['result']
        return {'error': result['content'][0]['text']} if result.get('isError') else result['structuredContent']
    def close(self):
        self.p.stdin.close(); self.p.wait(timeout=5)

HELPERS = r'''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms = 8000) => { for (let i = 0; i < ms / 100; i++) { const v = test(); if (v) return v; await sleep(100); } return test(); };
const button = (root, text) => [...(root?.querySelectorAll('button') || [])].find((b) => b.textContent.trim() === text || b.textContent.trim().startsWith(text));
const set = (el, value, event = 'input') => { el.value = value; el.dispatchEvent(new Event(event, { bubbles: true })); };
const ed = () => document.querySelector('.sheet[role="dialog"]');
const field = (label) => ed()?.querySelector(`[aria-label="${label}"]`);
const reviewRows = () => [...document.querySelectorAll('.activity .review-row')].map((r) => ({ text: r.querySelector('.what')?.textContent.replace(/\s+/g, ' ').trim(), buttons: [...r.querySelectorAll('button')].map((b) => b.textContent.trim()) }));
const rows = () => [...document.querySelectorAll('.activity .row')].map((r) => ({ text: r.querySelector('.sentence')?.textContent.replace(/\s+/g, ' ').trim() }));
const toasts = () => [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim());
'''
RESET = "await messenger.storage.local.remove(['agentActivity', 'agentRegistry', 'agentReviewDismissed', 'agentMarks', 'agentHoldStates']); return 1;"
result = {}
accounts = []
agent = None
try:
    accounts = mock.add_accounts(chrome)
    result['before'] = page("return await messenger.storage.local.get(['calendarMode', 'calendarHidden', 'agentAccess']);")
    m.execute("Services.prefs.setStringPref('extensions.spark.agentSocket', %s); return 1;" % json.dumps(SOCKET))
    page(RESET.replace('return 1;', '') + "await messenger.storage.local.set({ agentAccess: true, agentRegistry: { since: Date.now() - 2 * 86400000, agents: { 'claude-code': { first: Date.now() - 86400000, last: Date.now() - 86400000, count: 1 } } } }); return 1;")
    page("setTimeout(() => location.reload(), 50); return 1;")
    time.sleep(4)
    result['theme'] = page("const t = document.documentElement.dataset.theme || ''; document.documentElement.dataset.theme = 'light'; return t;")
    for _ in range(40):
        if os.path.exists(SOCKET): break
        time.sleep(0.25)

    # Priya's email (her name for the hold; later: Share my availability).
    date = datetime.now(timezone.utc).strftime('%a, %d %b %Y %H:%M:%S +0000')
    lines = ['From: Priya Nair <priya@spark.test>', 'To: Merritt Franzmann <merritt@spark.test>', f'Subject: Walkthrough? {run}', 'Date: ' + date, f'Message-ID: <share-{run}@agent-calendar.test>',
             'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', 'X-Mozilla-Status: 0000', '', 'Could we meet tomorrow at 2pm?', '']
    m.execute("""const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const f=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder);
f.addMessage(%s.join('\\r\\n')); return 1;""" % json.dumps(lines))
    page(HELPERS + r'''document.querySelector('.sidebar .item.parent[aria-label^="Inbox"]').click();
await until(() => [...document.querySelectorAll('.col-list .subject')].some((s) => s.textContent.includes(%s)), 20000); await sleep(1500); return 1;''' % json.dumps(f'Walkthrough? {run}'))
    agent = Agent()
    result['tools'] = [t['name'] for t in agent.rpc('tools/list')['result']['tools']]
    result['events'] = agent.tool('calendar_events', {'start': DAY, 'days': 1, 'reason': 'Plan the venue walkthrough'})
    result['free'] = agent.tool('find_free_times', {'attendees': ['priya@spark.test', 'pal@outside.test'], 'duration_minutes': 60, 'start': DAY, 'days': 1, 'limit': 3})
    first = (result['free'].get('free') or [{}])[0]
    result['hold'] = agent.tool('hold_time', {'title': 'Venue walkthrough', 'start': first.get('start', at(14).isoformat()), 'end': (datetime.fromisoformat(first.get('start', at(14).isoformat()).replace('Z', '+00:00')) + timedelta(minutes=90)).isoformat(),
                                              'invite': ['priya@spark.test'], 'location': 'Lakeside Lodge', 'reason': 'Set up the venue walkthrough Priya asked for'})
    result['hold2'] = agent.tool('hold_time', {'title': 'Focus time', 'start': at(15).isoformat(), 'end': at(16).isoformat()})
    result['hold3'] = agent.tool('hold_time', {'title': 'Prep notes', 'start': at(16).isoformat(), 'end': at(16, 30).isoformat(), 'invite': ['dana@spark.test']})
    result['badHold'] = agent.tool('hold_time', {'title': 'Backwards', 'start': at(15).isoformat(), 'end': at(14).isoformat()})
    holds_created = [b for w, b in mock.requests if '<t:CalendarItem>' in b and '<m:CreateItem' in b]

    # Agent Activity: rows, To review and the decisions.
    result['activity'] = page(HELPERS + r'''document.querySelector('.sidebar .agent-btn').click();
await until(() => document.querySelectorAll('.activity .review-row').length >= 2, 10000); await sleep(400);
const count = document.querySelector('.sidebar .agent-btn .agent-badge')?.textContent.trim();
return { review: reviewRows(), rows: rows(), count, summary: document.querySelector('.activity .summary')?.textContent.trim() };''')
    spark.app_shot(m, str(args.output_dir / 'agent-holds-light.png'))
    result['invite'] = page(HELPERS + r'''const row = [...document.querySelectorAll('.activity .review-row')].find((r) => r.textContent.includes('Venue walkthrough'));
button(row, 'Invite Priya').click();
await until(() => toasts().some((t) => t.includes('Invited')), 8000); await sleep(300);
return { review: reviewRows(), rows: rows(), toasts: toasts() };''')
    result['remove'] = page(HELPERS + r'''const row = [...document.querySelectorAll('.activity .review-row')].find((r) => r.textContent.includes('Focus time'));
button(row, 'Remove').click(); await until(() => toasts().some((t) => t.includes('Removed the hold')), 8000); await sleep(300);
return { review: reviewRows(), toasts: toasts() };''')
    before_keep = len(mock.requests)
    result['keep'] = page(HELPERS + r'''const row = [...document.querySelectorAll('.activity .review-row')].find((r) => r.textContent.includes('Prep notes'));
button(row, 'Keep as a hold').click(); await until(() => toasts().some((t) => t.includes('Kept')), 8000); await sleep(300);
return { review: reviewRows(), rows: rows(), toasts: toasts() };''')
    keep_requests = [b for w, b in mock.requests[before_keep:] if 'FindItem' not in b and 'GetItem' not in b and 'GetUserAvailability' not in b]

    # The editor's Availability.
    result['availability'] = page(HELPERS + r'''const day = %s;
[...document.querySelectorAll('.sidebar .item')].find((b) => b.textContent.trim() === 'Calendar').click();
await until(() => document.querySelector('.calendar .add')); document.querySelector('.calendar .add').click(); await until(() => ed());
set(field('Start date'), day, 'change'); await sleep(100); set(field('Start time'), '09:00', 'change'); await sleep(100);
const who = ed().querySelector('#event-invitees'); set(who, 'priya@spark.test'); who.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
await until(() => ed().querySelector('.avail .slot'), 10000); await sleep(300);
const section = ed().querySelector('.avail');
const out = { rows: [...section.querySelectorAll('.who')].map((w) => w.textContent.trim()), busy: section.querySelectorAll('.busy').length, chosen: !!section.querySelector('.chosen'),
  slots: [...section.querySelectorAll('.slot')].map((s) => s.textContent.trim()), head: section.querySelector('.avail-head')?.textContent.replace(/\s+/g, ' ').trim() };
section.querySelector('.slot').click(); await sleep(200);
out.picked = { startTime: field('Start time').value, endTime: field('End time').value, pressed: [...section.querySelectorAll('.slot[aria-pressed="true"]')].map((s) => s.textContent.trim()) };
return out;''' % json.dumps(DAY))
    spark.app_shot(m, str(args.output_dir / 'editor-availability-light.png'))
    page(HELPERS + "button(ed().querySelector('.foot'), 'Cancel').click(); await sleep(200); return 1;")

    result['share'] = page(HELPERS + r'''const subject = %s;
document.querySelector('.sidebar .item.parent[aria-label^="Inbox"]').click();
const row = await until(() => [...document.querySelectorAll('.col-list .subject')].find((s) => s.textContent.includes(subject)), 20000);
if (!row) return { row: false };
row.click(); await until(() => document.querySelector('.email-event .share'), 10000);
document.querySelector('.email-event .share').click();
const body = await until(() => { const e = document.querySelector('.sheet[aria-labelledby="compose-title"] [contenteditable="true"]'); return e && e.textContent.includes("free at these times") ? e : null; }, 12000);
const text = body?.innerText || '';
const to = [...document.querySelectorAll('.sheet[aria-labelledby="compose-title"] .chip-name')].map((c) => c.textContent.trim());
document.querySelector('.sheet[aria-labelledby="compose-title"] button[aria-label="Discard"]')?.click(); await sleep(200);
button(document.querySelector('.sheet[aria-labelledby="compose-title"] .confirm'), 'Discard')?.click(); await sleep(400);
return { row: true, text: text.slice(0, 400), to, closed: !document.querySelector('.sheet[aria-labelledby="compose-title"] [contenteditable="true"]') };''' % json.dumps(f'Walkthrough? {run}'))

    free, events, hold = result['free'], result['events'], result['hold']
    updates = [b for w, b in mock.requests if '<m:UpdateItem' in b]
    deletes = [b for w, b in mock.requests if '<m:DeleteItem' in b]
    act = result['activity']
    noon = at(12).strftime('%Y-%m-%dT%H:%M:%S')
    result['writes'] = [re.sub(r'^.*?<soap:Body>', '', b, flags=re.S)[:2000] for w, b in mock.requests if any(k in b for k in ('<m:UpdateItem', '<m:DeleteItem', '<m:CreateItem'))]
    result['checks'] = {
        'tools_listed': {'calendar_events', 'find_free_times', 'hold_time'} <= set(result['tools']),
        'calendar_events': [e['title'] for e in events.get('events', [])] == ['Board prep', 'Lunch'] and events['events'][0]['my_response'] == 'organizer' and events['events'][1]['show_as'] == 'Free' and bool(events.get('range')),
        # Me busy 11–12, Priya 9–11 and 13–14; Lunch is Free: the first hour everyone's free starts at 12:00, then 2:00 PM.
        'free_times': [datetime.fromisoformat(f['start'].replace('Z', '+00:00')).astimezone().strftime('%H:%M') for f in free.get('free', [])][:2] == ['12:00', '14:00']
            and any(p.get('calendar_visible') is False and p['email'] == 'pal@outside.test' for p in free.get('people', [])) and any(p.get('you') for p in free.get('people', [])) and 'note' in free,
        'hold_invites_nobody': hold.get('to_invite') == [{'name': 'Priya Nair', 'email': 'priya@spark.test'}] and len(holds_created) == 3 and all('SendMeetingInvitations="SendToNone"' in b and 'RequiredAttendees' not in b for b in holds_created)
            and '<t:Subject>Venue walkthrough</t:Subject>' in holds_created[0] and 'Nobody has been invited' in holds_created[0] and 'nobody was invited' in hold.get('note', ''),
        'bad_hold_refused': 'error' in result['badHold'],
        'activity_rows': any(r['text'].startswith('Looked at your calendar') for r in act['rows']) and any(r['text'].startswith('Found free times with priya@spark.test, pal@outside.test') for r in act['rows'])
            and any(r['text'].startswith('Held ') and 'Venue walkthrough' in r['text'] and 'to invite Priya Nair' in r['text'] for r in act['rows']),
        'to_review': len([r for r in act['review'] if r['text'].startswith('Hold on your calendar')]) == 3 and act['count'] == '3'
            and any('Venue walkthrough' in r['text'] and r['buttons'] == ['Invite Priya', 'Keep as a hold', 'Remove'] for r in act['review'])
            and any('Focus time' in r['text'] and r['buttons'] == ['Keep as a hold', 'Remove'] for r in act['review']) and 'checked your calendar' in (act['summary'] or '').lower(),
        'invite_sends_update': len(updates) == 1 and 'SendMeetingInvitationsOrCancellations="SendToAllAndSaveCopy"' in updates[0] and '<t:EmailAddress>priya@spark.test</t:EmailAddress>' in updates[0]
            and f'<t:ItemId Id="{hold.get("item_id")}"/>' in updates[0] and not any('Venue walkthrough' in r['text'] for r in result['invite']['review']) and any('Invited' in r['text'] and 'Venue walkthrough' in r['text'] for r in result['invite']['rows']),
        'remove_deletes': len(deletes) == 1 and f'<t:ItemId Id="{result["hold2"].get("item_id")}"/>' in deletes[0] and 'SendToNone' in deletes[0] and not any('Focus time' in r['text'] for r in result['remove']['review']),
        'keep_sends_nothing': keep_requests == [] and result['keep']['review'] == [] and any('Kept “Prep notes” as a hold' in t for t in result['keep']['toasts']),
        'editor_availability': result['availability']['rows'][:2] == ['You', 'priya@spark.test'] and result['availability']['busy'] >= 3 and result['availability']['chosen']
            and len(result['availability']['slots']) >= 1 and result['availability']['picked']['pressed'] == result['availability']['slots'][:1],
        'share_availability': result['share'].get('row') and "I'm free at these times" in result['share']['text'] and result['share']['closed'],
        'only_mock_requests': all(w == 'A' for w, _ in mock.requests),
    }
finally:
    if agent:
        try: agent.close()
        except Exception: pass
    try:
        before = result.get('before') or {}
        page(RESET.replace('return 1;', '') + "await messenger.storage.local.set(%s); %s return 1;" % (json.dumps(before), "".join(f"await messenger.storage.local.remove('{k}');" for k in ('calendarMode', 'calendarHidden', 'agentAccess') if k not in before)))
        page("document.documentElement.dataset.theme = %s; return 1;" % json.dumps(result.get('theme') or ''))
    except Exception as error:
        print('restore failed', error)
    m.execute("Services.prefs.setStringPref('extensions.spark.agentSocket', %s); return 1;" % json.dumps(PROFILE_SOCKET))
    m.execute("""const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const f=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox');
const old=[...f.messages].filter((h)=>h.messageId.endsWith('@agent-calendar.test')); if (old.length) f.deleteMessages(old, null, true, false, null, false); return old.length;""")
    mock.remove_accounts(chrome, accounts)
    mock.stop()
    try: spark.run_in_app(m, "document.querySelector('.sidebar .item.parent[aria-label^=\"Inbox\"]')?.click(); await new Promise(r => setTimeout(r, 300)); location.reload(); return 1;")
    except Exception: pass

(args.output_dir / 'agent-calendar.json').write_text(json.dumps(result, indent=2, ensure_ascii=False, default=str))
print(json.dumps(result.get('checks'), indent=2))
raise SystemExit(0 if result.get('checks') and all(result['checks'].values()) else 1)
