#!/usr/bin/env python3
"""Today + tomorrow in the sidebar, isolated fixture profile only (port 2831), against a local mock EWS.

The mock calendar has: a meeting in progress with a Teams link (accepted), a tentative one, an unanswered
meeting that overlaps an accepted one, and two meetings tomorrow. Checks the day tabs and counts, the answer
marks (Tentative only), the Join buttons (shown on hover/focus), the clash card and its Accept (the EWS request it sends), Tomorrow, and the sidebar's
account dots and "/" search. Saves light and dark screenshots. Removes the account and certificate override
afterwards. Never contacts an external server.

  test_agenda_days.py --output-dir DIR
"""
import argparse, base64, http.server, json, ssl, subprocess, tempfile, threading, time
from datetime import datetime, timedelta, timezone
from pathlib import Path
import spark

parser = argparse.ArgumentParser()
parser.add_argument('--output-dir', type=Path, required=True)
args = parser.parse_args()
args.output_dir.mkdir(parents=True, exist_ok=True)

now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
local_midnight = datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
tomorrow = (local_midnight + timedelta(days=1)).astimezone(timezone.utc)
iso = lambda d: d.strftime('%Y-%m-%dT%H:%M:%SZ')
# Today's meetings must stay today (local), whatever the time the test runs.
end_of_today = (local_midnight + timedelta(days=1)).astimezone(timezone.utc)
later = min(now + timedelta(hours=2), end_of_today - timedelta(minutes=70))
EVENTS = [
    ('LIVE', 'Brief 1:1', now - timedelta(minutes=10), now + timedelta(minutes=20), 'Accept', 'https://teams.microsoft.com/l/meetup-join/19%3alive%40thread.v2/0'),
    ('MAYBE', 'Lunch and learn', later - timedelta(minutes=40), later - timedelta(minutes=10), 'Tentative', ''),
    ('CRIT', 'Design critique', later, later + timedelta(minutes=60), 'NoResponseReceived', ''),
    ('VENDOR', 'Vendor call', later + timedelta(minutes=30), later + timedelta(minutes=60), 'Accept', 'https://acme.zoom.us/j/123456'),
    ('T1', 'Board prep', tomorrow + timedelta(hours=14), tomorrow + timedelta(hours=15), 'Accept', ''),
    ('T2', 'Interview: designer', tomorrow + timedelta(hours=16), tomorrow + timedelta(hours=17), 'NoResponseReceived', ''),
]
esc = lambda s: s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
def envelope(body):
    return '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' + body + '</s:Body></s:Envelope>'
M = 'xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"'
def ok(kind, inner=''):
    return envelope(f'<m:{kind}Response {M}><m:ResponseMessages><m:{kind}ResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>{inner}</m:{kind}ResponseMessage></m:ResponseMessages></m:{kind}Response>')
state = {'answer': {}}
def view():
    items = ''.join(f'<t:CalendarItem><t:ItemId Id="{i}"/><t:Subject>{esc(s)}</t:Subject><t:Start>{iso(a)}</t:Start><t:End>{iso(b)}</t:End>'
                    f'<t:IsAllDayEvent>false</t:IsAllDayEvent><t:LegacyFreeBusyStatus>{"Tentative" if r == "Tentative" else "Busy"}</t:LegacyFreeBusyStatus><t:Location>Online</t:Location>'
                    f'<t:UID>uid-{i}</t:UID><t:MyResponseType>{state["answer"].get(i, r)}</t:MyResponseType><t:IsCancelled>false</t:IsCancelled></t:CalendarItem>' for i, s, a, b, r, _ in EVENTS)
    return ok('FindItem', f'<m:RootFolder TotalItemsInView="{len(EVENTS)}" IncludesLastItemInRange="true"><t:Items>{items}</t:Items></m:RootFolder>')
DETAILS = ok('GetItem', '<m:Items>' + ''.join(f'<t:CalendarItem><t:ItemId Id="{i}"/><t:Body BodyType="Text">{esc(link)}</t:Body></t:CalendarItem>' for i, _, _, _, _, link in EVENTS) + '</m:Items>')
creates = []

class EWS(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
        reply = None
        if '<m:FindItem' in body and 'calendar:Start' in body: reply = view()
        elif '<m:GetItem' in body and 'item:Body' in body: reply = DETAILS
        elif '<m:GetItem' in body and 'calendar:MyResponseType' in body:
            reply = ok('GetItem', '<m:Items><t:CalendarItem><t:ItemId Id="CRIT"/><t:MyResponseType>Accept</t:MyResponseType><t:IsCancelled>false</t:IsCancelled></t:CalendarItem></m:Items>')
        elif '<m:CreateItem' in body:
            creates.append(body)
            if '<t:AcceptItem>' in body and 'Id="CRIT"' in body: state['answer']['CRIT'] = 'Accept'
            reply = ok('CreateItem', '<m:Items/>')
        self.send_response(200 if reply else 500)
        self.send_header('Content-Type', 'text/xml; charset=utf-8')
        self.end_headers()
        self.wfile.write((reply or '').encode())

work = Path(tempfile.mkdtemp(dir=args.output_dir))
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
                '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', work / 'key.pem', '-out', work / 'cert.pem'], check=True, capture_output=True)
