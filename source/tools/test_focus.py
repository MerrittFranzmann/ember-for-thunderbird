#!/usr/bin/env python3
"""Focus (quiet hours, work mail by network) in the real Ember, isolated fixture profile only (port 2831).
A stand-in alerts service records notifications instead of showing them; new mail is added to the fixture
"Work (test)" Inbox locally (nothing is fetched or sent).

  1. The network: sparkFocus.network() gives the same key twice.
  2. Work mail hidden: "Work (test)" as a work account, shown only on work networks, none saved: the
     background hides it (focusState), Thunderbird's own alerts go off, the sidebar drops the account and says
     so, and the Smart Inbox shrinks.
  3. Quiet hours ("All the time", Grace let through): a shop email arrives silently; Grace's notifies (and
     shows in the Smart Inbox though her account is hidden).
  4. This network added as a work network (Settings window, Focus): work mail shows again.
  5. Settings put back: Thunderbird's alerts are on again.

  test_focus.py --output-dir DIR
"""
import argparse, json, time
from pathlib import Path
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
m = spark.connect()
FOCUS_KEYS = ['workDays', 'workStart', 'workEnd', 'quietHours', 'letThroughPeople', 'letThroughSubjects', 'workAccounts', 'workNetworks', 'workMailRule', 'focusOverride', 'showAllInboxes', 'lastInbox']


def app(js):
    r = spark.run_in_app(m, js)
    if isinstance(r, str) and r.startswith('ERROR'): raise RuntimeError(r)
    return r


def wait(js, label, seconds=25):
    end = time.time() + seconds
    while time.time() < end:
        v = app(js)
        if v: return v
        time.sleep(0.4)
    raise TimeoutError(label)


def arrive(sender, subject):
    m.execute("""const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const f=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder);
const id='focus-'+Date.now()+'-'+Math.random().toString(36).slice(2);
f.addMessage('From: %s\\r\\nTo: merritt@spark.test\\r\\nSubject: %s\\r\\nDate: '+new Date().toUTCString()+'\\r\\nMessage-ID: <'+id+'@spark.test>\\r\\nX-Mozilla-Status: 0000\\r\\n\\r\\nFocus test.\\r\\n'); return 1;""" % (sender, subject))


def alerts():
    return m.execute("return window.__focusAlerts.map(a => ({ title: a.title, text: a.text, name: a.name }));")


def pref(name):
    return m.execute("return Services.prefs.getBoolPref(%s, true);" % json.dumps(name))


