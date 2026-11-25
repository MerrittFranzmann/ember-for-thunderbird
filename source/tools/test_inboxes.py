#!/usr/bin/env python3
"""Work and Personal inboxes, and picking several conversations, in the isolated fixture profile only (port 2831).
Seeds a few personal emails into Local Folders' Inbox and work ones into the fixture account's, makes the fixture
account a work account (Settings' list), and checks: the sidebar's Work and Personal, each inbox's own tabs and where
mail lands by the rules (no AI), a sender rule from an email's Details, renaming a group in Settings → Inboxes, then
⌘-click / Shift-click / ⌘A picking and a bulk Archive with Undo. Puts every setting back.

  test_inboxes.py --output-dir DIR
"""
import argparse, json, time
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import format_datetime
from pathlib import Path
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)
m = spark.connect()

RUN = str(int(time.time()))
def mail(mid, author, subject, body, age, headers=()):
    e = EmailMessage(policy=SMTP)
    e['From'] = author; e['To'] = 'Merritt Franzmann <merritt@spark.test>'
    # Seconds old, in the seeds' order: newer than other tests' fixtures, so in the rows an occluded window draws.
    e['Date'] = format_datetime(datetime.now(timezone.utc) - timedelta(seconds=age))
    # A new Message-ID each run: Ember's saved mail remembers deleted emails by it, so a re-added copy of the same
    # email could stay out of the list until the next full refresh.
    e['Message-ID'] = f'<{mid}-{RUN}@spark-inboxes.test>'; e['Subject'] = subject; e['X-Mozilla-Status'] = '0000'
    for k, v in headers: e[k] = v
    e.set_content(body)
    return e

LIST = (('List-Id', '<news.example>'), ('List-Unsubscribe', '<mailto:leave@news.example>'), ('Precedence', 'bulk'))
SEEDS = [
    ('account1', mail('friend', 'Sam Rivera <sam@friends.example>', 'Dinner Saturday?', 'Are you free for dinner on Saturday?', 30)),
    ('account1', mail('order', 'Shop <orders@shop.example>', 'Your order has shipped', 'Your package is on its way.', 40, (('Auto-Submitted', 'auto-generated'),))),
    ('account1', mail('promo', 'Brand Deals <deals@brand.example>', '40% off everything this weekend', 'Big sale.', 50, LIST)),
    ('account1', mail('letter', 'The Weekly <hello@weekly.example>', 'This week in reading', 'Essays and links.', 60, LIST)),
    ('account2', mail('colleague', 'Grace Hopper <grace@spark.test>', 'Team offsite agenda', 'Here is the agenda for the offsite.', 35)),
    ('account2', mail('bulk-a', 'Tom Vendor <tom@vendor.example>', 'Inboxes bulk test A', 'First.', 45)),
    ('account2', mail('bulk-b', 'Tom Vendor <tom@vendor.example>', 'Inboxes bulk test B', 'Second.', 46)),
]
for account, e in SEEDS:
    m.execute('''const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const folder = MailServices.accounts.getAccount(%s).incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder);
const prefix = %s;
// Fresh each run: earlier runs' copies would sink below newer fixture mail, out of the rows the list draws.
const old = [...folder.msgDatabase.enumerateMessages()].filter((h) => h.messageId.startsWith(prefix) && h.messageId.endsWith('@spark-inboxes.test'));
if (old.length) folder.deleteMessages(old, null, true, false, null, false);
folder.addMessage(%s);
return 1;''' % (json.dumps(account), json.dumps(str(e['Message-ID']).strip('<>').rsplit('-', 1)[0] + '-'), json.dumps(e.as_string())))

saved = spark.run_in_app(m, "return await messenger.storage.local.get(['workAccounts', 'inboxGroups', 'senderGroups', 'showAllInboxes', 'lastInbox']);")

def reload_page():
    spark.run_in_app(m, "setTimeout(() => location.reload(), 50); return 1;")
    time.sleep(3)
    for _ in range(120):
        try:
            if spark.run_in_app(m, "return !!document.querySelector('.sidebar .item') && !document.querySelector('.mini-spin');"): return
        except Exception: pass
        time.sleep(0.5)

