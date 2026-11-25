#!/usr/bin/env python3
"""Agent Activity end to end, isolated fixture profile only (port 2831): the real mcp/spark-mcp.mjs over stdio
(introducing itself as Codex) → Ember's agent socket (a temporary path via extensions.spark.agentSocket) → the page.
Never sends mail: draft_reply only saves to Drafts, and the test deletes its drafts.

As Codex, with reasons: a search, three reads, a mark (top + needs reply + note), a reply draft, a failed read and
a status check. Then checks: the log (agent, kinds, reason, Undo's "before"); Codex is announced as a new agent
(the registry is older than its first day); the Agent Activity page shows one session with the reason and summary,
the reads folded into one row, the draft with its preview and "Draft" tag, the failure, To review with the draft and
the email on top, the sidebar count, and the status check only under Everything; Undo takes the mark back; the
email's reader says what Codex did; a deleted draft shows Discarded; blocking Codex makes its next request fail.
Restores storage, the pref and the window.

  test_agent_activity.py --output-dir DIR
"""
import argparse, json, os, subprocess, time
from pathlib import Path
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
SOCKET = '/private/tmp/claude-503/spark-agent-activity-test.sock'
SERVER = Path(__file__).resolve().parent.parent / 'mcp' / 'spark-mcp.mjs'
SUBJECT = 'Reading pane layout review'
REASON = 'Check what Ada needs for the layout review'
AGENT = 'codex-mcp-client'

m = spark.connect()
PROFILE_SOCKET = m.execute("return Services.prefs.getStringPref('extensions.spark.agentSocket', '');")
m.execute("Services.prefs.setStringPref('extensions.spark.agentSocket', %s); return 1;" % json.dumps(SOCKET))

class Agent:
    def __init__(self, name):
        self.p = subprocess.Popen(['node', str(SERVER)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env={**os.environ, 'SPARK_AGENT_SOCKET': SOCKET})
        self.n = 0
        self.rpc('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': name, 'version': '1'}})
        self.p.stdin.write(json.dumps({'jsonrpc': '2.0', 'method': 'notifications/initialized'}) + '\n'); self.p.stdin.flush()
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
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms = 10000) => { for (let t = 0; t < ms; t += 100) { const v = test(); if (v) return v; await pause(100); } return test(); };
const storage = async (k) => (await messenger.storage.local.get(k))[k] ?? null;
const sideItem = () => document.querySelector('.sidebar .agent-btn');
const openActivity = async () => { sideItem()?.click(); await until(() => document.querySelector('.activity'), 8000); await pause(400); };
const text = (el) => el?.textContent.replace(/\s+/g, ' ').trim() || '';
'''
def page(body):
    r = spark.run_in_app(m, HELPERS + body)
    if isinstance(r, str) and r.startswith('ERROR'): raise RuntimeError(r)
    return r
def wait_for(test, seconds=20):
    end = time.time() + seconds
    while time.time() < end:
        v = test()
        if v: return v
        time.sleep(0.4)
    return test()

RESET = "await messenger.storage.local.remove(['agentActivity', 'agentRegistry', 'agentReviewDismissed', 'agentMarks']); return 1;"
result = {}
agent = None
drafts = []
try:
    m.execute("for (const w of Services.wm.getEnumerator('mail:extensionPopup')) if (w.document.querySelector('browser')?.currentURI?.spec.endsWith('/app.html') && w.windowState === w.STATE_MINIMIZED) w.restore(); return 1;")
    # Agents on; the registry is two days old and knows only Claude Code, so Codex is a new agent.
    page(RESET)
    page("const old = Date.now() - 2 * 86400000; await messenger.storage.local.set({ agentAccess: true, agentRegistry: { since: old, agents: { 'claude-code': { first: old, last: old, count: 3 } } } }); return 1;")
    spark.run_in_app(m, "setTimeout(() => location.reload(), 50); return 1;")
    time.sleep(3)
    wait_for(lambda: spark.run_in_app(m, "return !!document.querySelector('.sidebar .item') && !document.querySelector('.mini-spin');"), 60)
    wait_for(lambda: os.path.exists(SOCKET), 20)

    agent = Agent(AGENT)
    found = agent.tool('find_emails', {'query': SUBJECT, 'days': 90, 'reason': REASON})
    emails = [e for e in found.get('emails', []) if e.get('subject', '').endswith(SUBJECT)][:3]
    ids = [e['id'] for e in emails]
    for i in ids: agent.tool('read_email', {'id': i, 'max_chars': 500})
    target = next((e['id'] for e in emails if 'Ada' in e.get('from', '')), ids[0] if ids else '')
    result['mark'] = agent.tool('mark_emails', {'ids': [target], 'top': True, 'needs_reply': True, 'note': 'Ada needs the layout notes', 'reason': REASON})
    draft = agent.tool('draft_reply', {'id': target, 'text': 'Thanks Ada, the layout notes are attached to the review doc.\n\nTalk soon', 'reason': REASON})
    result['draft'] = draft
    if draft.get('draft_id'): drafts.append(draft['draft_id'])
    result['failed'] = agent.tool('read_email', {'id': 'no-such-email@spark.test'})
    agent.tool('ember_status')
    time.sleep(1.5)

    result['log'] = page("return (await storage('agentActivity') || []).map((e) => ({ kind: e.kind, agent: e.agent, reason: e.reason || null, error: !!e.error, before: e.before || null, emails: (e.emails || []).length }));")
    result['registry'] = page("return await storage('agentRegistry');")

    # The page.
    result['view'] = page(r'''await openActivity();