m.execute("""
const registrar=Components.manager.QueryInterface(Ci.nsIComponentRegistrar);const contract='@mozilla.org/alerts-service;1';
window.__focusAlerts=[]; window.__focusOrigCID=registrar.contractIDToCID(contract);
window.__focusCID=Components.ID('{'+Services.uuid.generateUUID().toString().slice(1,-1)+'}');
const fake={showAlert(alert,listener){window.__focusAlerts.push({title:alert.title,text:alert.text,name:alert.name});},showAlertNotification(){},closeAlert(){},QueryInterface:ChromeUtils.generateQI(['nsIAlertsService'])};
window.__focusFactory={createInstance(iid){return fake.QueryInterface(iid);},QueryInterface:ChromeUtils.generateQI(['nsIFactory'])};
registrar.registerFactory(window.__focusCID,'Focus test alerts',contract,window.__focusFactory); return 1;""")
before = app("return await messenger.storage.local.get(%s);" % json.dumps(FOCUS_KEYS))
result = {}
try:
    net = app("const a = await messenger.sparkFocus.network(); const b = await messenger.sparkFocus.network(); return { a, same: a.key === b.key };")
    assert net['same'] and net['a']['key'], net
    result['network'] = net['a']
    app("document.querySelector('.sidebar .item')?.click(); await new Promise((r) => setTimeout(r, 1500)); return true;")
    shown = wait("const n = document.querySelector('.list-head .n')?.textContent.replace(/[^0-9]/g, ''); return n ? +n : 0;", 'inbox count')

    # 2. Work mail hidden (no work networks yet, work mail only on them), 3. quiet hours with Grace let through.
    # A work account splits the inbox into Work and Personal (Local Folders); Focus hides work mail from the inbox of
    # every account ("All inboxes", turned on here) and dims Work.
    app("""await messenger.storage.local.set({ workAccounts: ['account2'], showAllInboxes: true, workMailRule: 'network', workNetworks: [], quietHours: 'always', letThroughPeople: ['grace@navy.test'], letThroughSubjects: [], focusOverride: null }); return true;""")
    state = wait("const s = (await messenger.storage.local.get('focusState')).focusState; return s && s.hiddenAccounts.includes('account2') && s.quiet ? s : null;", 'focus state')
    wait("const b = document.querySelector('.sidebar [data-mailbox=\"inbox\"] > button.item.parent'); if (!b) return false; b.click(); await new Promise((r) => setTimeout(r, 1200)); return true;", 'All inboxes')
    assert pref('mail.biff.show_alert') is False and pref('mail.biff.play_sound') is False, 'Thunderbird alerts still on'
    side = wait("""const note = document.querySelector('.sidebar [data-mailbox="inbox"] .hidden-note')?.textContent; const work = document.querySelector('.sidebar [data-mailbox="inbox-work"] .hidden-note')?.textContent; // Its accounts: from its right-click menu (none when only one account is left).
const box = document.querySelector('.sidebar [data-mailbox="inbox"] > button.item.parent');
box?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 120 })); await new Promise((r) => setTimeout(r, 200));
const accounts = [...document.querySelectorAll('.context-menu[aria-label^="Show in"] .name')].map((l) => l.textContent.trim()).filter((t) => t !== 'All accounts');
document.querySelector('.context-menu[aria-label^="Show in"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
const n = +(document.querySelector('.list-head .n')?.textContent.replace(/[^0-9]/g, '') || 0); return note ? { note, work, accounts, count: n } : null;""", 'sidebar note')
    assert side['note'] == '1 work account hidden' and side['work'] == 'Hidden by Focus' and not any('spark.test' in a or 'Work' in a for a in side['accounts']), side
    assert side['count'] < shown, (side, shown)
    result['hidden'] = {'state': {k: state[k] for k in ('quiet', 'hiddenAccounts', 'onWorkNetwork', 'inWorkHours')}, 'smartInbox': {'before': shown, 'after': side['count']}, 'sidebar': side}

    m.execute("window.__focusAlerts = []; return 1;")
    arrive('Shop <news@shop.test>', 'Focus sale %d' % time.time())
    time.sleep(4)
    assert alerts() == [], alerts()
    arrive('Grace Hopper <grace@navy.test>', 'Focus from Grace %d' % time.time())
    end = time.time() + 15
    while time.time() < end and not alerts(): time.sleep(0.4)
    got = alerts()
    assert len(got) == 1 and got[0]['title'] == 'Grace Hopper' and got[0]['text'].startswith('Focus from Grace'), got
    time.sleep(1.5)
    assert len(alerts()) == 1, alerts()
    graceShown = wait("return [...document.querySelectorAll('.row .subject')].some((s) => s.textContent.startsWith('Focus from Grace'));", 'let-through mail in the Smart Inbox')
    shopHidden = app("return ![...document.querySelectorAll('.row .subject')].some((s) => s.textContent.startsWith('Focus sale'));")
    assert shopHidden, 'hidden work mail shows'
    result['quiet'] = {'alerts': got, 'letThroughShown': graceShown, 'shopHidden': shopHidden}

    # 4. This network as a work network, from the Settings window.
    app("await messenger.runtime.sendMessage({ type: 'spark:settings', section: 'focus' }); return true;")
    FIND = "const __s = () => { for (const w of Services.wm.getEnumerator('mail:extensionPopup')) { const b = w.document.querySelector('browser'); if (b?.currentURI?.spec.includes('/settings.html')) return { w, b }; } return null; };"
    def in_settings(body):
        js = FIND + """const s = __s(); if (!s) return 'ERROR: no settings window'; s.b.browsingContext.isActive = true;
const r = await s.b.browsingContext.currentWindowGlobal.getActor('MarionetteCommands').executeScript('return (async () => {' + %s + '\\n})().then(v => JSON.stringify(v === undefined ? null : v), e => JSON.stringify("ERROR: " + e));', [], {timeout: 30000}); return JSON.parse(r);""" % json.dumps(body)
        r = spark.chrome_async(m, js)
        if isinstance(r, str) and r.startswith('ERROR'): raise RuntimeError(r)
        return r
    end = time.time() + 20
    while True:
        try:
            if in_settings("return document.querySelector('.pane h1')?.textContent === 'Focus' && !!document.querySelector('input[aria-label=\"Name for this network\"]');"): break
        except RuntimeError: pass
        if time.time() > end: raise TimeoutError('settings window at Focus')
        time.sleep(0.4)
    (args.output_dir / 'focus-settings.png').write_bytes(__import__('base64').b64decode(spark.chrome_async(m, FIND + """const s = __s(); const bmp = await s.b.browsingContext.currentWindowGlobal.drawSnapshot(new DOMRect(0, 0, s.b.clientWidth, s.b.clientHeight * 2), 2, 'white');
const c = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas'); c.width = bmp.width; c.height = bmp.height; c.getContext('2d').drawImage(bmp, 0, 0); return c.toDataURL('image/png').split(',')[1];""")))
    in_settings("""const input = document.querySelector('input[aria-label="Name for this network"]'); input.value = 'Office (test)'; input.dispatchEvent(new Event('input', { bubbles: true }));
await new Promise((r) => setTimeout(r, 100)); [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add as work network').click(); return true;""")
    state = wait("const s = (await messenger.storage.local.get('focusState')).focusState; return s && s.onWorkNetwork && !s.hiddenAccounts.length ? s : null;", 'work network')
    wait("return !document.querySelector('.sidebar .hidden-note');", 'sidebar shows work account again')
    count = wait("const n = +(document.querySelector('.list-head .n')?.textContent.replace(/[^0-9]/g, '') || 0); return n;", 'count')
    assert state['network']['name'] == 'Office (test)', state
    result['work_network'] = {'name': state['network']['name'], 'smartInbox': count}
    spark.chrome_async(m, FIND + "__s()?.w.close(); return true;")