HELPERS = r'''
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (test, ms = 15000) => { for (let t = 0; t < ms; t += 150) { const v = test(); if (v) return v; await pause(150); } return test(); };
const sidebar = (key) => document.querySelector(`.sidebar [data-mailbox="${key}"] > button.item.parent`);
const tabs = () => [...document.querySelectorAll('.inbox-categories .category-filter')].map((b) => b.textContent.trim());
const tab = (label) => [...document.querySelectorAll('.inbox-categories .category-filter')].find((b) => b.textContent.trim() === label);
const subjects = () => [...document.querySelectorAll('.viewport .row .subject')].map((s) => s.textContent.trim());
const row = (subject) => [...document.querySelectorAll('.viewport .row')].find((r) => r.querySelector('.subject')?.textContent.trim() === subject);
const title = () => document.querySelector('.viewport')?.getAttribute('aria-label');
const inTab = async (label, subject) => { tab(label)?.click(); return !!(await until(() => row(subject))); };
'''

def page(body):
    r = spark.run_in_app(m, HELPERS + body)
    if isinstance(r, str) and r.startswith('ERROR'): raise RuntimeError(r)
    return r

result = {}
try:
    spark.run_in_app(m, "await messenger.storage.local.set({ workAccounts: ['account2'], inboxGroups: {}, senderGroups: {}, showAllInboxes: false, lastInbox: '' }); return 1;")
    reload_page()
    result['sidebar'] = page('''await until(() => sidebar('inbox-work'));
return { work: !!sidebar('inbox-work'), personal: !!sidebar('inbox-personal'), all: !!sidebar('inbox'), opened: title() };''')

    result['personal'] = page('''sidebar('inbox-personal').click();
await until(() => title() === 'Personal');
const out = { title: title(), tabs: tabs() };
out.people = await inTab('People', 'Dinner Saturday?');
out.purchases = await inTab('Purchases', 'Your order has shipped');
out.promotions = await inTab('Promotions', '40% off everything this weekend');
out.newsletters = await inTab('Newsletters', 'This week in reading');
out.notInPeople = (tab('People').click(), await pause(400), !row('Your order has shipped'));
out.groupTitle = (tab('Purchases').click(), await until(() => title() === 'Purchases — Personal'));
return out;''')

    result['work'] = page('''sidebar('inbox-work').click();
await until(() => title() === 'Work');
const out = { title: title(), tabs: tabs() };
out.team = await inTab('Team', 'Team offsite agenda');
out.outside = await inTab('Outside', 'Inboxes bulk test A');
out.workHasNoPersonal = (tab('All').click(), await pause(400), !row('Dinner Saturday?'));
return out;''')

    # "Always put this sender in…" from the email's Details.
    result['rule'] = page('''tab('Outside').click();
const r = await until(() => row('Inboxes bulk test A')); r.click();
const more = await until(() => document.querySelector('.reader button[aria-label="Show details"]')); more.click();
const select = await until(() => document.querySelector('.reader .sender-group select'));
if (!select) return { error: 'no sender group picker' };
select.value = 'tools'; select.dispatchEvent(new Event('change', { bubbles: true }));
await pause(600);
const out = { inTools: await inTab('Tools', 'Inboxes bulk test A'), leftOutside: (tab('Outside').click(), await pause(500), !row('Inboxes bulk test A')) };
return out;''')
    result['rule_saved'] = spark.run_in_app(m, "return (await messenger.storage.local.get('senderGroups')).senderGroups;")
    spark.run_in_app(m, "await messenger.storage.local.set({ senderGroups: {} }); return 1;")

    # Settings → Inboxes: rename a group and hide another.
    spark.open_settings(m, 'inboxes', 'Work groups')
    try:
        result['settings'] = spark.in_settings(m, spark.SETTING_ITEM + r'''
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const card = item('Work groups');
const rows = () => [...document.querySelectorAll('.group-row')];
const team = rows().find((r) => r.querySelector('input.field').value === 'Team');
if (!team) return { error: 'no Team row' };
const name = team.querySelector('input.field'); name.value = 'Colleagues'; name.dispatchEvent(new Event('change', { bubbles: true }));
await pause(300);
const tools = rows().find((r) => r.querySelector('input.field').value === 'Announcements');
tools.querySelector('input.switch').click();
await pause(300);
return { rows: rows().length, renamed: rows().some((r) => r.querySelector('input.field').value === 'Colleagues') };''')
    finally:
        spark.close_settings(m)
    result['renamed_tabs'] = page('''await until(() => tabs().includes('Colleagues'), 5000); return tabs();''')

    # Picking several: ⌘-click, Shift-click, ⌘A, then a bulk Archive and Undo.
    result['pick'] = page('''tab('All').click();
await until(() => row('Inboxes bulk test A') && row('Inboxes bulk test B'));
const click = (el, opts) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...opts }));
const bar = () => document.querySelector('.selection-bar');
const count = () => bar()?.querySelector('.count')?.textContent.trim();
const out = {};
click(row('Inboxes bulk test A'), {}); await pause(200);
click(row('Inboxes bulk test B'), { metaKey: true }); await until(() => bar());
out.twoPicked = count();
out.pickedRows = document.querySelectorAll('.viewport .row.picked').length;
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await pause(200);
out.cleared = !bar();
click(row('Inboxes bulk test A'), { metaKey: true }); await pause(100);
click(row('Team offsite agenda'), { shiftKey: true }); await pause(200);
out.range = count();
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true })); await pause(200);
// The list draws only the rows on screen: everything is picked when "Select all N" is gone.
out.all = count(); out.selectAllLeft = !!bar()?.querySelector('.text-action');
window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await pause(200);
click(row('Inboxes bulk test A'), { metaKey: true }); await pause(100);
click(row('Inboxes bulk test B'), { metaKey: true }); await until(() => bar());
out.beforeArchive = count();
bar().querySelector('button[aria-label^="Archive"]').click();
out.archived = !!(await until(() => !row('Inboxes bulk test A') && !row('Inboxes bulk test B'), 8000));
out.toast = document.querySelector('.toast')?.textContent.trim() || null;
const undo = await until(() => [...document.querySelectorAll('.toast button')].find((b) => b.textContent.trim() === 'Undo'));
undo?.click();
out.restored = !!(await until(() => row('Inboxes bulk test A') && row('Inboxes bulk test B'), 15000));
return out;''')
    spark.app_shot(m, args.output_dir / 'inboxes.png')
