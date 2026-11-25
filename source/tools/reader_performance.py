#!/usr/bin/env python3
"""Measure actual page-realm code in the isolated Thunderbird fixture profile, port 2831."""
import argparse,json,sys,time
from pathlib import Path
import spark
parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);parser.add_argument('--config',default='{}');args=parser.parse_args();client=spark.connect()
code="""window.__readerBenchmarkConfig=%s;window.__readerBenchmarkResult=null;const script=document.createElement('script');script.type='module';script.src=messenger.runtime.getURL('reader-benchmark.js')+'?'+Date.now();document.body.append(script);return true;"""%args.config
spark.run_in_app(client,code)
result=None
for attempt in range(300):
 result=spark.run_in_app(client,'return window.__readerBenchmarkResult;')
 if result:break
 time.sleep(.1)
assert isinstance(result,dict) and result.get('ok'),result
args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(result['value'],indent=2)+'\n')
print(json.dumps([{k:round(v,1) if isinstance(v,float) else v for k,v in record.items() if k not in ('calls','work')}for record in result['value']['records']],indent=2));print(json.dumps(result['value']['records'][0]['work']));print('RPC calls',len(result['value']['records'][0]['calls']))
# Recreate native API bindings after fault instrumentation replaces a WebExtension method.
client.execute('const tm=document.getElementById("tabmail");const t=tm.tabInfo.find(t=>(t.browser||t.chromeBrowser)?.currentURI?.spec?.includes("/app.html"));(t.browser||t.chromeBrowser).reload();return true;')