const sessions = [...document.querySelectorAll('.session')];
const s = sessions[0];
return {
  sidebarCount: text(sideItem()?.querySelector('.agent-badge')),
  newAgent: text(document.querySelector('.new-agent')),
  review: [...document.querySelectorAll('.review-row')].map((r) => text(r.querySelector('.what'))),
  sessions: sessions.length,
  head: text(s?.querySelector('.line1')), reason: text(s?.querySelector('.reason')), summary: text(s?.querySelector('.summary')),
  rows: [...(s?.querySelectorAll('.row') || [])].map((r) => text(r.querySelector('.sentence'))),
  readChips: s ? [...s.querySelectorAll('.row')].filter((r) => /^Read \d+ emails/.test(text(r.querySelector('.sentence')))).map((r) => r.querySelectorAll('.chips .chip').length) : [],
  preview: text(s?.querySelector('.preview')),
  failedTag: !!s?.querySelector('.row.failed .tag.bad'),
  draftTag: [...(s?.querySelectorAll('.tag') || [])].map(text),
  statusHidden: !text(s).includes("Checked Ember's status"),
};''')
    result['everything'] = page(r'''const sel = document.querySelector('.activity .filter select'); sel.value = 'everything'; sel.dispatchEvent(new Event('change', { bubbles: true })); await pause(400);
const shows = text(document.querySelector('.session')).includes("Checked Ember's status");
sel.value = 'all'; sel.dispatchEvent(new Event('change', { bubbles: true })); await pause(300);
return shows;''')

    # Undo the mark.
    result['undo'] = page(r'''const row = [...document.querySelectorAll('.session .row')].find((r) => text(r.querySelector('.sentence')).startsWith('Moved'));
row?.querySelector('.undo')?.click(); await pause(1200);
const marks = await storage('agentMarks') || {};
return { found: !!row, mark: marks[%s] || null, undoneTag: text(row?.querySelector('.tag')), review: document.querySelectorAll('.review-row').length };''' % json.dumps(target))

    # The email's reader says what Codex did.
    result['reader'] = page(r'''await messenger.runtime.sendMessage({ type: 'spark:open-email', id: %s }); await pause(2500);
return { line: text(document.querySelector('.agent-line')), hasDraftButton: [...document.querySelectorAll('.agent-line button')].some((b) => text(b) === 'Open draft') };''' % json.dumps(target))

    # A deleted draft shows as Discarded.
    if drafts:
        page("const q = await messenger.messages.query({ headerMessageId: %s }); if (q.messages.length) await messenger.messages.delete(q.messages.map((x) => x.id), { deletePermanently: true }); return 1;" % json.dumps(drafts[0]))
        time.sleep(1)
    result['discarded'] = page(r'''await openActivity();