finally:
    spark.run_in_app(m, "await messenger.storage.local.set(%s); return 1;" % json.dumps({'workAccounts': saved.get('workAccounts', []), 'inboxGroups': saved.get('inboxGroups', {}), 'senderGroups': saved.get('senderGroups', {}), 'showAllInboxes': saved.get('showAllInboxes', False), 'lastInbox': saved.get('lastInbox', '')}))
    reload_page()
    spark._end_session(m)

p, w, pick = result.get('personal', {}), result.get('work', {}), result.get('pick', {})
checks = {
    'sidebar_work_and_personal': result['sidebar'] == {'work': True, 'personal': True, 'all': False, 'opened': result['sidebar']['opened']} and result['sidebar']['opened'] in ('Work', 'Personal'),
    'personal_tabs': p.get('tabs') == ['All', 'People', 'Plans', 'Purchases', 'Money', 'Newsletters', 'Promotions', 'Pinned'],
    'personal_groups': all(p.get(k) for k in ('people', 'purchases', 'promotions', 'newsletters', 'notInPeople', 'groupTitle')),
    'work_tabs': w.get('tabs') == ['All', 'Team', 'Outside', 'Calendar', 'Tools', 'Receipts', 'Announcements', 'Pinned'],
    'work_groups': all(w.get(k) for k in ('team', 'outside', 'workHasNoPersonal')),
    'sender_rule': bool(result.get('rule', {}).get('inTools')) and bool(result.get('rule', {}).get('leftOutside')) and result.get('rule_saved') == {'work': {'tom@vendor.example': 'tools'}},
    'settings_rename_hide': bool(result.get('settings', {}).get('renamed')) and 'Colleagues' in result.get('renamed_tabs', []) and 'Announcements' not in result.get('renamed_tabs', []),
    'cmd_click_two': pick.get('twoPicked') == '2 selected' and pick.get('pickedRows') == 2 and pick.get('cleared') is True,
    'shift_range': bool(pick.get('range')) and pick.get('range') != '1 selected',
    'cmd_a_all': bool(pick.get('all')) and int(pick['all'].split()[0]) > 2 and pick.get('selectAllLeft') is False,
    'bulk_archive_undo': pick.get('beforeArchive') == '2 selected' and pick.get('archived') is True and pick.get('restored') is True,
}
result['checks'] = checks
(args.output_dir / 'inboxes.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
print('ALL PASS' if all(checks.values()) else 'FAIL: ' + ', '.join(k for k, v in checks.items() if not v))
raise SystemExit(0 if all(checks.values()) else 1)
