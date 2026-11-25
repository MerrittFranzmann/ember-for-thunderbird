#!/usr/bin/env python3
"""First run of the saved-mail cache, isolated profile only (port 2831): disables Ember, deletes its
"spark-mail-cache" database (the installed copy's), re-enables it, and prints the cache's progress and the
extension process's memory until it's ready. Rebuilds the test cache (13.6k emails: ~45 s since 0.1.83);
storage.local (settings, the saved cache status) is kept, as when only the database is lost.

  measure_first_run.py
"""
import sys, time, json
import spark
m = spark.connect()
AM = "const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs'); const a=await AddonManager.getAddonByID('thunderbird-spark@merrittfranzmann');"
print(spark.chrome_async(m, AM + r'''
const policy = WebExtensionPolicy.getByID('thunderbird-spark@merrittfranzmann');
const principal = Services.scriptSecurityManager.createContentPrincipal(Services.io.newURI(policy.getURL('')), {});
await a.disable(); await new Promise(r => setTimeout(r, 2000));
const req = indexedDB.deleteForPrincipal(principal, 'spark-mail-cache');
const result = await new Promise(res => { req.onsuccess = () => res('deleted'); req.onerror = () => res('error ' + req.error); req.onblocked = () => res('blocked'); });
// close orphan popup windows the disable leaves behind
for (const w of [...Services.wm.getEnumerator('mail:extensionPopup')]) { const spec = w.document.querySelector('browser')?.currentURI?.spec || ''; if (!spec.includes('app.htm')) w.close(); }
a.enable(); return result;
'''))
t0 = time.time()
time.sleep(15)
try: spark.run_in_app(m, "return 1;")
except Exception: pass
last = None
while time.time() - t0 < 300:
    try:
        s = spark.run_in_app(m, "const s=(await messenger.storage.local.get('cacheStatus')).cacheStatus; return {phase:s.phase, done:s.done, total:s.total, saved:s.saved};")
    except Exception as e:
        s = {"err": str(e)[:80]}
    mem = spark.chrome_async(m, "const info=await ChromeUtils.requestProcInfo(); return info.children.filter(c=>c.type==='extension').map(c=>Math.round(c.memory/1048576))[0];")
    print(round(time.time() - t0), s.get('phase'), s.get('done'), 'MB', mem, flush=True); last = s
    if s.get("phase") == "ready" and s.get("total"): break
    time.sleep(2)
print("ready after", round(time.time() - t0), "s")
