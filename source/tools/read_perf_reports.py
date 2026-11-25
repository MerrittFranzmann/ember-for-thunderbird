#!/usr/bin/env python3
"""Read Ember performance reports (Ctrl+Shift+L) straight from a Thunderbird profile, read-only.

Copies the extension's storage.local IndexedDB to a temporary folder, decodes Gecko's Snappy-compressed
structured-clone records, and writes each report as JSON. Works while Thunderbird is running.
Usage: read_perf_reports.py OUT_DIR [--profile PATH]  (default: the default-release profile)
"""
import argparse, glob, json, os, re, shutil, sqlite3, struct, tempfile

ADDON = 'thunderbird-spark@merrittfranzmann'


def varint(data, i=0):
    value = shift = 0
    while True:
        byte = data[i]; i += 1
        value |= (byte & 0x7f) << shift; shift += 7
        if not byte & 0x80:
            return value, i


def snappy_raw(data):
    size, i = varint(data)
    out = bytearray()
    while i < len(data):
        tag = data[i]; i += 1
        kind = tag & 3
        if kind == 0:
            length = tag >> 2
            if length >= 60:
                extra = length - 59
                length = int.from_bytes(data[i:i + extra], 'little'); i += extra
            length += 1
            out += data[i:i + length]; i += length
            continue
        if kind == 1:
            length = ((tag >> 2) & 7) + 4; offset = ((tag >> 5) << 8) | data[i]; i += 1
        elif kind == 2:
            length = (tag >> 2) + 1; offset = int.from_bytes(data[i:i + 2], 'little'); i += 2
        else:
            length = (tag >> 2) + 1; offset = int.from_bytes(data[i:i + 4], 'little'); i += 4
        start = len(out) - offset
        for k in range(length):
            out.append(out[start + k])
    assert len(out) == size, 'snappy size mismatch'
    return bytes(out)


def snappy_framed(data):
    out, i = bytearray(), 0
    while i + 4 <= len(data):
        kind = data[i]; length = int.from_bytes(data[i + 1:i + 4], 'little'); chunk = data[i + 4:i + 4 + length]; i += 4 + length
        if kind == 0x00:
            out += snappy_raw(chunk[4:])
        elif kind == 0x01:
            out += chunk[4:]
    return bytes(out)


def clone_strings(buffer):
    """Strings from a SpiderMonkey structured-clone buffer (enough for arrays of JSON strings)."""
    i, found = 0, []
    while i + 8 <= len(buffer):
        data, tag = struct.unpack_from('<II', buffer, i); i += 8
        if tag == 0xFFFF0004:
            latin1 = bool(data & 0x80000000); length = data & 0x7FFFFFFF
            size = length if latin1 else length * 2
            raw = buffer[i:i + size]; i += (size + 7) & ~7
            found.append(raw.decode('latin1') if latin1 else raw.decode('utf-16-le'))
    return found


def profile_default():
    root = os.path.expanduser('~/Library/Thunderbird')
    ini = open(os.path.join(root, 'profiles.ini')).read()
    match = re.search(r'Default=(Profiles/[^\n]*default-release)', ini) or re.search(r'Path=(Profiles/[^\n]*default-release)', ini)
    return os.path.join(root, match.group(1))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('out')
    parser.add_argument('--profile', default=None)
    args = parser.parse_args()
    profile = args.profile or profile_default()
    prefs = open(os.path.join(profile, 'prefs.js')).read()
    uuids = json.loads(re.search(r'extensions\.webextensions\.uuids", "(.*)"\);', prefs).group(1).encode().decode('unicode_escape'))
    base = glob.glob(os.path.join(profile, 'storage', 'default', f"moz-extension+++{uuids[ADDON]}^userContextId=*", 'idb'))
    os.makedirs(args.out, exist_ok=True)
    reports = []
    with tempfile.TemporaryDirectory() as work:
        for idb in base:
            for db in glob.glob(os.path.join(idb, '*.sqlite')):
                for suffix in ('', '-wal'):
                    if os.path.exists(db + suffix):
                        shutil.copy2(db + suffix, os.path.join(work, 'c.sqlite' + suffix))
                files = db[:-len('.sqlite')] + '.files'
                rows = sqlite3.connect(os.path.join(work, 'c.sqlite')).execute('select data, file_ids from object_data').fetchall()
                for data, file_ids in rows:
                    buffers = []
                    if isinstance(data, bytes) and data:
                        try: buffers.append(snappy_raw(data))
                        except Exception: pass
                    for token in (file_ids or '').split():
                        path = os.path.join(files, token.lstrip('.'))
                        if os.path.exists(path):
                            raw = open(path, 'rb').read()
                            try: buffers.append(snappy_framed(raw) if raw[:1] == b'\xff' else raw)
                            except Exception: buffers.append(raw)
                    for buffer in buffers:
                        reports += [s for s in clone_strings(buffer) if s.startswith('{"format":"spark-performance-report')]
    for n, text in enumerate(reports, 1):
        report = json.loads(text)
        name = os.path.join(args.out, f"report-{n:02d}-{report['createdAt'].replace(':', '-')}.json")
        open(name, 'w').write(json.dumps(report, indent=1))
        worst = report.get('worst', [])[:3]
        print(name, '| trigger', report['environment'].get('trigger'), '| worst:', ', '.join(f"{w['moment']['kind']} {w['moment'].get('ms')}ms" for w in worst) or 'none')
    if not reports:
        print('No performance reports found in', profile)


if __name__ == '__main__':
    main()
