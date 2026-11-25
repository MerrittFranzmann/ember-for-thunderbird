#!/usr/bin/env python3
"""New mail while Ember is minimized, isolated profile only (port 2831): minimizes the Ember window, adds 4
messages to the test Inbox 3 s apart, restores the window, and prints the page's spans over 5 ms while
hidden and after it's shown. Since 0.1.80 a hidden page should show no spark.regroup / spark.related-index
spans (only the preview fetch); one regroup follows the restore.

  measure_hidden_arrivals.py
"""
import time
import spark

ADD = """const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const f=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder);
f.addMessage('From: Grace Hopper <grace@navy.test>\\r\\nTo: merritt@spark.test\\r\\nSubject: Hidden arrival '+Date.now()+'\\r\\nDate: '+new Date().toUTCString()+'\\r\\nMessage-ID: <harr-'+Date.now()+'@spark.test>\\r\\nX-Mozilla-Status: 0000\\r\\n\\r\\nNew.\\r\\n'); return 1;"""
SPANS = """window.dispatchEvent(new KeyboardEvent('keydown',{key:'L',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));
await new Promise(r=>setTimeout(r,1500)); const r=(await messenger.storage.local.get('perfReports')).perfReports||[];
const rep=typeof r.at(-1)==='string'? JSON.parse(r.at(-1)) : r.at(-1); const from=window.__hiddenFrom, to=window.__hiddenTo||Infinity;
return (rep?.entries||[]).filter(e=>e.t>=from && e.t<to && e.ms>=5).map(e=>[Math.round(e.t-from), e.kind, e.ms].join(' '));"""

m = spark.connect()
spark.run_in_app(m, "await messenger.storage.local.remove('perfReports'); [...document.querySelectorAll('.sidebar .item')].find(b=>b.querySelector('.label')?.textContent.trim()==='Inbox').click(); return 1;")
time.sleep(2)
m.execute("for (const w of Services.wm.getEnumerator('mail:extensionPopup')) w.minimize(); return true;")
time.sleep(2)
print('page:', spark.run_in_app(m, "window.__hiddenFrom=Date.now(); return document.visibilityState;"))
for _ in range(4):
    m.execute(ADD)
    time.sleep(3)
spark.run_in_app(m, "window.__hiddenTo=Date.now(); return 1;")
print('while hidden:', spark.run_in_app(m, SPANS))
m.execute("for (const w of Services.wm.getEnumerator('mail:extensionPopup')) w.restore(); return true;")
time.sleep(3)
print('after restore:', spark.run_in_app(m, "window.__hiddenFrom=window.__hiddenTo; window.__hiddenTo=undefined; return 1;") and spark.run_in_app(m, SPANS))
m.execute("for (const w of Services.wm.getEnumerator('mail:extensionPopup')) w.minimize(); return true;")
