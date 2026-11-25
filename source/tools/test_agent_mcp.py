#!/usr/bin/env python3
"""Ember's MCP server end to end, isolated fixture profile only (port 2831): the real mcp/spark-mcp.mjs over
stdio → Ember's agent socket (a temporary path via the test-only pref extensions.spark.agentSocket) → the Ember
page. Turns Settings → Let AI agents use Ember on like a user, then as an agent: ember_status, find_emails,
read_email (each email with its link to open it in Ember), open_email (Ember shows it), mark_emails (top + needs reply + note) and checks the Top group and badge in the inbox, list_marked,
takes it off the top again, and checks a friendly error once access is off. Cleans up marks, setting and pref.

  test_agent_mcp.py --output-dir DIR
"""
import argparse, json, os, subprocess, time
from pathlib import Path
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
SOCKET = '/private/tmp/claude-503/spark-agent-test.sock'
SERVER = Path(__file__).resolve().parent.parent / 'mcp' / 'spark-mcp.mjs'
SUBJECT = 'Reading pane layout review'

m = spark.connect()
PROFILE_SOCKET = m.execute("return Services.prefs.getStringPref('extensions.spark.agentSocket', '');")  # the test profile's own (never the real Ember's)
m.execute("Services.prefs.setStringPref('extensions.spark.agentSocket', %s); return 1;" % json.dumps(SOCKET))

def reload_page():
    spark.run_in_app(m, "setTimeout(() => location.reload(), 50); return 1;")
    time.sleep(3)
    for _ in range(120):
        try:
            if spark.run_in_app(m, "return !!document.querySelector('.sidebar .item') && !document.querySelector('.mini-spin');"): return
        except Exception: pass
        time.sleep(0.5)

def settings_toggle():
    spark.open_settings(m, 'ai', 'Let AI agents use Ember')
    try: return spark.in_settings(m, spark.SETTING_ITEM + r'''
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const agents = () => item('Let AI agents use Ember');
const toggle = agents().querySelector('input.switch'); toggle.click();
const status = () => agents().querySelector('small.status')?.textContent || null;
for (let i = 0; i < 50; i++) { await pause(100); if (!toggle.checked || (status() && status() !== "Starts when Ember's window is open.")) break; }
const out = { on: toggle.checked, status: status(), command: agents().querySelector('code.command')?.textContent || null };
return out;''')
    finally: spark.close_settings(m)

