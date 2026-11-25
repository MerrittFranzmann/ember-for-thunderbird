#!/usr/bin/env python3
"""Ember start-up timeline, isolated profile only (port 2831): reloads the Ember page N times and prints its
performance marks (spark:init … spark:first-view, spark:cache when all saved headers have arrived).

  measure_startup.py [N]
"""
import json, sys, time
import spark

m = spark.connect()
for _ in range(int(sys.argv[1]) if len(sys.argv) > 1 else 3):
    try: spark.run_in_app(m, "setTimeout(() => location.reload(), 50); return 1;")
    except Exception: pass
    time.sleep(9)
    print(json.dumps(spark.run_in_app(m, """
const marks = performance.getEntriesByType('mark').filter((e) => e.name.startsWith('spark:')).map((e) => [e.name.slice(6), Math.round(e.startTime)]);
return { marks: Object.fromEntries(marks), rows: document.querySelectorAll('.row').length };""")))
