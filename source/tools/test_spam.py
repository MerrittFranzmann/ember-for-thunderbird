#!/usr/bin/env python3
"""Spam you teach Ember (src/lib/spam.ts), isolated fixture profile only (port 2831), against a local mock of
Cloudflare's Clef endpoint (http://127.0.0.1 via the test-only pref extensions.spark.clefEndpoint). Never contacts
Cloudflare; never sends mail.

Creates a Spam folder on the Work (test) account for the run (the fixture accounts have none) and seeds emails.
Checks: right-click → Mark as spam moves an email to Spam, trains Thunderbird's junk filter (its spam count goes up)
and remembers the sender; Undo takes all of it back; new mail from that sender goes straight to Spam (the page says
so); Not spam in the Spam view brings it back, trains the filter the other way and forgets the sender; with AI
sorting on, Clef's spam question carries the marks as examples, a sure answer on recent mail moves the email, an
unsure one shows "Spam?" on the row and "Looks like spam?" in the reader, whose Not spam clears it. Cleans up
settings, answers, feedback, the pref, the seeded mail and the folder.

  test_spam.py --output-dir DIR
"""
import argparse, http.server, json, threading, time
from datetime import datetime, timezone
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import format_datetime
from pathlib import Path
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)

RUN = str(int(time.time()))
SENDER = f'deals@spamdeals-{RUN}.example'
SUBJECT = {k: f'Spam fixture {k} {RUN}' for k in ('A', 'B', 'SURE', 'MAYBE')}

requests = []
class Clef(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        requests.append(body)
        subject = body.get('state', {}).get('subject', '')
        noul = lambda p: {'type': 'noul', 'noul': p}
        spam = 0.97 if SUBJECT['SURE'] in subject else 0.8 if SUBJECT['MAYBE'] in subject else 0.02
        answers = {'kind': {'type': 'choice', 'choice': 'newsletter', 'confidence': 0.5}, 'reply': noul(0.1), 'important': noul(0.1), 'receipt': noul(0.0), 'promotion': noul(0.0)}
        if 'spam' in body.get('questions', {}): answers['spam'] = noul(spam)
        reply = json.dumps({'success': True, 'errors': [], 'messages': [], 'result': {'answers': answers}}).encode()
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers(); self.wfile.write(reply)

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Clef)
threading.Thread(target=server.serve_forever, daemon=True).start()
m = spark.connect()
m.execute("Services.prefs.setStringPref('extensions.spark.clefEndpoint', 'http://127.0.0.1:%d/'); return 1;" % server.server_address[1])

CHROME = r'''const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const root = MailServices.accounts.getAccount('account2').incomingServer.rootFolder;
const inbox = root.getChildNamed('Inbox');
const junkFolder = () => root.subFolders.find((f) => f.getFlag(Ci.nsMsgFolderFlags.Junk));
const ours = (f) => { try { return [...f.msgDatabase.enumerateMessages()].filter((h) => h.messageId.endsWith('@spark-spamtest.test')); } catch { return []; } };
const where = (subject) => { for (const f of MailServices.accounts.allFolders) for (const h of ours(f)) if (h.mime2DecodedSubject === subject) return { folder: f.name, junkscore: h.getStringProperty('junkscore'), origin: h.getStringProperty('junkscoreorigin') }; return null; };
const corpus = () => { const c = MailServices.junk.QueryInterface(Ci.nsIMsgCorpus); const j = {}, g = {}; c.corpusCounts(Ci.nsIJunkMailPlugin.JUNK_TRAIT, j); c.corpusCounts(Ci.nsIJunkMailPlugin.GOOD_TRAIT, g); return { junk: j.value, good: g.value }; };
'''
def chrome(body, args=None):
    return m.execute(CHROME + 'const ARGS = %s;\n' % json.dumps(args or []) + body.replace('arguments[', 'ARGS['))

def seed(key, sender=SENDER, new_mail=False):
    e = EmailMessage(policy=SMTP)
    e['From'] = f'Mega Deals <{sender}>'; e['To'] = 'Work Tester <work@spark.test>'; e['Date'] = format_datetime(datetime.now(timezone.utc))
    e['Message-ID'] = f'<{key}-{RUN}@spark-spamtest.test>'; e['Subject'] = SUBJECT[key]; e['X-Mozilla-Status'] = '0000'
    e.set_content(f'Limited offer {key}. Claim your prize now.')
    # New mail: Thunderbird announces messages it has classified that carry the New flag (what the background hears).
    return chrome('''inbox.QueryInterface(Ci.nsIMsgLocalMailFolder).addMessage(arguments[0]);
const hdr = ours(inbox).find((h) => h.messageId === arguments[1]);
if (arguments[2] && hdr) { hdr.orFlags(Ci.nsMsgMessageFlags.New); MailServices.mfn.notifyMsgsClassified([hdr], false, false); }
return !!hdr;''', [e.as_string(), f'{key}-{RUN}@spark-spamtest.test', new_mail])