class Agent:
    def __init__(self):
        self.p = subprocess.Popen(['node', str(SERVER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env={**os.environ, 'SPARK_AGENT_SOCKET': SOCKET})
        self.n = 0
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

TOP = r'''
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
document.querySelector('.sidebar .item.parent[aria-label^="Inbox"]')?.click(); await pause(1200);
const head = [...document.querySelectorAll('.viewport .sec')].find((s) => s.textContent.trim().startsWith('Top'));
const rows = [...document.querySelectorAll('.viewport .row')].slice(0, 3).map((r) => ({ subject: r.querySelector('.subject')?.textContent.trim(), reply: !!r.querySelector('.sig.reply') }));
return { top: !!head, first: rows[0] || null };'''

ELSEWHERE = r'''
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
document.querySelector('.sidebar .item.parent[aria-label^="Inbox"]')?.click(); await pause(1200);
[...document.querySelectorAll('.viewport .row')].find((r) => !r.querySelector('.subject')?.textContent.includes(%s))?.click(); await pause(800);
return document.querySelector('.reader h1.subject')?.textContent.trim() || null;''' % json.dumps(SUBJECT)

SENT_COUNT = "const f = (await messenger.folders.query({ specialUse: ['sent'] }))[0]; return (await messenger.folders.getFolderInfo(f.id)).totalMessageCount;"
DRAFT_CHECK = r'''
const [draftId, originalId] = [%s, %s];
const q = await messenger.messages.query({ headerMessageId: draftId });
const d = q.messages[0]; if (!d) return null;
const full = await messenger.messages.getFull(d.id);
const h = (k) => (full.headers[k] || []).join(' ');
const text = JSON.stringify(full).replace(/\\[nr]/g, ' ');
return { folder: d.folder?.name, subject: d.subject, to: d.recipients, inReplyTo: h('in-reply-to'), threaded: h('in-reply-to').includes(originalId), hasText: text.includes('updated budget slide'), quotes: /wrote:/.test(text) };'''
USER_SAVED = r'''
const [subject, originalId] = [%s, %s];
const q = await messenger.messages.query({ subject });
const drafts = q.messages.filter((x) => x.folder?.specialUse?.includes('drafts'));
const out = [];
for (const d of drafts) { const full = await messenger.messages.getFull(d.id); out.push({ id: d.headerMessageId, subject: (full.headers.subject || [])[0], threaded: (full.headers['in-reply-to'] || []).join(' ').includes(originalId) }); }
return out;'''
DRAFTS_FOR = "const q = await messenger.messages.query({ subject: %s }); return q.messages.filter((x) => x.folder?.specialUse?.includes('drafts')).map((x) => x.headerMessageId);"
OPEN_BADGE = r'''
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
document.querySelector('.sidebar .item.parent[aria-label^="Inbox"]')?.click(); await pause(1200);
const row = [...document.querySelectorAll('.viewport .row')][0];
const badge = row?.querySelector('.sig.draft');
if (!badge) return { badge: false, subject: row?.querySelector('.subject')?.textContent };
badge.click();
for (let i = 0; i < 50 && !document.querySelector('.sheet [contenteditable=true]'); i++) await pause(100);
await pause(400);
const sheet = document.querySelector('.sheet');
const out = { badge: true, opened: !!sheet, title: sheet?.querySelector('h2')?.textContent, subject: sheet?.querySelector('#c-subj')?.value, text: sheet?.querySelector('[contenteditable=true]')?.textContent.slice(0, 80) };
// Save it again from Ember (as a user would after editing).
[...document.querySelectorAll('.sheet .foot button')].find((b) => b.textContent.trim() === 'Save draft')?.click();
for (let i = 0; i < 100 && document.querySelector('.sheet'); i++) await pause(100);
out.saved = !document.querySelector('.sheet');
return out;'''

result = {}
agent = None
try:
    spark.run_in_app(m, "await messenger.storage.local.set({ agentAccess: false }); await messenger.storage.local.remove('agentMarks'); return 1;")
    reload_page()
    result['enable'] = settings_toggle()
    agent = Agent()
    result['init'] = agent.rpc('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'spark-test', 'version': '1'}})['result']['serverInfo']
    agent.p.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}) + '\n'); agent.p.stdin.flush()
    result['tools'] = [t['name'] for t in agent.rpc('tools/list')['result']['tools']]
    # A script error in Ember's window is kept in its error log, which ember_status reports.
    failure = f'spark-test: logged failure {int(time.time())}'
    spark.run_in_app(m, "window.dispatchEvent(new ErrorEvent('error', { message: %s })); return 1;" % json.dumps(failure))
    result['status'] = agent.tool('ember_status')
    result['logged'] = next((e for e in result['status'].get('errors', []) if e.get('text') == failure), None)
    found = agent.tool('find_emails', {'query': SUBJECT, 'days': 90})
    result['found'] = {'total': found.get('total'), 'first': (found.get('emails') or [{}])[0]}
    email = next((e for e in found.get('emails', []) if e.get('subject') == SUBJECT and 'Ada' in e.get('from', '')), None) or {}
    result['filtered'] = agent.tool('find_emails', {'section': 'newsletters', 'days': 30, 'limit': 5})
    big = agent.tool('find_emails', {'days': 90, 'limit': 100})
    result['large'] = {'error': big.get('error'), 'emails': len(big.get('emails', []))}
    result['bad'] = agent.tool('find_emails', {'section': 'spam'})
    read = agent.tool('read_email', {'id': email.get('id', '')})
    result['read'] = {'subject': read.get('subject'), 'chars': len(read.get('text', '')), 'start': read.get('text', '')[:60], 'attachments': read.get('attachments')}
    # open_email: Ember shows it (after showing something else first).
    result['open_before'] = spark.run_in_app(m, ELSEWHERE)
    result['open'] = agent.tool('open_email', {'id': email.get('id', '')})
    time.sleep(1.5)
    result['open_shows'] = spark.run_in_app(m, "return document.querySelector('.reader h1.subject')?.textContent.trim() || null;")
    result['link'] = email.get('link')
    result['before'] = spark.run_in_app(m, TOP)
    result['mark'] = agent.tool('mark_emails', {'ids': [email.get('id', '')], 'top': True, 'needs_reply': True, 'note': 'Ada wants the budget slide'})
    time.sleep(1)
    result['after'] = spark.run_in_app(m, TOP)
    result['marked'] = agent.tool('list_marked')
    result['found_top'] = agent.tool('find_emails', {'top_only': True, 'days': 90})
    agent.tool('mark_emails', {'ids': [email.get('id', '')], 'top': False})
    time.sleep(1)
    result['removed'] = spark.run_in_app(m, TOP)
    # Drafting a reply: saved to Drafts, threaded, never sent; the badge opens it; again replaces it.
    sent_before = spark.run_in_app(m, SENT_COUNT)
    first = agent.tool('draft_reply', {'id': email.get('id', ''), 'text': "Thanks Ada, I'll add the updated budget slide.\n\nTalk soon", 'top': True})
    result['draft1'] = first
    result['draft1_saved'] = spark.run_in_app(m, DRAFT_CHECK % (json.dumps(first.get('draft_id', '')), json.dumps(email.get('id', ''))))
    second = agent.tool('draft_reply', {'id': email.get('id', ''), 'text': "Thanks Ada, I'll add the updated budget slide (second version)."})
    result['draft2'] = second
    result['drafts_after'] = spark.run_in_app(m, DRAFTS_FOR % json.dumps(SUBJECT))
    time.sleep(1)
    # The user opens it from the badge and saves it from Ember's composer: still a threaded reply.
    result['badge'] = spark.run_in_app(m, OPEN_BADGE)
    time.sleep(2)
    result['user_saved'] = spark.run_in_app(m, USER_SAVED % (json.dumps(SUBJECT), json.dumps(email.get('id', ''))))
    result['sent_unchanged'] = spark.run_in_app(m, SENT_COUNT) == sent_before
    result['created_drafts'] = [first.get('draft_id'), second.get('draft_id')]
    result['disable'] = settings_toggle()
    result['off'] = agent.tool('find_emails', {})
    after_mark = (result['mark'].get('marks') or {}).get(email.get('id', ''), {}) if email else {}
    result['checks'] = {
        'settings_turn_it_on': result['enable']['on'] is True and result['enable']['status'] == 'Listening for agents.' and 'claude mcp add' in (result['enable']['command'] or ''),
        'tools': result['tools'] == ['find_emails', 'read_email', 'open_email', 'mark_emails', 'draft_reply', 'list_marked', 'ember_status', 'calendar_events', 'find_free_times', 'hold_time'],
        'emails_have_links': (result['link'] or '').startswith('http://127.0.0.1:47392/email/') and result['status'].get('links') == 'http://127.0.0.1:47392',
        'open_email_shows_it': result['open'].get('opened') is True and SUBJECT not in (result['open_before'] or SUBJECT) and SUBJECT in (result['open_shows'] or ''),
        'status': bool(result['status'].get('ember')) and len(result['status'].get('accounts', [])) >= 1,
        'status_errors': bool(result['logged']) and result['logged'].get('where') == 'window' and result['logged'].get('count') == 1,
        'find_by_text': bool(email) and email.get('section') in ('people', 'calendar', 'updates', 'newsletters'),
        'find_by_section': all(e['section'] == 'newsletters' for e in result['filtered'].get('emails', [])) and result['filtered'].get('total', 0) > 0,
        'large_listing': result['large']['error'] is None and result['large']['emails'] == 100,
        'bad_section_explained': 'Unknown section' in result['bad'].get('error', ''),
        'read_text': result['read']['subject'] == SUBJECT and result['read']['chars'] > 20,
        'not_on_top_before': result['before']['top'] is False,
        'mark_saved': after_mark.get('top') is True and after_mark.get('reply') is True and after_mark.get('by') == 'agent' and after_mark.get('note') == 'Ada wants the budget slide',
        'top_group_in_inbox': result['after']['top'] is True and (result['after']['first'] or {}).get('subject') == SUBJECT and (result['after']['first'] or {}).get('reply') is True,
        'list_marked': any(e['id'] == email.get('id') and e.get('top') for e in result['marked'].get('emails', [])),
        'find_top_only': [e['id'] for e in result['found_top'].get('emails', [])] == [email.get('id')],
        'remove_from_top': result['removed']['top'] is False,
        'off_is_friendly': result['disable']['on'] is False and "isn't accepting agents" in result['off'].get('error', ''),
        'draft_saved_to_drafts': bool(result['draft1'].get('draft_id')) and (result['draft1_saved'] or {}).get('folder') == 'Drafts' and result['draft1'].get('subject', '').endswith(SUBJECT),
        'draft_is_a_threaded_reply': (result['draft1_saved'] or {}).get('threaded') is True and (result['draft1_saved'] or {}).get('hasText') is True and (result['draft1_saved'] or {}).get('quotes') is True and any('ada@' in t for t in result['draft1'].get('to', [])),
        'redraft_replaces': result['draft2'].get('replaced_previous') is True and result['drafts_after'] == [result['draft2'].get('draft_id')],
        'draft_badge_opens_it': result['badge'].get('opened') is True and 'second version' in (result['badge'].get('text') or '') and result['badge'].get('subject') == 'Re: ' + SUBJECT,
        'saved_from_spark_stays_threaded': result['badge'].get('saved') is True and len(result['user_saved']) == 1 and result['user_saved'][0]['threaded'] is True and result['user_saved'][0]['subject'] == 'Re: ' + SUBJECT,
        'nothing_sent': result['sent_unchanged'] is True,
    }
