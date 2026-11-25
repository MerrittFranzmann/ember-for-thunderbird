#!/usr/bin/env python3
"""Summarize long busy stretches on main threads of a raw Gecko profile (from tools/profile_run.py).

For each process main thread, finds consecutive CPU-busy samples lasting >= --min ms and prints the most
frequent inclusive frames (JS functions and Gecko labels) inside them.
"""
import argparse, collections, json, re

parser = argparse.ArgumentParser()
parser.add_argument('profile')
parser.add_argument('--min', type=float, default=50)
parser.add_argument('--top', type=int, default=25)
parser.add_argument('--process', default='')
args = parser.parse_args()
root = json.load(open(args.profile))


def threads(node, proc=''):
    for t in node.get('threads', []):
        yield proc or node.get('meta', {}).get('processType'), t
    for p in node.get('processes', []):
        yield from threads(p, '')


def col(table, name):
    return table['schema'][name] if isinstance(table['schema'], dict) else table['schema'].index(name)


INTERESTING = re.compile(r'moz-extension|Reflow|Styles|Layout|Paint|DisplayList|Rasterize|GC|CC|Parse|Script|IPC|structured|Clone|Image|Decode|setAttribute|innerHTML|ResizeObserver|IndexedDB|EventDispatcher|PresShell|RefreshDriver|(\w+\.(?:mjs|js))', re.I)

for ptype, t in threads(root):
    if t.get('name') != 'GeckoMain':
        continue
    strings = t['stringTable']
    samples, stacks, frames = t['samples'], t['stackTable'], t['frameTable']
    s_stack, s_time = col(samples, 'stack'), col(samples, 'time')
    s_cpu = col(samples, 'threadCPUDelta') if 'threadCPUDelta' in (samples['schema'] if isinstance(samples['schema'], dict) else samples['schema']) else None
    st_prefix, st_frame = col(stacks, 'prefix'), col(stacks, 'frame')
    f_loc = col(frames, 'location')
    label = f"{t.get('processName') or ptype} pid={t.get('pid')}"
    if args.process and args.process not in label:
        continue
    data = samples['data']
    def stack_frames(idx):
        out = []
        while idx is not None:
            row = stacks['data'][idx]
            out.append(strings[frames['data'][row[st_frame]][f_loc]])
            idx = row[st_prefix]
        return out
    runs, current = [], []
    for row in data:
        busy = row[s_stack] is not None and (s_cpu is None or len(row) <= s_cpu or (row[s_cpu] or 0) > 300)
        if busy:
            current.append(row)
        elif current:
            runs.append(current); current = []
    if current:
        runs.append(current)
    long_runs = [r for r in runs if r[-1][s_time] - r[0][s_time] >= args.min]
    if not long_runs:
        continue
    print(f'\n=== {label}: {len(long_runs)} busy stretches >= {args.min:.0f} ms; longest {max(r[-1][s_time]-r[0][s_time] for r in long_runs):.0f} ms')
    total = collections.Counter()
    for r in sorted(long_runs, key=lambda r: r[0][s_time]):
        counts = collections.Counter()
        for row in r:
            seen = set()
            for f in stack_frames(row[s_stack]):
                if f in seen or not INTERESTING.search(f):
                    continue
                seen.add(f); counts[f] += 1
        total.update(counts)
        dur = r[-1][s_time] - r[0][s_time]
        print(f'-- {dur:.0f} ms at t={r[0][s_time]:.0f} ({len(r)} samples): ' + ' | '.join(f'{n}x {f[:90]}' for f, n in counts.most_common(8)))
    print(f'-- totals across stretches:')
    for f, n in total.most_common(args.top):
        print(f'   {n:6d}  {f[:150]}')
