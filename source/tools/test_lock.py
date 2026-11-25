#!/usr/bin/env python3
"""Lock with Touch ID, in the isolated fixture profile only (port 2831). macOS is never asked: the lock Experiment's
test pref (honoured only while Marionette runs) answers "pass" or "fail" in place of Touch ID. Checks: turning the
lock on/off in Settings → Lock asks first (a "fail" leaves it as it was), ⌘L covers Ember (the mail underneath
inert, no switching to Thunderbird's window), a failed unlock stays locked, Unlock unlocks, the Mac sleeping locks
and waking on a trusted network unlocks by itself, being away doesn't lock on a trusted network but does elsewhere,
and the Settings window is covered too. Puts every setting back.

  test_lock.py --output-dir DIR
"""
import argparse, json, time
from pathlib import Path
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
m = spark.connect()

KEYS = ['lockEnabled', 'lockAfter', 'lockOnSleep', 'lockOnStart', 'lockTrustedNetworks']
saved = spark.run_in_app(m, "return await messenger.storage.local.get(%s);" % json.dumps(KEYS))

def auth(answer):
    m.execute("Services.prefs.setStringPref('extensions.spark.lock.testAuth', %s); return 1;" % json.dumps(answer))

def notify(topic, data=None):
    m.execute("Services.obs.notifyObservers(null, %s, %s); return 1;" % (json.dumps(topic), json.dumps(data)))

def pref_state():
    return json.loads(m.execute("return Services.prefs.getStringPref('extensions.spark.lock.state', '{}');") or '{}')

HELPERS = r'''
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms = 15000) => { for (let t = 0; t < ms; t += 150) { const v = test(); if (v) return v; await pause(150); } return test(); };
const cover = () => document.querySelector('.lock[role="dialog"]');
const covered = () => !!cover() && [...cover().parentElement.children].filter((el) => el !== cover()).every((el) => el.inert);
const uncovered = () => !document.querySelector('.lock') && ![...document.getElementById('app').children].some((el) => el.inert);
const state = () => messenger.sparkLock.state();
'''

def page(body):
    r = spark.run_in_app(m, HELPERS + body)
    if isinstance(r, str) and r.startswith('ERROR'): raise RuntimeError(r)
    return r

def settings(body):
    return spark.in_settings(m, HELPERS + spark.SETTING_ITEM + body)

result = {}
try:
    auth('pass')
    page("await messenger.storage.local.set({ lockEnabled: false, lockAfter: 15, lockOnSleep: true, lockOnStart: true, lockTrustedNetworks: [] }); await pause(800); return 1;")

    # Settings → Lock: turning it on asks first; a "fail" leaves it off, a "pass" turns it on.
    spark.open_settings(m, 'security', 'Lock Ember with Touch ID')
    auth('fail')
    result['settings_fail'] = settings(r'''
const box = () => item('Lock Ember with Touch ID').querySelector('input[type=checkbox]');
box().click(); await pause(1200);
return { checked: box().checked, saved: (await messenger.storage.local.get('lockEnabled')).lockEnabled };''')
    auth('pass')
    result['settings_pass'] = settings(r'''
const box = () => item('Lock Ember with Touch ID').querySelector('input[type=checkbox]');
box().click(); await until(async () => (await messenger.storage.local.get('lockEnabled')).lockEnabled, 5000); await pause(800);
const s = await state();
return { checked: box().checked, enabled: s.config.enabled, available: s.available, sections: [...document.querySelectorAll('.side li button')].map((b) => b.textContent.trim()),
  items: [...document.querySelectorAll('.card .item b')].map((b) => b.textContent.trim()), lockButton: !!item('Lock now')?.querySelector('button:not([disabled])') };''')
    spark.close_settings(m)

    # ⌘L locks: the cover, the mail underneath inert, the reason, the saved state; no switch to Thunderbird.
    result['manual'] = page(r'''
await until(() => document.querySelector('.sidebar button[aria-label="Lock Ember"]'), 5000);
const button = !!document.querySelector('.sidebar button[aria-label="Lock Ember"]');
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true, cancelable: true }));
await until(() => cover());
const before = await messenger.sparkWindow?.state().catch(() => null);
await messenger.runtime.sendMessage({ type: 'spark:toggle' }).catch(() => {});
await pause(1500);
const after = await messenger.sparkWindow?.state().catch(() => null);
return { button, covered: covered(), text: cover()?.querySelector('.why')?.textContent.trim(), reason: (await state()).reason,
  thunderbirdStaysHidden: !before || after?.mainVisible === before.mainVisible };''')
    result['manual_pref'] = pref_state()

    # A failed unlock stays locked (and says so); a passing one unlocks.
    auth('fail')
    result['unlock_fail'] = page(r'''
cover().querySelector('.unlock').click(); await pause(1200);
return { covered: covered(), hint: cover()?.querySelector('.hint')?.textContent.trim(), locked: (await state()).locked };''')
    auth('pass')
    result['unlock_pass'] = page(r'''
cover().querySelector('.unlock').click();
return { uncovered: !!(await until(() => uncovered(), 5000)), locked: (await state()).locked };''')
    result['unlock_pref'] = pref_state()

    # Trust this network (as Settings → Lock's "Don't lock here" does), then sleep → locked; wake → unlocks itself.
    here = page("await messenger.runtime.sendMessage({ type: 'spark:focus' }); return (await messenger.storage.local.get('focusState')).focusState?.network?.key || null;")
    result['network_key'] = bool(here)
    page("await messenger.storage.local.set({ lockTrustedNetworks: [{ key: %s, name: 'Test home' }] }); await pause(1500); return 1;" % json.dumps(here))
    notify('sleep_notification')
    result['sleep'] = page("await until(() => cover(), 5000); return { covered: covered(), reason: (await state()).reason, text: cover()?.querySelector('.why')?.textContent.trim() };")
    notify('wake_notification')
    result['wake_trusted'] = page("return { uncovered: !!(await until(() => uncovered(), 15000)), locked: (await state()).locked };")

    # Away on a trusted network: no lock. Away elsewhere: locked.
    notify('spark-lock:test', 'away')
    result['away_trusted'] = page("await pause(1200); return { locked: (await state()).locked, uncovered: uncovered() };")
    page("await messenger.storage.local.set({ lockTrustedNetworks: [] }); await pause(1500); return 1;")
    notify('spark-lock:test', 'away')
    result['away'] = page("await until(() => cover(), 5000); return { covered: covered(), reason: (await state()).reason, text: cover()?.querySelector('.why')?.textContent.trim() };")
    spark.app_shot(m, args.output_dir / 'locked.png')
    # Waking up elsewhere doesn't unlock a lock from being away.
    notify('wake_notification')
    result['wake_untrusted'] = page("await pause(3000); return { locked: (await state()).locked };")

    # The Settings window is covered too, and unlocking there unlocks Ember.
    page("await messenger.runtime.sendMessage({ type: 'spark:settings', section: 'security' }); return 1;")
    for _ in range(60):
        try:
            if spark.in_settings(m, "return !!document.querySelector('.lock');") is True: break
        except RuntimeError: pass
        time.sleep(0.3)
    result['settings_covered'] = settings("await until(() => cover(), 5000); return { covered: covered(), searchHidden: document.querySelector('.search input')?.closest('[inert]') !== null };")
    result['settings_unlock'] = settings("cover().querySelector('.unlock').click(); return { uncovered: !!(await until(() => !document.querySelector('.lock'), 5000)) };")
    result['app_after_settings_unlock'] = page("return { uncovered: !!(await until(() => uncovered(), 5000)) };")
    spark.close_settings(m)
