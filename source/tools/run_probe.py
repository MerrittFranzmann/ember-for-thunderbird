#!/usr/bin/env python3
"""Run a long page probe (tools/smoke/*.js) in the isolated Ember tab without Marionette's 30 s limit.

The probe body runs as an async function; its result is parked on a DOM attribute and polled.
Usage: run_probe.py PROBE.js [--config JSON] [--global NAME] [--output FILE]
Import run() instead of spawning this script while holding a session: Marionette allows only one.
"""
import argparse, json, sys, time
from pathlib import Path
import spark


def run(client, probe, config='{}', name='__probeConfig', timeout=600):
    start = """globalThis[%s] = %s; const root = document.documentElement; root.removeAttribute('data-probe-result');
(async () => { %s
})().then((v) => root.setAttribute('data-probe-result', JSON.stringify({ ok: true, value: v })), (e) => root.setAttribute('data-probe-result', JSON.stringify({ ok: false, error: String(e) + ' | ' + String(e && e.stack || '') })));
return true;""" % (json.dumps(name), config, Path(probe).read_text())
    spark.run_in_app(client, start)
    deadline = time.time() + timeout
    while time.time() < deadline:
        result = spark.run_in_app(client, "return document.documentElement.getAttribute('data-probe-result');")
        if result:
            return json.loads(result)
        time.sleep(0.5)
    raise TimeoutError('probe timed out')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('probe', type=Path)
    parser.add_argument('--config', default='{}')
    parser.add_argument('--global', dest='name', default='__probeConfig')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--timeout', type=float, default=600)
    args = parser.parse_args()
    result = run(spark.connect(), args.probe, args.config, args.name, args.timeout)
    text = json.dumps(result, indent=2)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(text + '\n')
    print(text)
    sys.exit(0 if result.get('ok') else 1)
