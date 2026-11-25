#!/usr/bin/env python3
"""Follow-up reminder notification click, end to end, isolated profile only (port 2831): registers a stand-in
alerts service that keeps the click listener (nothing appears on screen), adds a due reminder for a saved
sent email (to an address that never replies), runs the sweep alarm, simulates a click on the notification,
and prints the subject the Ember reader opened. Cleans up the reminder and restores the alerts service.

  test_followup_click.py
"""
import sys, time, json
import spark
m = spark.connect()
# stand-in alerts service that keeps the listener so a click can be simulated
m.execute("""
const registrar=Components.manager.QueryInterface(Ci.nsIComponentRegistrar);const contract='@mozilla.org/alerts-service;1';
window.__fuAlerts=[]; window.__fuOrigCID=registrar.contractIDToCID(contract);
window.__fuCID=Components.ID('{'+Services.uuid.generateUUID().toString().slice(1,-1)+'}');
const fake={showAlert(alert,listener){window.__fuAlerts.push({alert,listener});try{listener&&listener.observe(null,'alertshow',alert.cookie);}catch(e){}},closeAlert(){},QueryInterface:ChromeUtils.generateQI(['nsIAlertsService'])};
window.__fuFactory={createInstance(iid){return fake.QueryInterface(iid);},QueryInterface:ChromeUtils.generateQI(['nsIFactory'])};
registrar.registerFactory(window.__fuCID,'FU test alerts',contract,window.__fuFactory); return 1;""")
setup = spark.run_in_app(m, r'''
const sent=(await messenger.folders.query({specialUse:['sent']}))[0];
const p=await messenger.messages.query({folderId: sent.id, fromDate: new Date(Date.now()-30*86400000)});
const msg=p.messages.find(x=>x.headerMessageId); if(!msg) return 'no sent mail';
const mid=msg.headerMessageId.replace(/^<|>$/g,'');
const {followUps={}}=await messenger.storage.local.get('followUps');
followUps[mid]={mid, subject: 'FU click check '+Date.now(), to: ['nobody-'+Date.now()+'@nowhere.test'], sentAt: +new Date(msg.date), dueAt: Date.now()-1000, state:'waiting'};
await messenger.storage.local.set({followUps});
await messenger.alarms.create('spark-followups', {when: Date.now()+200});
return {mid, subject: msg.subject};
''')
print("setup", setup)
time.sleep(6)
n = m.execute("return window.__fuAlerts.length;")
print("alerts", n, spark.run_in_app(m, "const {followUps={}}=await messenger.storage.local.get('followUps'); return Object.values(followUps).map(f=>[f.mid.slice(0,20), f.state]);"))
if n:
    m.execute("const a=window.__fuAlerts.at(-1); a.listener.observe(null,'alertclickcallback',a.alert.cookie); return 1;")
    time.sleep(4)
    print(spark.run_in_app(m, "return document.querySelector('.reader h1')?.textContent?.trim()?.slice(0,80) || null;"))
# clean up: remove the follow-up and restore the alerts service
spark.run_in_app(m, "const {followUps={}}=await messenger.storage.local.get('followUps'); delete followUps[%s]; await messenger.storage.local.set({followUps}); return 1;" % json.dumps(setup['mid'] if isinstance(setup, dict) else ''))
m.execute("const registrar=Components.manager.QueryInterface(Ci.nsIComponentRegistrar); registrar.registerFactory(window.__fuOrigCID,'','@mozilla.org/alerts-service;1',null); try{registrar.unregisterFactory(window.__fuCID,window.__fuFactory);}catch(e){} return 1;")
