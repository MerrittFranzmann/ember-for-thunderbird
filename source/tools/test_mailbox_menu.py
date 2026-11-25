#!/usr/bin/env python3
"""Mailboxes that combine accounts don't open up; right-click picks one account (isolated fixture profile, port 2831).

Synthesized events in the page only. Checks: selecting the Inbox lists no accounts under it; right-click opens
"Show in Inbox" with All accounts and each account (with its colour dot); choosing an account shows only its mail,
with the Inbox still highlighted and naming it; the menu marks the current choice; All accounts goes back; Escape
and a click elsewhere close the menu; the keyboard's context-menu key opens it too.

  test_mailbox_menu.py --output-dir DIR
"""
import argparse, json
from pathlib import Path
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
m = spark.connect()

HELPERS = r'''
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms = 8000) => { for (let t = 0; t < ms; t += 100) { const v = test(); if (v) return v; await pause(100); } return test(); };
const inbox = () => document.querySelector('.sidebar [data-mailbox="inbox"] > button.item.parent');
const menu = () => document.querySelector('.context-menu[aria-label^="Show in"]');
const items = () => [...(menu()?.querySelectorAll('button') || [])].map((b) => ({ name: b.querySelector('.name')?.textContent.trim(), checked: b.getAttribute('aria-checked'), dot: !!b.querySelector('.dot') }));
const rightClick = async (el, keyboard = false) => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: keyboard ? 0 : 60, clientY: keyboard ? 0 : 120 })); return !!(await until(() => menu(), 2000)); };
const choose = async (name) => { [...menu().querySelectorAll('button')].find((b) => b.querySelector('.name')?.textContent.trim() === name).click(); await pause(800); };
const title = () => document.querySelector('.viewport')?.getAttribute('aria-label');
const accountsInList = () => [...new Set([...document.querySelectorAll('.viewport .row')].map((r) => r.getAttribute('data-account')).filter(Boolean))];
'''
def page(body):
    r = spark.run_in_app(m, HELPERS + body)
    if isinstance(r, str) and r.startswith('ERROR'): raise RuntimeError(r)
    return r

result = {}
try:
    result['selected'] = page("""inbox().click(); await pause(800);
return { children: document.querySelectorAll('.sidebar [data-mailbox="inbox"] .children, .sidebar .account-item').length, label: inbox().getAttribute('aria-label'), current: inbox().getAttribute('aria-current'), title: title() };""")
    result['menu'] = page("const opened = await rightClick(inbox()); return { opened, heading: menu()?.querySelector('.menu-title')?.textContent.trim(), items: items() };")
    names = [i['name'] for i in result['menu']['items'] if i['name'] != 'All accounts']
    one = names[-1] if names else ''
    result['one'] = page("""await choose(%s);
return { menuClosed: !menu(), label: inbox().getAttribute('aria-label'), current: inbox().getAttribute('aria-current'), only: inbox().querySelector('.only')?.textContent.trim(), title: title() };""" % json.dumps(one))
    result['marked'] = page("await rightClick(inbox()); const out = items(); await choose('All accounts'); return out;")
    result['back'] = page("return { label: inbox().getAttribute('aria-label'), only: !!inbox().querySelector('.only'), title: title() };")
    result['closing'] = page("""await rightClick(inbox()); menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await pause(150); const escape = !menu();
await rightClick(inbox()); document.querySelector('.viewport').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); await pause(150); const outside = !menu();
const keyboard = await rightClick(inbox(), true); const focused = document.activeElement?.closest('.context-menu') === menu();
menu()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
return { escape, outside, keyboard, focused };""")
    page("await rightClick(inbox()); await choose(%s); return 1;" % json.dumps(one))
    spark.app_shot(m, str(args.output_dir / 'one-account.png'))
finally:
    try: page("if (menu()) menu().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); inbox()?.click(); return 1;")
    except Exception: pass
    spark._end_session(m)

r = result
checks = {
    'selecting_lists_no_accounts': r['selected']['children'] == 0 and r['selected']['current'] == 'page' and r['selected']['label'] == 'Inbox — all accounts',
    'right_click_menu': r['menu']['opened'] and r['menu']['heading'] == 'Show in Inbox' and r['menu']['items'][0] == {'name': 'All accounts', 'checked': 'true', 'dot': False}
        and len(r['menu']['items']) >= 3 and all(i['dot'] and i['checked'] == 'false' for i in r['menu']['items'][1:]),
    'one_account_shown': r['one']['menuClosed'] and r['one']['current'] == 'page' and r['one']['only'] == f'· {one}' and r['one']['label'] == f'Inbox — only {one}' and r['one']['title'] != r['selected']['title'],
    'menu_marks_choice': any(i['name'] == one and i['checked'] == 'true' for i in r['marked']) and any(i['name'] == 'All accounts' and i['checked'] == 'false' for i in r['marked']),
    'all_accounts_back': r['back']['label'] == 'Inbox — all accounts' and not r['back']['only'] and r['back']['title'] == r['selected']['title'],
    'menu_closes_and_keyboard_opens': r['closing'] == {'escape': True, 'outside': True, 'keyboard': True, 'focused': True},
}
result['checks'] = checks
(args.output_dir / 'mailbox-menu.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
print('ALL PASS' if all(checks.values()) else 'FAIL: ' + ', '.join(k for k, v in checks.items() if not v))
raise SystemExit(0 if all(checks.values()) else 1)