HELPERS = r'''
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms = 10000) => { for (let t = 0; t < ms; t += 100) { const v = test(); if (v) return v; await pause(100); } return test(); };
const row = (s) => [...document.querySelectorAll('.viewport .row')].find((r) => r.querySelector('.subject')?.textContent.trim() === s);
const rightClick = (el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
const menuItem = (text) => [...document.querySelectorAll('.context-menu button')].find((b) => b.textContent.trim().startsWith(text));
const toasts = () => [...document.querySelectorAll('.toast .text')].map((t) => t.textContent.trim());
const mailbox = async (key) => { document.querySelector(`.sidebar [data-mailbox="${key}"] > button.item.parent`).click(); await pause(900); };
const storage = async (k) => (await messenger.storage.local.get(k))[k] ?? null;
'''
def page(body):
    r = spark.run_in_app(m, HELPERS + body)
    if isinstance(r, str) and r.startswith('ERROR'): raise RuntimeError(r)
    return r

def fresh_page():
    spark.run_in_app(m, "setTimeout(() => location.reload(), 50); return 1;")
    time.sleep(3)
    for _ in range(120):
        try:
            if spark.run_in_app(m, "return !!document.querySelector('.sidebar .item') && !document.querySelector('.mini-spin');"): return
        except Exception: pass
        time.sleep(0.5)

def wait_for(test, seconds=30):
    end = time.time() + seconds
    while time.time() < end:
        v = test()
        if v: return v
        time.sleep(0.5)
    return test()

RESET = "await messenger.storage.local.set({ aiSort: false, clefAccount: '', clefToken: '' }); await messenger.storage.local.remove(['aiCategories', 'aiGroups', 'aiSortStatus', 'spamFeedback', 'spamMoved']); return 1;"
result = {}
created_folder = False
try:
    m.execute("for (const w of Services.wm.getEnumerator('mail:extensionPopup')) if (w.document.querySelector('browser')?.currentURI?.spec.endsWith('/app.html') && w.windowState === w.STATE_MINIMIZED) w.restore(); return 1;")
    page(RESET)
    created_folder = chrome("if (junkFolder()) return false; root.createSubfolder('Junk', null); root.getChildNamed('Junk').setFlag(Ci.nsMsgFolderFlags.Junk); return true;")
    seed('A')
    fresh_page()
    start = chrome('return corpus();')

    # 1. Right-click → Mark as spam.
    result['mark'] = page('''await mailbox('inbox'); const r = await until(() => row(%s), 15000); rightClick(r); await pause(200);
const item = menuItem('Mark as spam'); const offered = !!item; item?.click(); await pause(2500);
return { offered, gone: !row(%s), toasts: toasts(), feedback: await storage('spamFeedback') };''' % (json.dumps(SUBJECT['A']), json.dumps(SUBJECT['A'])))
    result['markWhere'] = chrome('return where(arguments[0]);', [SUBJECT['A']])
    result['markCorpus'] = chrome('return corpus();')

    # 2. Undo: all of it back.
    result['undo'] = page('''[...document.querySelectorAll('.toast')].find((t) => t.textContent.includes('Moved to Spam'))?.querySelector('.act')?.click(); await pause(3000);
return { feedback: await storage('spamFeedback') };''')
    result['undoWhere'] = chrome('return where(arguments[0]);', [SUBJECT['A']])
    result['undoCorpus'] = chrome('return corpus();')

    # Marked again, to go on.
    page('''await mailbox('inbox'); const r = await until(() => row(%s), 15000); rightClick(r); await pause(200); menuItem('Mark as spam').click(); await pause(2500); return 1;''' % json.dumps(SUBJECT['A']))

    # 3. New mail from that sender: straight to Spam, and the page says so.
    seed('B', new_mail=True)
    result['senderRule'] = wait_for(lambda: chrome('return where(arguments[0]);', [SUBJECT['B']]) if (chrome('return where(arguments[0])?.folder;', [SUBJECT['B']]) == 'Junk') else None, 30)
    result['senderToast'] = page("await pause(500); return toasts().filter((t) => t.includes('to Spam'));")

    # 4. Not spam, from the Spam view.
    result['notSpam'] = page('''await mailbox('junk'); const r = await until(() => row(%s), 15000); if (!r) return { found: false };
rightClick(r); await pause(200); const item = menuItem('Not spam'); const offered = !!item; item?.click(); await pause(2500);
return { found: true, offered, feedback: await storage('spamFeedback') };''' % json.dumps(SUBJECT['A']))
    result['notSpamWhere'] = chrome('return where(arguments[0]);', [SUBJECT['A']])
    result['notSpamCorpus'] = chrome('return corpus();')

    # 5. AI sorting: the spam question carries the marks; sure → moved, unsure → asks.
    seed('SURE'); seed('MAYBE')
    requests.clear()
    page("await messenger.storage.local.set({ clefAccount: '0123456789abcdef0123456789abcdef', clefToken: 'spark_test_token_0123456789abcdefghij', aiSort: true }); return 1;")
    status = wait_for(lambda: (lambda s: s if s and s.get('state') in ('idle', 'error') and s.get('total') else None)(page("return await storage('aiSortStatus');")), 400)
    result['aiStatus'] = status
    result['sureWhere'] = wait_for(lambda: chrome('return where(arguments[0]);', [SUBJECT['SURE']]) if chrome('return where(arguments[0])?.folder;', [SUBJECT['SURE']]) == 'Junk' else None, 20)
    result['maybeWhere'] = chrome('return where(arguments[0]);', [SUBJECT['MAYBE']])
    question = next((r['questions']['spam']['instructions'] for r in requests if 'spam' in r.get('questions', {})), '')
    result['question'] = {'asked': sum(1 for r in requests if 'spam' in r.get('questions', {})), 'of': len(requests), 'notSpamExample': f'"{SUBJECT["A"]}"' in question.split('NOT spam')[-1] if 'NOT spam' in question else False, 'noAddresses': SENDER not in question}
    fresh_page()
    result['ask'] = page('''await mailbox('inbox'); const r = await until(() => row(%s), 15000); if (!r) return { found: false };
const badge = !!r.querySelector('.sig.spam'); r.click();
const bar = await until(() => [...document.querySelectorAll('.spam-bar')].find((b) => b.textContent.includes('may be spam')), 10000);
const buttons = bar ? [...bar.querySelectorAll('button')].map((b) => b.textContent.trim()) : [];
bar?.querySelector('button:last-of-type')?.click(); await pause(2000);
return { found: true, badge, buttons, barGone: !document.querySelector('.spam-bar'), badgeGone: !row(%s)?.querySelector('.sig.spam'), cleared: ((await storage('spamFeedback'))?.cleared || []).some((k) => k.startsWith('MAYBE-')) };''' % (json.dumps(SUBJECT['MAYBE']), json.dumps(SUBJECT['MAYBE'])))
finally:
    try: page(RESET)
    except Exception as error: print('reset failed:', error)
    m.execute("Services.prefs.clearUserPref('extensions.spark.clefEndpoint'); return 1;")
    chrome('''for (const f of MailServices.accounts.allFolders) { const hs = ours(f); if (hs.length) f.deleteMessages(hs, null, true, false, null, false); }
if (arguments[0]) { const j = root.getChildNamed('Junk'); if (j && !ours(j).length) root.propagateDelete(j, true); }
return 1;''', [created_folder])
    try: fresh_page()
    except Exception: pass
    spark._end_session(m)

