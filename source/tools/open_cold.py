#!/usr/bin/env python3
"""Open each perf fixture with Gecko's image cache cleared first (cold remote images). Isolated profile only."""
import json, sys
import spark
from run_probe import run

CLEAR = "await new Promise(r => Services.clearData.deleteData(Ci.nsIClearDataService.CLEAR_IMAGE_CACHE, r)); return true;"
subjects = sys.argv[1:] or ['Perf newsletter 03', 'Perf newsletter 04', 'Perf newsletter 05', 'Perf inline images 02']
client = spark.connect()
for subject in subjects:
    spark.chrome_async(client, CLEAR)
    result = run(client, 'tools/smoke/open-render.js', json.dumps({'subjects': [subject], 'repeats': 1, 'stableMs': int(__import__('os').environ.get('STABLE', '3500'))}), '__openRenderConfig')
    print(json.dumps(result['value']['records'][0] if result.get('ok') else result), flush=True)
