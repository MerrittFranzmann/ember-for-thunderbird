#!/usr/bin/env python3
"""Memory of Thunderbird's extension process (Ember's page and background) across repeated use, isolated
profile only (port 2831): N rounds of view switches, opening conversations and searching, with the
process's resident memory before, after, and after a forced garbage/cycle collection.

  measure_memory.py [rounds]
"""
import json, sys, time
import spark, visual_audit as va

m = spark.connect()
MEM = """const info = await ChromeUtils.requestProcInfo(); const ext = info.children.filter(c => c.type === 'extension');
return ext.map(c => Math.round(c.memory / 1048576));"""
# "Minimize memory" (as about:memory does): forwarded to child processes, which GC/CC and release caches.
GC = """for (let i = 0; i < 3; i++) { Services.obs.notifyObservers(null, 'memory-pressure', 'heap-minimize'); await new Promise(r => setTimeout(r, 1500)); } return 1;"""
rounds = int(sys.argv[1]) if len(sys.argv) > 1 else 10
spark.chrome_async(m, GC)
before = spark.chrome_async(m, MEM)
ROUND = va.PRELUDE + """
for (const label of ['Archive','Sent','Inbox','Pins','Attachments','Inbox']) { await closeAll(); sidebar(label)?.click(); await pause(350); }
await home();
const rows=[...document.querySelectorAll('.row')].slice(0,6); for (const r of rows) { r.click(); await pause(300); }
const i=document.querySelector('input[aria-label^="Search mail"]'); for (const q of ['venue','Ada','newsletter']) { i.value=q; i.dispatchEvent(new Event('input',{bubbles:true})); i.closest('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})); await pause(500); }
document.querySelector('button[aria-label="Clear search"]')?.click(); await pause(300); return 1;"""
t0 = time.time()
for k in range(rounds):
    spark.run_in_app(m, ROUND)
after = spark.chrome_async(m, MEM)
spark.chrome_async(m, GC)
collected = spark.chrome_async(m, MEM)
print(json.dumps({'rounds': rounds, 'seconds': round(time.time() - t0), 'extensionMB': {'before': before, 'after': after, 'afterGC': collected}}))
