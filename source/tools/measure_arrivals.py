#!/usr/bin/env python3
"""Cost of new mail at scale, isolated profile only (port 2831): adds 5 messages to the test Inbox
(account2) 2.5 s apart while the Smart Inbox is open, then prints the longest frames and the perf
recorder's spans over 15 ms (regroups, cache passes).

  measure_arrivals.py [--install]   (--install reinstalls dist/ first)
"""
import os, sys, time
import spark

m = spark.connect()
if '--install' in sys.argv:
    m._cmd('Addon:Install', {'path': os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'dist')), 'temporary': True}); time.sleep(25)
spark.run_in_app(m, "await messenger.storage.local.remove('perfReports'); [...document.querySelectorAll('.sidebar .item')].find(b=>b.querySelector('.label')?.textContent.trim()==='Inbox').click(); document.querySelector('button[aria-label=\"Close conversation\"]')?.click(); return 1;"); time.sleep(4)
spark.run_in_app(m, "window.__a={gaps:[], t0: Date.now()}; let last=performance.now(); const loop=(n)=>{window.__a.gaps.push(n-last); last=n; if(!window.__a.stop) requestAnimationFrame(loop);}; requestAnimationFrame(loop); return 1;")
for i in range(5):
    m.execute("""const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const f=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder);
f.addMessage('From: Grace Hopper <grace@navy.test>\\r\\nTo: merritt@spark.test\\r\\nSubject: Scale arrival '+Date.now()+'\\r\\nDate: '+new Date().toUTCString()+'\\r\\nMessage-ID: <sarr-'+Date.now()+'@spark.test>\\r\\nX-Mozilla-Status: 0000\\r\\n\\r\\nNew.\\r\\n'); return 1;""")
    time.sleep(2.5)
print(spark.run_in_app(m, "window.__a.stop=true; const g=window.__a.gaps; return {maxFrame:Math.round(Math.max(...g)), over50:g.filter(x=>x>50).map(Math.round)};"))
print(spark.run_in_app(m, "window.dispatchEvent(new KeyboardEvent('keydown',{key:'L',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true})); await new Promise(r=>setTimeout(r,1500)); const r=(await messenger.storage.local.get('perfReports')).perfReports||[]; const rep=typeof r.at(-1)==='string'? JSON.parse(r.at(-1)) : r.at(-1); const t0=window.__a.t0; return (rep?.entries||[]).filter(e=>e.ms>15 && e.t>=t0).map(e=>[Math.round(e.t-t0), e.kind, e.ms].join(' '));"))
