#!/usr/bin/env python3
"""Mail that arrives without Thunderbird announcing it (1.0.3). Thunderbird's own Exchange (EWS) support adds new
mail to the folder without the new-mail event or a folder-count change, so Ember's list never heard of it until a
reload (the user's Work inbox showed no "Today" at all). Isolated fixture profile only (port 2831).

An email is written into the test Inbox's store and its header into the database (account2) with no notification, while the Smart Inbox
is open and Ember is in front. Checks: it's listed within 75 s (the minute's count comparison), under Today; a
second one 20 s later is listed too; nothing else changes in the list. The emails are removed afterwards.

  test_silent_arrival.py --output-dir DIR
"""
import argparse, json, time
from pathlib import Path
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)

m = spark.connect()
def chrome(script, values=()):
    reply = m._cmd("WebDriver:ExecuteScript", {"script": script, "args": list(values)})
    return reply.get("value") if isinstance(reply, dict) else reply
def page(body):
    out = spark.run_in_app(m, body)
    if isinstance(out, str) and out.startswith('ERROR'):
        raise RuntimeError(out)
    return out

ADD = '''const [subject, key] = arguments;
const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const inbox = MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox');
const db = inbox.msgDatabase; const mid = `silent-${key}-${Date.now()}@spark.test`;
// A whole email in the folder's store (so it can be read and saved like any other), and its header in the
// database without a notification: no new-mail event, no folder-count event.
const raw = `From: Grace Hopper <grace@navy.test>\\r\\nTo: merritt@spark.test\\r\\nSubject: ${subject}\\r\\nDate: ${new Date().toUTCString()}\\r\\nMessage-ID: <${mid}>\\r\\n\\r\\nArrived without notice.\\r\\n`;
const out = inbox.msgStore.getNewMsgOutputStream(inbox);
out.write(raw, raw.length);
const hdr = db.createNewHdr(0xffffffff);
hdr.storeToken = inbox.msgStore.finishNewMessage(inbox, out); hdr.messageSize = raw.length;
hdr.subject = subject; hdr.author = 'Grace Hopper <grace@navy.test>'; hdr.recipients = 'merritt@spark.test';
hdr.date = Date.now() * 1000; hdr.messageId = mid;
db.addNewHdrToDB(hdr, false);
// The store grew under the summary: say the summary matches it again (else Thunderbird reads none of the folder).
db.summaryValid = true;
return hdr.messageKey;'''
REMOVE = '''const [stamp] = arguments;
const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const inbox = MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox');
const db = inbox.msgDatabase; const gone = [...db.enumerateMessages()].filter((h) => /^Silent arrival/.test(h.subject) && (!stamp || h.subject.endsWith(String(stamp))));
// Deleted the ordinary way (Thunderbird and Ember are told), so Ember's saved copy lets them go too.
if (gone.length) inbox.deleteMessages(gone, null, true, false, null, false);
inbox.updateSummaryTotals(true);
return gone.length;'''
FIND = '''const [subject] = arguments; const row = [...document.querySelectorAll('[role="option"]')].find((r) => r.textContent.includes(subject));
if (!row) return null;
// The list is virtual (rows placed by transform): the date group is the nearest group heading above the row.
const top = row.getBoundingClientRect().top;
const heads = [...document.querySelectorAll('.bucket-toggle')].map((b) => ({ label: b.getAttribute('aria-label') || '', top: b.getBoundingClientRect().top })).filter((h) => h.top <= top).sort((a, b) => b.top - a.top);
return { bucket: heads[0]?.label || '' };'''

stamp = int(time.time())
keys = [900_000_000 + stamp % 100_000, 900_100_000 + stamp % 100_000]
subjects = [f'Silent arrival {stamp}', f'Silent arrival two {stamp}']
result = {}
try:
    # Ember in front, on the Smart Inbox.
    chrome("for (const w of Services.wm.getEnumerator('mail:extensionPopup')) { if (w.windowState === w.STATE_MINIMIZED) w.restore(); w.focus(); } return 1;")
    time.sleep(1.5)
    page("document.querySelector('.sidebar .item.parent[aria-label^=\"Inbox\"]')?.click(); await new Promise(r => setTimeout(r, 2500)); return document.visibilityState;")
    before = page("return document.querySelectorAll('[role=\"option\"]').length;")
    result['visible'] = page("return document.visibilityState;")
    t0 = time.time()
    chrome(ADD, [subjects[0], keys[0]])
    found = None
    while time.time() - t0 < 80 and not found:
        time.sleep(2)
        found = page(FIND.replace("const [subject] = arguments;", f"const subject = {json.dumps(subjects[0])};"))
    result['first'] = {'found': found, 'seconds': round(time.time() - t0, 1)}
    t1 = time.time()
    chrome(ADD, [subjects[1], keys[1]])
    found2 = None
    while time.time() - t1 < 200 and not found2:
        time.sleep(2)
        found2 = page(FIND.replace("const [subject] = arguments;", f"const subject = {json.dumps(subjects[1])};"))
    result['second'] = {'found': found2, 'seconds': round(time.time() - t1, 1)}
    after = page("return document.querySelectorAll('[role=\"option\"]').length;")
    result['rows'] = [before, after]
    spark.app_shot(m, str(args.output_dir / 'silent-arrival.png'))
    result['checks'] = {
        'ember_in_front': result['visible'] == 'visible',
        'first_listed_within_75s': bool(found) and result['first']['seconds'] <= 75,
        'second_listed_within_190s': bool(found2) and result['second']['seconds'] <= 190,
        'under_today': bool(found) and 'Today' in (found.get('bucket') or ''),
    }
finally:
    result['removed'] = chrome(REMOVE, [stamp])
    try:
        page("location.reload(); return 1;")
    except Exception:
        pass
    time.sleep(3)
    chrome("for (const w of Services.wm.getEnumerator(null)) { try { w.minimize(); } catch {} } return 1;")

(args.output_dir / 'silent-arrival.json').write_text(json.dumps(result, indent=2, default=str))
print(json.dumps(result, indent=2, default=str))
ok = result.get('checks') and all(result['checks'].values())
print('ALL PASS' if ok else 'FAIL')
raise SystemExit(0 if ok else 1)
