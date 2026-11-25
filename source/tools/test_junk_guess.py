#!/usr/bin/env python3
"""Thunderbird's junk filter guesses stay in the Inbox (1.0.3). A filter trained on spam alone marked every new email
of the user's work inbox junk, and Ember hid them. Isolated fixture profile only (port 2831).

Two emails arrive in the test Inbox (account2), already marked junk when Ember hears of them (as Thunderbird's
filter marks new mail): one as the adaptive filter does (origin "plugin"), the other as the user does (origin
"user"). Checks: the filter's guess is listed with "Spam?"; after a refresh (which lists mail already marked, as
the user's inbox was) the guess is still listed and the user's verdict isn't. Both emails are deleted afterwards.

  test_junk_guess.py --output-dir DIR
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

INBOX = "const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs'); const inbox = MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox');"
stamp = int(time.time())
GUESS, USER = f'Filter guess {stamp}', f'User verdict {stamp}'
ROW = "const row = (s) => [...document.querySelectorAll('[role=\"option\"]')].find((r) => r.textContent.includes(s));"
result = {}
try:
    chrome("for (const w of Services.wm.getEnumerator('mail:extensionPopup')) { if (w.windowState === w.STATE_MINIMIZED) w.restore(); w.focus(); } return 1;")
    page("document.querySelector('.sidebar .item.parent[aria-label^=\"Inbox\"]')?.click(); await new Promise(r => setTimeout(r, 2000)); return 1;")
    # Added and marked in one go: Ember hears of new mail only after this script returns.
    chrome(INBOX + """const [guess, user] = arguments;
const local = inbox.QueryInterface(Ci.nsIMsgLocalMailFolder);
for (const subject of [guess, user]) local.addMessage(`From: Grace Hopper <grace@navy.test>\\r\\nTo: merritt@spark.test\\r\\nSubject: ${subject}\\r\\nDate: ${new Date().toUTCString()}\\r\\nMessage-ID: <${subject.replace(/ /g, '-')}@spark.test>\\r\\nX-Mozilla-Status: 0000\\r\\n\\r\\nHello.\\r\\n`);
const hdrs = [...inbox.msgDatabase.enumerateMessages()];
inbox.setJunkScoreForMessages(hdrs.filter((h) => h.subject === guess), '100', 'plugin', -1);
inbox.setJunkScoreForMessages(hdrs.filter((h) => h.subject === user), '100', 'user', -1);
return 1;""", [GUESS, USER])
    after = page(ROW + f"""for (let i = 0; i < 60; i++) {{ await new Promise(r => setTimeout(r, 250)); if (row({json.dumps(GUESS)})?.querySelector('.sig.spam')) break; }}
await new Promise(r => setTimeout(r, 2000));
const g = row({json.dumps(GUESS)});
return {{ guessListed: !!g, guessAsks: !!g?.querySelector('.sig.spam'), userListed: !!row({json.dumps(USER)}) }};""")
    refreshed = page(ROW + f"""(document.querySelector('[aria-label="Refresh"]') || document.querySelector('[title^="Refresh"]'))?.click();
for (let i = 0; i < 40; i++) {{ await new Promise(r => setTimeout(r, 250)); if (!row({json.dumps(USER)}) && row({json.dumps(GUESS)})?.querySelector('.sig.spam')) break; }}
const g = row({json.dumps(GUESS)});
return {{ guessListed: !!g, guessAsks: !!g?.querySelector('.sig.spam'), userListed: !!row({json.dumps(USER)}) }};""")
    spark.app_shot(m, str(args.output_dir / 'junk-guess.png'))
    result = {'after': after, 'refreshed': refreshed}
    result['checks'] = {
        'filter_guess_stays': after['guessListed'],
        'filter_guess_asks_spam': after['guessAsks'],
        'after_refresh_guess_stays': refreshed['guessListed'] and refreshed['guessAsks'],
        'after_refresh_user_verdict_hidden': not refreshed['userListed'],
    }
finally:
    result['removed'] = chrome(INBOX + """const [subjects] = arguments;
const gone = [...inbox.msgDatabase.enumerateMessages()].filter((h) => subjects.includes(h.subject));
if (gone.length) inbox.deleteMessages(gone, null, true, false, null, false);
return gone.length;""", [[GUESS, USER]])
    chrome("for (const w of Services.wm.getEnumerator(null)) { try { w.minimize(); } catch {} } return 1;")

(args.output_dir / 'junk-guess.json').write_text(json.dumps(result, indent=2, default=str))
print(json.dumps(result, indent=2, default=str))
ok = result.get('checks') and all(result['checks'].values())
print('ALL PASS' if ok else 'FAIL')
raise SystemExit(0 if ok else 1)
