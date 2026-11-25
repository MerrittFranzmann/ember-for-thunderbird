#!/usr/bin/env python3
"""Is the test Thunderbird (port 2831) ready for Ember's live feature tests? Checks what they rely on and
reports every problem at once, instead of tests failing later for reasons outside Ember's code:

- the add-on installed is the build being tested (thunderbird-spark-<public/manifest.json version>.xpi);
- the seeded fixtures are there (tools/seed_feature_fixtures.py, seed_long_thread.py, seed_cache_fixtures.py) and
  the profile's own mail (Bank of Example) from tools/setup_test_profile.sh;
- the agent socket is a test path, never the real Ember's (~/Library/Application Support/Ember);
- Ember's window isn't the small hidden-window size (lists would render a few rows);
- Ember's saved-mail cache is complete (after a fresh install it refills for a while, and lists are partial).

  check_fixtures.py          exit 0 when ready; else the problems, and tools/prepare_test_profile.sh fixes most
"""
import json, sys
from pathlib import Path
import spark, suite

ROOT = Path(__file__).resolve().parent.parent
want = json.loads((ROOT / 'public' / 'manifest.json').read_text())['version']
FIXTURES = {  # Message-ID → folder it must be in (account2, the local fixture account)
    'history-root@spark-smoke.test': 'Inbox', 'history-latest@spark-smoke.test': 'Inbox', 'history-reply@spark-smoke.test': 'Sent',
    'invitation@spark-smoke.test': 'Inbox', 'outlook-invitation@spark-smoke.test': 'Inbox', 'old-pin@spark-smoke.test': 'Inbox',
}

m = spark.connect()
problems = []
try:
    state = m.execute('''const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const root=MailServices.accounts.getAccount('account2')?.incomingServer.rootFolder;
if(!root) return {noAccount:true};
const found={}; let longThread=0, bank=0;
for(const name of ['Inbox','Sent']){ const f=root.getChildNamed(name); let db; try{db=f.msgDatabase;}catch(e){found[name+'!']=String(e);continue;}
  for(const mid of %s) if(db.getMsgHdrForMessageID(mid)) found[mid]=name;
  if(name==='Inbox') for(const h of db.enumerateMessages()){ if(h.subject.startsWith('Long thread: venue planning')) longThread++; if(h.author.includes('Bank of Example')) bank++; } }
const popup=[...Services.wm.getEnumerator('mail:extensionPopup')].find(w=>w.document.querySelector('browser')?.currentURI?.spec.endsWith('/app.html'));
return {found, longThread, bank, socket:Services.prefs.getStringPref('extensions.spark.agentSocket',''), linkPort:Services.prefs.getIntPref('extensions.spark.mailLinkPort',47391), feed:Services.prefs.getStringPref('extensions.spark.updateFeed',''), window: popup ? [popup.outerWidth, popup.outerHeight] : null};''' % json.dumps(list(FIXTURES)))
    if state.get('noAccount'):
        problems.append('no fixture account (account2): rebuild with tools/setup_test_profile.sh')
    else:
        for mid, folder in FIXTURES.items():
            if state['found'].get(mid) != folder: problems.append(f'fixture {mid} missing from {folder}')
        for key, error in state['found'].items():
            if key.endswith('!'): problems.append(f'{key[:-1]} folder database won\'t open ({error}): run slim/reparse.py')
        if state['longThread'] < 60: problems.append(f'long thread has {state["longThread"]} of 60 messages')
        if not state['bank']: problems.append('no Bank of Example mail (the profile\'s own mail): rebuild with tools/setup_test_profile.sh')
    if not state.get('socket') or 'Application Support/Ember' in state['socket']:
        problems.append('extensions.spark.agentSocket isn\'t a test path: the test Ember would use the real Ember\'s agent socket')
    if state.get('feed') != 'off':
        problems.append('extensions.spark.updateFeed isn\'t "off": the test Ember would check (and install) Ember\'s public releases')
    if state.get('linkPort') == 47391:
        problems.append('extensions.spark.mailLinkPort isn\'t set: the test Ember would take the real Ember\'s link port')
    if state.get('window') and state['window'][0] <= 240 and state['window'][1] <= 180:
        problems.append(f'Ember\'s window is {state["window"][0]}x{state["window"][1]} (lists would render a few rows)')
    try:
        have = spark.run_in_app(m, 'return messenger.runtime.getManifest().version;')
    except Exception as error:
        have = f'not open ({error})'
    cache = spark.run_in_app(m, 'return (await messenger.storage.local.get("cacheStatus")).cacheStatus || null;') if have == want else None
    if have == want and not (cache and cache.get('phase') == 'ready' and cache.get('done') == cache.get('total')):
        problems.append('Ember\'s saved-mail cache is still filling (%s): wait until it\'s ready' % (f"{cache.get('phase')} {cache.get('done')}/{cache.get('total')}" if cache else 'not started'))
    if have != want: problems.append(f'Ember {have} is installed, testing {want}: npm run package, then tools/prepare_test_profile.sh')
    else:
        xpi = ROOT / f'thunderbird-spark-{want}.xpi'
        if not xpi.exists(): problems.append(f'{xpi.name} missing: npm run package')
        elif suite.installed() != suite.build_id(xpi): problems.append(f'the Ember {want} installed is an older build than {xpi.name}: tools/prepare_test_profile.sh')
finally:
    spark._end_session(m)

if problems:
    print('Test profile not ready:')
    for p in problems: print('  - ' + p)
    print('Most are fixed by tools/prepare_test_profile.sh')
    sys.exit(1)
print(f'Test profile ready (Ember {want})')