r = result
fb = lambda k: (r.get(k) or {}).get('feedback') or {}
checks = {
    'mark_moves_trains_remembers': r['mark']['offered'] and r['mark']['gone'] and (r.get('markWhere') or {}).get('folder') == 'Junk' and r['markWhere'].get('junkscore') == '100' and r['markWhere'].get('origin') == 'user'
        and r['markCorpus']['junk'] == start['junk'] + 1 and SENDER in fb('mark').get('senders', {}) and any(t.startswith('Moved to Spam') for t in r['mark']['toasts']),
    'undo_takes_it_back': (r.get('undoWhere') or {}).get('folder') == 'Inbox' and r['undoCorpus'] == start and not fb('undo').get('senders'),
    'sender_rule_new_mail': (r.get('senderRule') or {}).get('folder') == 'Junk' and any('from a sender you marked' in t for t in r.get('senderToast') or []),
    'not_spam_from_spam_view': (r.get('notSpam') or {}).get('offered') and (r.get('notSpamWhere') or {}).get('folder') == 'Inbox' and r['notSpamWhere'].get('junkscore') == '0'
        and r['notSpamCorpus']['junk'] == start['junk'] and r['notSpamCorpus']['good'] == start['good'] + 1 and SENDER not in fb('notSpam').get('senders', {}) and any(k.startswith('A-') for k in fb('notSpam').get('cleared', [])),
    'clef_question_with_examples': r['question']['asked'] > 0 and r['question']['asked'] == r['question']['of'] and r['question']['notSpamExample'] and r['question']['noAddresses'],
    'clef_sure_moves': (r.get('sureWhere') or {}).get('folder') == 'Junk' and (r['sureWhere'].get('origin') or '') != 'user',
    'clef_unsure_asks': (r.get('maybeWhere') or {}).get('folder') == 'Inbox' and (r.get('ask') or {}).get('badge') and r['ask'].get('buttons') == ['Move to Spam', 'Not spam'] and r['ask'].get('barGone') and r['ask'].get('badgeGone') and r['ask'].get('cleared'),
}
result['start'] = start
result['checks'] = checks
(args.output_dir / 'spam.json').write_text(json.dumps(result, indent=2, ensure_ascii=False, default=str))
print(json.dumps(result, indent=2, ensure_ascii=False, default=str))
print('ALL PASS' if all(checks.values()) else 'FAIL: ' + ', '.join(k for k, v in checks.items() if not v))
raise SystemExit(0 if all(checks.values()) else 1)