der = subprocess.run(['openssl', 'x509', '-in', work / 'cert.pem', '-outform', 'DER'], check=True, capture_output=True).stdout
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), EWS)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(work / 'cert.pem', work / 'key.pem')
server.socket = context.wrap_socket(server.socket, server_side=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
port = server.server_address[1]

m = spark.connect()
def chrome(script, values=()):
    reply = m._cmd("WebDriver:ExecuteScript", {"script": script, "args": list(values)})
    return reply.get("value") if isinstance(reply, dict) else reply
account = chrome('''
const [port, der] = arguments;
const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const cert = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB).constructX509FromBase64(der);
Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).rememberValidityOverride("127.0.0.1", port, {}, cert, false);
const server = MailServices.accounts.createIncomingServer("merritt@ews.test", "127.0.0.1", "ews");
server.setStringValue("ews_url", `https://127.0.0.1:${port}/EWS/Exchange.asmx`);
server.authMethod = Ci.nsMsgAuthMethod.passwordCleartext;
server.password = "spark-test-password";
server.loginAtStartUp = false; server.doBiff = false;
const account = MailServices.accounts.createAccount();
account.incomingServer = server;
const identity = MailServices.accounts.createIdentity(); identity.email = "merritt@ews.test"; identity.fullName = "Merritt (EWS test)";
account.addIdentity(identity);
return account.key;''', [port, base64.b64encode(der).decode()])
READ = r'''
const rows = (ul) => [...(ul?.querySelectorAll(':scope > li') || [])].map((li) => ({ time: li.querySelector('.time')?.textContent.trim(), title: li.querySelector('.title')?.textContent.trim(), mark: li.querySelector('.mark')?.getAttribute('aria-label') || null, join: !!li.querySelector('.join'), joinSoon: !!li.querySelector('.join.soon'), live: li.classList.contains('live') }));
const lists = document.querySelectorAll('.agenda ul');
return { tabs: [...document.querySelectorAll('.agenda .days button')].map((b) => [b.textContent.trim(), b.getAttribute('aria-selected')]),
  today: rows(lists[0]), tomorrow: rows(lists[1]), clash: document.querySelector('.agenda .clash p')?.textContent.trim() || null,
  chevrons: document.querySelectorAll('.sidebar .chev, .sidebar .disclosure').length,
  // Account dots: in the Inbox's right-click menu (its accounts no longer open up under it).
  ...await (async () => {
    const box = document.querySelector('.sidebar [data-mailbox="inbox"] > button.item.parent');
    box?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 120 }));
    await new Promise((r) => setTimeout(r, 200));
    const menu = document.querySelector('.context-menu[aria-label^="Show in"]');
    const out = { dots: [...(menu?.querySelectorAll('.dot') || [])].map((d) => getComputedStyle(d).backgroundColor), accountRows: [...(menu?.querySelectorAll('.name') || [])].map((l) => l.textContent.trim()) };
    menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return out;
  })(),
  noAccountRows: !document.querySelector('.sidebar [data-mailbox="inbox"] .children'),
  searchBar: !!document.querySelector('form.search') };'''
result = {}
try:
    spark.run_in_app(m, r'''document.querySelector('.sidebar .item.parent[aria-label^="Inbox"]')?.click();
window.dispatchEvent(new Event('spark:calendar-changed'));
for (let i = 0; i < 40 && !document.querySelector('.agenda .clash'); i++) await new Promise(r => setTimeout(r, 250)); return 1;''')
    # Both themes: Ember's own Appearance setting decides (the profile may be set to Dark), so set it on the page.
    theme = spark.run_in_app(m, "return document.documentElement.dataset.theme || '';")
    spark.run_in_app(m, "document.documentElement.dataset.theme = 'light'; return 1;")
    time.sleep(0.5)
    result['light'] = spark.run_in_app(m, READ)
    spark.app_shot(m, str(args.output_dir / 'agenda-light.png'))
    spark.run_in_app(m, "document.documentElement.dataset.theme = 'dark'; return 1;")
    time.sleep(0.5)
    result['dark'] = spark.run_in_app(m, READ)
    spark.app_shot(m, str(args.output_dir / 'agenda-dark.png'))
    spark.run_in_app(m, "document.documentElement.dataset.theme = %s; return 1;" % json.dumps(theme))
    # The call button: hidden on its line until hovered or focused (only focus can be synthesized here).
    result['joinShown'] = spark.run_in_app(m, r'''const join = [...document.querySelectorAll('.agenda li')].find((li) => li.querySelector('.title')?.textContent.trim() === 'Vendor call')?.querySelector('.join');
document.activeElement?.blur(); await new Promise(r => setTimeout(r, 300));
const idle = getComputedStyle(join).opacity;
join.focus(); await new Promise(r => setTimeout(r, 300));
const focused = getComputedStyle(join).opacity; join.blur();
// Synthetic focus doesn't count while the test window is in the background: then check the rules themselves.
const rules = [...document.styleSheets].flatMap((sheet) => { try { return [...sheet.cssRules]; } catch { return []; } }).map((r) => r.cssText);
const shows = (pseudo) => rules.some((t) => new RegExp(`li[\\w.-]*:${pseudo} \\.join[^{]*\\{[^}]*opacity: 1`).test(t));
return { idle, focused: document.hasFocus() ? focused : '1', hasFocus: document.hasFocus(), hoverRule: shows('hover'), focusRule: shows('focus-within') };''')
    # Tomorrow tab.
    result['tomorrowTab'] = spark.run_in_app(m, r'''[...document.querySelectorAll('.agenda .days button')][1].click(); await new Promise(r => setTimeout(r, 200));
const out = [...document.querySelectorAll('.agenda ul:first-of-type > li .title')].map((t) => t.textContent.trim());
[...document.querySelectorAll('.agenda .days button')][0].click(); return out;''')
    # "/" opens search; Esc puts it away.
    result['search'] = spark.run_in_app(m, r'''document.activeElement?.blur();
window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
await new Promise(r => setTimeout(r, 200));
const opened = !!document.querySelector('form.search') && document.activeElement === document.querySelector('form.search input');
document.querySelector('form.search input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
await new Promise(r => setTimeout(r, 200));
return { opened, closed: !document.querySelector('form.search') };''')
    # Accept the unanswered clash.
    result['accept'] = spark.run_in_app(m, r'''[...document.querySelectorAll('.agenda .clash button')].find((b) => b.textContent.trim() === 'Accept').click();
for (let i = 0; i < 40 && document.querySelector('.agenda .clash'); i++) await new Promise(r => setTimeout(r, 250));
return { clashGone: !document.querySelector('.agenda .clash'), toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent.trim()) };''')
    L, D = result['light'], result['dark']
    today = {r['title']: r for r in L['today']}
    result['checks'] = {
        'tabs_with_counts': L['tabs'] == [['Today4', 'true'], ['Tomorrow2', 'false']],
        'live_row_now_and_join': today.get('Brief 1:1', {}).get('live') and today['Brief 1:1']['time'] == 'Now' and today['Brief 1:1']['joinSoon'],
        # Only Tentative is marked (no ✓ for accepted, no ! for unanswered: the user's choice, 0.1.116).
        'marks': today.get('Lunch and learn', {}).get('mark') == 'Tentative' and today.get('Design critique', {}).get('mark') is None and today.get('Vendor call', {}).get('mark') is None,
        'join_shows_on_hover_or_focus': result['joinShown']['idle'] == '0' and result['joinShown']['focused'] == '1' and result['joinShown']['hoverRule'] and result['joinShown']['focusRule'],
        'join_for_calls_only': today.get('Vendor call', {}).get('join') and not today.get('Design critique', {}).get('join'),
        'clash_card': L['clash'] == 'Design critique overlaps Vendor call',
        'today_shows_only_today': L['tomorrow'] == [] and not any(r['title'] in ('Board prep', 'Interview: designer') for r in L['today']),
        'tomorrow_tab': result['tomorrowTab'] == ['Board prep', 'Interview: designer'],
        'no_chevrons': L['chevrons'] == 0,
        'account_dots': len(L['dots']) >= 2 and len(set(L['dots'])) == len(L['dots']) and L['noAccountRows'],
        'dots_change_with_theme': L['dots'] != D['dots'],
        'no_search_bar': L['searchBar'] is False,
        'slash_opens_search': result['search']['opened'] and result['search']['closed'],
        'accept_sends_accept_item': any('<t:AcceptItem><t:ReferenceItemId Id="CRIT"/></t:AcceptItem>' in c and 'SendAndSaveCopy' in c for c in creates),
        'accept_clears_clash': result['accept']['clashGone'] and any('Accepted “Design critique”' in t for t in result['accept']['toasts']),
    }
finally:
    chrome('''
const [key, port] = arguments;
const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const account = MailServices.accounts.getAccount(key);
if (account) MailServices.accounts.removeAccount(account, true);
Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).clearValidityOverride("127.0.0.1", port, {});
return true;''', [account, port])
    server.shutdown()
    subprocess.run(['rm', '-rf', str(work)])
    spark.run_in_app(m, "window.dispatchEvent(new Event('spark:calendar-changed')); return 1;")

(args.output_dir / 'agenda-days.json').write_text(json.dumps(result, indent=2, ensure_ascii=False))
print(json.dumps(result, indent=2, ensure_ascii=False))
raise SystemExit(0 if result.get('checks') and all(result['checks'].values()) else 1)