finally:
    app("await messenger.storage.local.set(%s); return true;" % json.dumps({k: before.get(k, v) for k, v in {'workDays': [1, 2, 3, 4, 5], 'workStart': '09:00', 'workEnd': '17:00', 'quietHours': 'off', 'letThroughPeople': [], 'letThroughSubjects': [], 'workAccounts': [], 'workNetworks': [], 'workMailRule': 'networkOrHours', 'focusOverride': None, 'showAllInboxes': False, 'lastInbox': ''}.items()}))
    time.sleep(2)
    restored = {'show_alert': pref('mail.biff.show_alert'), 'saved_left': m.execute("return Services.prefs.prefHasUserValue('extensions.spark.focus.savedAlerts');")}
    m.execute("const registrar=Components.manager.QueryInterface(Ci.nsIComponentRegistrar); registrar.registerFactory(window.__focusOrigCID,'','@mozilla.org/alerts-service;1',null); try{registrar.unregisterFactory(window.__focusCID,window.__focusFactory);}catch(e){} return 1;")
    result['restored'] = restored
    print(json.dumps(result, indent=2))
assert restored['show_alert'] is True and restored['saved_left'] is False, restored
(args.output_dir / 'focus.json').write_text(json.dumps(result, indent=2) + '\n')
print('PASS')
