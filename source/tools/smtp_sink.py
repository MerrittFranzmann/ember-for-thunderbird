#!/usr/bin/env python3
"""Tiny SMTP sink for testing sends from the test profile.

Accepts every message on 127.0.0.1:2525 (no auth, no TLS) and writes each one
to <outdir>/<n>.eml. Standard library only.

Usage: smtp_sink.py [outdir] [port]
"""
import os
import socketserver
import sys
import time

OUT = sys.argv[1] if len(sys.argv) > 1 else "/private/tmp/claude-503/spark-sent"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 2525
os.makedirs(OUT, exist_ok=True)


class Handler(socketserver.StreamRequestHandler):
    def send(self, line):
        self.wfile.write((line + "\r\n").encode())
        self.wfile.flush()

    def handle(self):
        self.send("220 spark-sink ESMTP ready")
        rcpt, mail_from = [], None
        while True:
            raw = self.rfile.readline()
            if not raw:
                return
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            cmd = line[:4].upper()
            if cmd in ("EHLO", "HELO"):
                self.wfile.write(b"250-spark-sink\r\n250-8BITMIME\r\n250-SIZE 52428800\r\n250 SMTPUTF8\r\n")
                self.wfile.flush()
            elif cmd == "MAIL":
                mail_from, rcpt = line[10:].strip(), []
                self.send("250 OK")
            elif cmd == "RCPT":
                rcpt.append(line[8:].strip())
                self.send("250 OK")
            elif cmd == "DATA":
                self.send("354 End data with <CR><LF>.<CR><LF>")
                data = []
                while True:
                    l = self.rfile.readline()
                    if not l or l in (b".\r\n", b".\n"):
                        break
                    if l.startswith(b".."):
                        l = l[1:]
                    data.append(l)
                name = os.path.join(OUT, f"{int(time.time() * 1000)}.eml")
                with open(name, "wb") as f:
                    f.write(f"X-Sink-From: {mail_from}\r\nX-Sink-Rcpt: {', '.join(rcpt)}\r\n".encode())
                    f.write(b"".join(data))
                print("received", name, flush=True)
                self.send("250 OK queued")
            elif cmd == "RSET":
                self.send("250 OK")
            elif cmd == "NOOP":
                self.send("250 OK")
            elif cmd == "QUIT":
                self.send("221 Bye")
                return
            else:
                self.send("502 Command not implemented")


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("127.0.0.1", PORT), Handler) as s:
        print(f"SMTP sink on 127.0.0.1:{PORT} -> {OUT}", flush=True)
        s.serve_forever()
