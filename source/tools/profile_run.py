#!/usr/bin/env python3
"""Record a Gecko profile (all processes' main threads) while a page probe runs. Isolated/scratch profiles only."""
import argparse, json
import spark
from run_probe import run
parser = argparse.ArgumentParser()
parser.add_argument('probe'); parser.add_argument('--config', default='{}'); parser.add_argument('--out', required=True)
args = parser.parse_args()
client = spark.connect()
spark.chrome_async(client, "Services.profiler.StartProfiler(4000000, 1, ['js','stackwalk','cpu','markersallthreads'], ['GeckoMain','Renderer','Compositor','StyleThread','ImgDecoder']); await new Promise(r=>setTimeout(r,500)); return true;")
result = run(client, args.probe, args.config)
saved = spark.chrome_async(client, "const p = await Services.profiler.getProfileDataAsync(); Services.profiler.StopProfiler(); await IOUtils.writeJSON(%s, p); return true;" % json.dumps(args.out))
print(json.dumps(result)[:3000]); print('profile saved', saved)
