#!/usr/bin/env python3
"""Loopback-only image host for reader performance tests (remote images with real latency).

GET /img/<name>.png?d=<ms>&w=<px>&h=<px> waits d ms, then returns a solid PNG.
GET /stats returns {"requests": n, "paths": {...}}; GET /reset clears the counters.
"""
import argparse, json, struct, threading, time, zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

LOCK = threading.Lock()
COUNTS: dict[str, int] = {}


def png(width, height, seed):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    color = bytes(((seed * 53) % 200 + 30, (seed * 97) % 200 + 30, (seed * 31) % 200 + 30))
    row = b'\x00' + color * width
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(row * height)) + chunk(b'IEND', b'')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, body, kind):
        self.send_response(status)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == '/stats':
            with LOCK:
                return self.reply(200, json.dumps({'requests': sum(COUNTS.values()), 'paths': COUNTS}).encode(), 'application/json')
        if url.path == '/reset':
            with LOCK:
                COUNTS.clear()
            return self.reply(200, b'{}', 'application/json')
        if not url.path.startswith('/img/'):
            return self.reply(404, b'', 'text/plain')
        with LOCK:
            COUNTS[url.path] = COUNTS.get(url.path, 0) + 1
        q = parse_qs(url.query)
        time.sleep(int(q.get('d', ['0'])[0]) / 1000)
        seed = sum(url.path.encode())
        self.reply(200, png(int(q.get('w', ['600'])[0]), int(q.get('h', ['240'])[0]), seed), 'image/png')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