document.querySelector('.list-head button[aria-label="Refresh"]')?.click(); await pause(2000);
return { tags: [...document.querySelectorAll('.session .tag')].map(text), review: document.querySelectorAll('.review-row').length };''')

    # Block Codex: its next request fails.
    page(r'''[...document.querySelectorAll('.new-agent button')].find((b) => text(b).startsWith('Block'))?.click(); await pause(800); return 1;''')
    result['blockedRegistry'] = page("return (await storage('agentRegistry'))?.agents?.[%s] || null;" % json.dumps(AGENT))
    result['blocked'] = agent.tool('find_emails', {'days': 3})
finally:
    if agent: agent.close()
    for d in drafts:
        try: page("const q = await messenger.messages.query({ headerMessageId: %s }); if (q.messages.length) await messenger.messages.delete(q.messages.map((x) => x.id), { deletePermanently: true }); return 1;" % json.dumps(d))
        except Exception as error: print('draft cleanup failed:', error)
    try: page("const q = await messenger.messages.query({ subject: %s }); const mine = q.messages.filter((x) => x.folder?.specialUse?.some((u) => u === 'drafts' || u === 'trash')); if (mine.length) await messenger.messages.delete(mine.map((x) => x.id), { deletePermanently: true }); return 1;" % json.dumps(SUBJECT))
    except Exception as error: print('cleanup failed:', error)
    m.execute("Services.prefs.setStringPref('extensions.spark.agentSocket', %s); return 1;" % json.dumps(PROFILE_SOCKET or '/private/tmp/claude-503/spark-agent-testprofile.sock'))
    try:
        page(RESET.replace('return 1;', '') + "await messenger.storage.local.set({ agentAccess: false }); return 1;")
        spark.run_in_app(m, "setTimeout(() => location.reload(), 50); return 1;")
        time.sleep(3)
    except Exception as error: print('reset failed:', error)
    m.execute("for (const w of Services.wm.getEnumerator('mail:extensionPopup')) w.minimize(); return true;")
    spark._end_session(m)

r = result
log = r.get('log') or []
kinds = [e['kind'] for e in log]
v = r.get('view') or {}
checks = {
    'logged_as_codex_with_reasons': len(log) >= 8 and all(e['agent'] == AGENT for e in log) and kinds.count('read') >= 4 and {'search', 'mark', 'draft', 'check'} <= set(kinds)
        and any(e['kind'] == 'search' and e['reason'] == REASON for e in log) and any(e['kind'] == 'read' and e['error'] for e in log)
        and any(e['kind'] == 'mark' and e['before'] for e in log),
    'new_agent_announced': ((r.get('registry') or {}).get('agents', {}).get(AGENT) or {}).get('alert') is True and 'A new agent, Codex, used Ember' in v.get('newAgent', ''),
    'one_session_with_reason_and_summary': v.get('sessions') == 1 and v.get('head', '').startswith('Codex') and v.get('reason') == f'“{REASON}”'
        and v.get('summary', '').startswith('Searched once, read ') and 'marked 1, drafted 1 reply, 1 failed' in v.get('summary', ''),
    'reads_folded': len(v.get('readChips') or []) == 1 and (v.get('readChips') or [0])[0] >= 2,
    'draft_preview_and_tag': 'layout notes are attached' in v.get('preview', '') and 'Draft' in (v.get('draftTag') or []) and v.get('failedTag') is True,
    'to_review_and_sidebar_count': len(v.get('review') or []) == 2 and v.get('sidebarCount') == '2',
    'status_only_under_everything': v.get('statusHidden') is True and r.get('everything') is True,
    'undo_takes_mark_back': (r.get('undo') or {}).get('found') and not ((r['undo'].get('mark') or {}).get('top')) and r['undo'].get('undoneTag') == 'Undone' and r['undo'].get('review') == 1,
    'reader_says_what_codex_did': 'Codex' in (r.get('reader') or {}).get('line', '') and 'drafted a reply' in r['reader'].get('line', '') and r['reader'].get('hasDraftButton') is True,
    'deleted_draft_discarded': 'Discarded' in ((r.get('discarded') or {}).get('tags') or []) and r['discarded'].get('review') == 0,
    'blocked_agent_refused': (r.get('blockedRegistry') or {}).get('blocked') is True and 'blocked Codex' in (r.get('blocked') or {}).get('error', ''),
}
result['checks'] = checks
(args.output_dir / 'agent-activity.json').write_text(json.dumps(result, indent=2, ensure_ascii=False, default=str))
print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
print('ALL PASS' if all(checks.values()) else 'FAIL: ' + ', '.join(k for k, v in checks.items() if not v))
raise SystemExit(0 if all(checks.values()) else 1)