finally:
    try:
        page("await messenger.storage.local.set(%s); await pause(800); return 1;" % json.dumps({k: saved.get(k, d) for k, d in [('lockEnabled', False), ('lockAfter', 15), ('lockOnSleep', True), ('lockOnStart', True), ('lockTrustedNetworks', [])]}))
    finally:
        m.execute("Services.prefs.clearUserPref('extensions.spark.lock.testAuth'); return 1;")
        spark._end_session(m)

r = result
checks = {
    'settings_asks_before_turning_on': r.get('settings_fail') == {'checked': False, 'saved': False} and r.get('settings_pass', {}).get('checked') is True and r['settings_pass'].get('enabled') is True,
    'settings_section': 'Security' in r.get('settings_pass', {}).get('sections', []) and r.get('settings_pass', {}).get('items', [])[:1] == ['Lock Ember with Touch ID'] and r['settings_pass'].get('lockButton') is True,
    'cmd_l_covers': r.get('manual', {}).get('button') is True and r['manual'].get('covered') is True and r['manual'].get('reason') == 'manual',
    'no_switch_while_locked': r.get('manual', {}).get('thunderbirdStaysHidden') is True,
    'state_kept_in_pref': r.get('manual_pref', {}).get('locked') is True and r.get('unlock_pref', {}).get('locked') is False,
    'failed_unlock_stays_locked': r.get('unlock_fail', {}).get('covered') is True and r['unlock_fail'].get('locked') is True and 'Not unlocked' in (r['unlock_fail'].get('hint') or ''),
    'unlock': r.get('unlock_pass') == {'uncovered': True, 'locked': False},
    'sleep_locks': r.get('sleep', {}).get('covered') is True and r['sleep'].get('reason') == 'sleep' and 'sleep' in (r['sleep'].get('text') or ''),
    'wake_on_trusted_unlocks': r.get('network_key') is True and r.get('wake_trusted') == {'uncovered': True, 'locked': False},
    'away_trusted_no_lock': r.get('away_trusted') == {'locked': False, 'uncovered': True},
    'away_locks': r.get('away', {}).get('covered') is True and r['away'].get('reason') == 'away' and '15 minutes away' in (r['away'].get('text') or ''),
    'wake_elsewhere_stays_locked': r.get('wake_untrusted') == {'locked': True},
    'settings_window_covered': r.get('settings_covered', {}).get('covered') is True and r['settings_covered'].get('searchHidden') is True,
    'unlock_from_settings': r.get('settings_unlock') == {'uncovered': True} and r.get('app_after_settings_unlock') == {'uncovered': True},
}
result['checks'] = checks
(args.output_dir / 'lock.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
print('ALL PASS' if all(checks.values()) else 'FAIL: ' + ', '.join(k for k, v in checks.items() if not v))
raise SystemExit(0 if all(checks.values()) else 1)
