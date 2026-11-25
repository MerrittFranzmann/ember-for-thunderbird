#!/usr/bin/env python3
"""AI sorting (Cloudflare Clef) end to end, isolated fixture profile only (port 2831), against a local mock of
Cloudflare's Workers AI endpoint (http://127.0.0.1, via the test-only pref extensions.spark.clefEndpoint).

Fills in Settings → Sort with AI like a user (account ID, token, Test connection, switch on), lets the
background sort the Inbox, and checks: every request carries only the documented fields (text <= 600
characters), the mock's confident answers move a sender between inbox sections (Bank of Example: the rules
say Notifications, the mock says Newsletters), unsure answers leave the rules in charge, the status line
counts the work, and turning it off restores the rules. Cleans up the settings, answers and pref.
Never contacts Cloudflare.

  test_ai_sort.py --output-dir DIR
"""
import argparse, http.server, json, threading, time
from pathlib import Path
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)

requests = []
class Clef(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        requests.append({'path': self.path, 'auth': self.headers.get('Authorization'), 'body': body})
        state = body.get('state', {})
        sender, subject = state.get('from', ''), state.get('subject', '')
        noul = lambda p: {'type': 'noul', 'noul': p}
        signals = {'reply': noul(0.1), 'important': noul(0.1), 'receipt': noul(0.0), 'promotion': noul(0.0)}
        # Confident: the bank is a promotion-style newsletter (the rules say Updates), invitations are Calendar,
        # "Recipient" asks for a reply and is important. Unsure for everything else (the rules decide).
        if 'Bank of Example' in sender:
            choice, confidence = 'newsletter', 0.95
            signals['promotion'] = noul(0.9)
        elif 'invitation' in subject.lower():
            choice, confidence = 'calendar', 0.95
        elif 'Recipient' in sender:
            choice, confidence = 'people', 0.95
            signals['reply'], signals['important'] = noul(0.9), noul(0.85)
        else:
            choice, confidence = 'people', 0.5
        answers = {'kind': {'type': 'choice', 'choice': choice, 'confidence': confidence, 'probabilities': {choice: confidence}}, **signals}
        reply = json.dumps({'success': True, 'errors': [], 'messages': [], 'result': {'model': body.get('model'), 'answers': answers, 'usage': {'input_tokens': 120, 'output_tokens': 0}}}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(reply)

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Clef)
threading.Thread(target=server.serve_forever, daemon=True).start()
port = server.server_address[1]
m = spark.connect()
m.execute("Services.prefs.setStringPref('extensions.spark.clefEndpoint', 'http://127.0.0.1:%d/'); return 1;" % port)
ACCOUNT, TOKEN = '0123456789abcdef0123456789abcdef', 'spark_test_token_0123456789abcdefghij'

# Where mail is: open a section (and a filter inside it) and look for a row whose sender or subject has the text.
SECTION = r'''
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
document.querySelector('.sidebar .item.parent[aria-label^="Inbox"]')?.click(); await pause(800);
const tab = (label) => [...document.querySelectorAll('.category-filter')].find((b) => b.textContent.trim() === label);
// Up to three passes while the answer isn't the one this phase expects (WANT): on a large Inbox the list may
// still be regrouping after a change, and it renders only the rows on screen.
const want = WANT;
const look = async (label, text, filter = '', key = '') => {
  let r;
  for (let pass = 0; pass < 3; pass++) { r = await lookOnce(label, text, filter); if (!(key in want) || r === want[key]) break; await pause(1000); }
  return r;
};
const lookOnce = async (label, text, filter = '') => {
  tab(label).click(); await pause(1200);
  if (filter) { const f = [...document.querySelectorAll('.signal-filter')].find((b) => b.textContent.trim() === filter); if (!f) return 'no filter'; f.click(); await pause(800); }
  const v = document.querySelector('.viewport'); v.scrollTop = 0; await pause(200);
  let found = false;
  for (let step = 0; step < 80 && !found; step++) {
    for (const t of document.querySelectorAll('.bucket-toggle[aria-expanded="false"]')) { t.click(); await pause(150); }
    found = [...document.querySelectorAll('.row')].some((r) => (r.querySelector('.from')?.textContent + ' ' + r.querySelector('.subject')?.textContent).includes(text));
    if (found || v.scrollTop + v.clientHeight >= v.scrollHeight - 2) break;
    v.scrollTop += v.clientHeight; v.dispatchEvent(new Event('scroll')); await pause(250);
  }
  v.scrollTop = 0; return found;
};
const badges = async (filter, cls) => {
  tab('People').click(); await pause(800);
  const f = [...document.querySelectorAll('.signal-filter')].find((b) => b.textContent.trim() === filter); if (!f) return 0;
  f.click(); await pause(800);
  const n = document.querySelectorAll(`.row .sig.${cls}`).length;
  [...document.querySelectorAll('.signal-filter')].find((b) => b.textContent.trim() === 'All')?.click(); await pause(300);
  return n;
};
const out = {
  tabs: [...document.querySelectorAll('.category-filter')].map((b) => b.textContent.trim()),
  bankUpdates: await look('Updates', 'Bank of Example', '', 'bankUpdates'), bankNewsletters: await look('Newsletters', 'Bank of Example', '', 'bankNewsletters'),
  inviteCalendar: await look('Calendar', 'Spark smoke calendar invitation', '', 'inviteCalendar'),
  filters: (tab('People').click(), await pause(600), [...document.querySelectorAll('.signal-filter')].map((b) => b.textContent.trim())),
  needsReply: await look('People', 'Recipient', 'Needs reply', 'needsReply'), important: await look('People', 'Recipient', 'Important', 'important'),
  promotions: await look('Newsletters', 'Bank of Example', 'Promotions', 'promotions'), readingHasBank: await look('Newsletters', 'Bank of Example', 'Reading', 'readingHasBank'),
  // Row badges, counted under their own filter (only the rows on screen are rendered).
  badges: { reply: await badges('Needs reply', 'reply'), important: await badges('Important', 'important') },
};
tab('All').click();
return out;'''
def long_run(js, timeout=300):
    """Page JS past Marionette's 30 s limit: start it, park the result on a DOM attribute, poll."""
    spark.run_in_app(m, "const root = document.documentElement; root.removeAttribute('data-ai-result'); (async () => { %s })().then((v) => root.setAttribute('data-ai-result', JSON.stringify({ ok: true, v })), (e) => root.setAttribute('data-ai-result', JSON.stringify({ ok: false, e: String(e) }))); return true;" % js)
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = spark.run_in_app(m, "return document.documentElement.getAttribute('data-ai-result');")
        if r:
            r = json.loads(r)
            if not r['ok']: raise RuntimeError(r['e'])
            return r['v']
        time.sleep(0.5)
    raise TimeoutError('page step timed out')


RESET = "await messenger.storage.local.set({ aiSort: false, clefAccount: '', clefToken: '' }); await messenger.storage.local.remove(['aiCategories', 'aiSortStatus']); return 1;"
def fresh_page():
    """Settings changed behind the page's back: reload Ember so it reads them again."""
    spark.run_in_app(m, "setTimeout(() => location.reload(), 50); return 1;")
    time.sleep(3)
    for _ in range(120):
        try:
            if spark.run_in_app(m, "return !!document.querySelector('.sidebar .item') && !document.querySelector('.mini-spin');"): return
        except Exception: pass
        time.sleep(0.5)


result = {}
try:
    # On screen: a minimized Ember keeps its lists' last grouping until it's shown (by design).
    m.execute("for (const w of Services.wm.getEnumerator('mail:extensionPopup')) if (w.document.querySelector('browser')?.currentURI?.spec.endsWith('/app.html') && w.windowState === w.STATE_MINIMIZED) w.restore(); return 1;")
    spark.run_in_app(m, RESET)
    fresh_page()
    result['before'] = long_run(SECTION.replace('WANT', json.dumps({'bankUpdates': True, 'bankNewsletters': False})))
    # Settings → Sort with AI, as a user would.
    spark.open_settings(m, 'ai', 'Sort with AI')
    result['settings'] = spark.in_settings(m, spark.SETTING_ITEM + r'''
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const set = (label, value) => { const i = document.querySelector(`input[aria-label="${label}"]`); i.value = value; i.dispatchEvent(new Event('change', { bubbles: true })); };
const ai = () => item('Sort with AI');
const toggle = () => ai().querySelector('input.switch');
const disabledBefore = toggle().disabled;
set('Cloudflare account ID', %s); set('Cloudflare API token', %s); await pause(300);
[...ai().querySelectorAll('button')].find((b) => b.textContent.includes('Test connection')).click();
for (let i = 0; i < 40 && !ai().querySelector('p.note[role=status]'); i++) await pause(100);
const test = ai().querySelector('p.note[role=status]')?.textContent.trim();
toggle().click(); await pause(300);
return { disabledBefore, test, on: toggle().checked };''' % (json.dumps(ACCOUNT), json.dumps(TOKEN)))
    # Wait for the background to finish the Inbox.
    status = None
    for _ in range(600):
        status = spark.run_in_app(m, "return (await messenger.storage.local.get('aiSortStatus')).aiSortStatus || null;")
        if status and status.get('state') in ('idle', 'error') and status.get('total'): break
        time.sleep(1)
    result['status'] = status
    time.sleep(1.5)  # the status line follows the background's progress
    result['statusLine'] = spark.in_settings(m, spark.SETTING_ITEM + "return item('Sort with AI').querySelector('small.status')?.textContent.trim();")
    spark.close_settings(m)
    time.sleep(2)
    result['after'] = long_run(SECTION.replace('WANT', json.dumps({'bankUpdates': False, 'bankNewsletters': True, 'inviteCalendar': True, 'needsReply': True, 'important': True, 'promotions': True, 'readingHasBank': False})))
    # Off again: the rules decide.
    spark.open_settings(m, 'ai', 'Sort with AI')
    spark.in_settings(m, spark.SETTING_ITEM + "item('Sort with AI').querySelector('input.switch').click(); await new Promise((r) => setTimeout(r, 300)); return 1;")
    spark.close_settings(m)
    time.sleep(2)
    result['off'] = long_run(SECTION.replace('WANT', json.dumps({'bankUpdates': True, 'bankNewsletters': False})))
    sorting = [r for r in requests if r['body'].get('state', {}).get('from') != 'Ada Lovelace <ada@example.org>']
    keys = {tuple(sorted(r['body'].get('state', {}).keys())) for r in sorting}
    result['requests'] = {'total': len(requests), 'sorting': len(sorting), 'stateKeys': [list(k) for k in keys], 'maxText': max((len(r['body']['state'].get('text', '')) for r in sorting), default=0),
                          'paths': sorted({r['path'] for r in requests}), 'questions': [list(q) for q in {tuple(sorted(r['body'].get('questions', {}).keys())) for r in sorting}], 'auth': sorted({r['auth'] for r in requests}), 'models': sorted({r['body'].get('model') for r in requests})}
    st = status or {}
    B, A, O = result['before'], result['after'], result['off']
    st = status or {}
    result['checks'] = {
        'tabs': B['tabs'] == ['All', 'People', 'Calendar', 'Updates', 'Newsletters', 'Pinned'],
        'rules_put_bank_in_updates': B['bankUpdates'] is True and B['bankNewsletters'] is False,
        'no_filters_without_ai': B['filters'] == [],
        'switch_needs_credentials': result['settings']['disabledBefore'] is True,
        'test_connection': (result['settings']['test'] or '').startswith('Connected: a sample email was sorted as people'),
        'switched_on': result['settings']['on'] is True,
        'sorted_inbox': st.get('state') == 'idle' and st.get('sorted') == st.get('total') and st.get('total', 0) > 0 and len(sorting) == st.get('total'),
        'only_documented_fields': result['requests']['stateKeys'] == [['automated', 'from', 'mailing_list', 'recipients', 'subject', 'text', 'unsubscribe_link']] and result['requests']['maxText'] <= 600,
        'one_request_per_email_with_signals': result['requests']['questions'] == [['important', 'kind', 'promotion', 'receipt', 'reply', 'spam']],
        'token_and_model': result['requests']['auth'] == ['Bearer ' + TOKEN] and result['requests']['models'] == ['clef-flash'] and result['requests']['paths'] == ['/clef-flash'],
        'confident_answer_moves_bank': A['bankNewsletters'] is True and A['bankUpdates'] is False,
        'invitation_in_calendar': A['inviteCalendar'] is True,
        'filters_shown': A['filters'] == ['All', 'Needs reply', 'Important'],
        'needs_reply_filter': A['needsReply'] is True,
        'important_filter': A['important'] is True,
        'promotions_vs_reading': A['promotions'] is True and A['readingHasBank'] is False,
        'row_badges': A['badges']['reply'] > 0 and A['badges']['important'] > 0,
        'status_line': 'Inbox emails sorted' in (result['statusLine'] or ''),
        'off_restores_rules': O['bankUpdates'] is True and O['bankNewsletters'] is False and O['filters'] == [],
    }
finally:
    m.execute("Services.prefs.clearUserPref('extensions.spark.clefEndpoint'); return 1;")
    spark.run_in_app(m, RESET)
    fresh_page()
    server.shutdown()

(args.output_dir / 'ai-sort.json').write_text(json.dumps(result, indent=2))
print(json.dumps({k: result.get(k) for k in ('before', 'settings', 'status', 'statusLine', 'after', 'off', 'requests', 'checks')}, indent=2))
raise SystemExit(0 if result.get('checks') and all(result['checks'].values()) else 1)
