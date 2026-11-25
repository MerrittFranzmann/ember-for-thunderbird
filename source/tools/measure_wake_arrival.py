#!/usr/bin/env python3
"""New mail after Ember's background has been suspended (Thunderbird stops idle event pages after ~30 s),
isolated profile only (port 2831): waits until the background is stopped, adds one message to the test
Inbox, and prints the Ember page's long frames and spans over 15 ms for the next 8 s.

  measure_wake_arrival.py
"""
import time
import spark

m = spark.connect()
STATE = "return WebExtensionPolicy.getByID('thunderbird-spark@merrittfranzmann').extension.backgroundState"
for _ in range(30):
    if m.execute(STATE) == 'stopped': break
    time.sleep(3)
print('background before:', m.execute(STATE))
spark.run_in_app(m, "window.__w={gaps:[], t0: Date.now()}; let last=performance.now(); const loop=(n)=>{window.__w.gaps.push(n-last); last=n; if(!window.__w.stop) requestAnimationFrame(loop);}; requestAnimationFrame(loop); return 1;")
time.sleep(0.5)
m.execute("""const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const f=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder);
f.addMessage('From: Grace Hopper <grace@navy.test>\\r\\nTo: merritt@spark.test\\r\\nSubject: Wake arrival '+Date.now()+'\\r\\nDate: '+new Date().toUTCString()+'\\r\\nMessage-ID: <wake-'+Date.now()+'@spark.test>\\r\\nX-Mozilla-Status: 0000\\r\\n\\r\\nNew.\\r\\n'); return 1;""")
time.sleep(8)
print(spark.run_in_app(m, """window.__w.stop=true; const g=window.__w.gaps;
window.dispatchEvent(new KeyboardEvent('keydown',{key:'L',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true})); await new Promise(r=>setTimeout(r,1500));
const r=(await messenger.storage.local.get('perfReports')).perfReports||[]; const rep=typeof r.at(-1)==='string'? JSON.parse(r.at(-1)) : r.at(-1); const t0=window.__w.t0;
return {maxFrame:Math.round(Math.max(...g)), over50:g.filter(x=>x>50).map(Math.round), spans:(rep?.entries||[]).filter(e=>e.ms>15 && e.t>=t0).map(e=>[Math.round(e.t-t0), e.kind, e.ms].join(' '))};"""))