finally:
    if agent: agent.close()
    # The test's drafts: out of Drafts and Trash.
    for draft_id in result.get('created_drafts', []) or []:
        if draft_id: spark.run_in_app(m, "const q = await messenger.messages.query({ headerMessageId: %s }); if (q.messages.length) await messenger.messages.delete(q.messages.map((x) => x.id), { deletePermanently: true }); return 1;" % json.dumps(draft_id))
    # And the copy Ember saved, plus anything of the test's left in Drafts or Trash.
    spark.run_in_app(m, "const q = await messenger.messages.query({ subject: %s }); const mine = q.messages.filter((x) => x.folder?.specialUse?.some((u) => u === 'drafts' || u === 'trash')); if (mine.length) await messenger.messages.delete(mine.map((x) => x.id), { deletePermanently: true }); return 1;" % json.dumps(SUBJECT))
    m.execute("Services.prefs.setStringPref('extensions.spark.agentSocket', %s); return 1;" % json.dumps(PROFILE_SOCKET or '/private/tmp/claude-503/spark-agent-testprofile.sock'))
    spark.run_in_app(m, "await messenger.storage.local.set({ agentAccess: false }); await messenger.storage.local.remove('agentMarks'); return 1;")
    reload_page()
    m.execute("for (const w of Services.wm.getEnumerator('mail:extensionPopup')) w.minimize(); return true;")

(args.output_dir / 'agent-mcp.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
raise SystemExit(0 if result.get('checks') and all(result['checks'].values()) else 1)
