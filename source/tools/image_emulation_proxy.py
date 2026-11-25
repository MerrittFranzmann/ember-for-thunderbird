#!/usr/bin/env python3
"""Loopback proxy that emulates remote email images for a sealed scratch profile. Never forwards anything.

Every HTTP or HTTPS (CONNECT, terminated with a throwaway test CA) request for a non-mail host is answered
locally after a realistic delay with a noise PNG (decode/layout cost like real images). Mail hosts get
their connection dropped. Trust the CA only inside the scratch profile (see --ca-out).
Usage: image_emulation_proxy.py --dir WORKDIR [--port 8766]
"""
import argparse, hashlib, os, random, socket, ssl, struct, subprocess, threading, time, zlib, json

BLOCK = ('outlook.office365.com', 'office365.com', 'outlook.com', 'imap.gmail.com', 'gmail.com', 'googleapis.com', 'google.com', 'microsoftonline.com', 'live.com')
LOCK = threading.Lock()
STATS = {'images': 0, 'blocked': 0, 'hosts': set()}


def noise_png(width, height, seed):
    rng = random.Random(seed)
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    rows = b''.join(b'\x00' + rng.randbytes(width * 3) for _ in range(height))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows, 1)) + chunk(b'IEND', b'')


class Certs:
    def __init__(self, work):
        self.work = work
        self.ca_key, self.ca_pem = os.path.join(work, 'ca.key'), os.path.join(work, 'ca.pem')
        self.leaf_key = os.path.join(work, 'leaf.key')
        if not os.path.exists(self.ca_pem):
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', self.ca_key, '-out', self.ca_pem, '-days', '3',
                            '-subj', '/CN=Ember Perf Emulation CA (scratch only)', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], check=True, capture_output=True)
            subprocess.run(['openssl', 'genrsa', '-out', self.leaf_key, '2048'], check=True, capture_output=True)
        self.contexts = {}
        self.lock = threading.Lock()

    def context(self, host):
        with self.lock:
            if host in self.contexts:
                return self.contexts[host]
            name = hashlib.sha1(host.encode()).hexdigest()[:16]
            csr, crt, ext = (os.path.join(self.work, f'{name}.{x}') for x in ('csr', 'crt', 'ext'))
            open(ext, 'w').write(f'subjectAltName=DNS:{host}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n')
            subprocess.run(['openssl', 'req', '-new', '-key', self.leaf_key, '-out', csr, '-subj', f'/CN={host}'], check=True, capture_output=True)
            subprocess.run(['openssl', 'x509', '-req', '-in', csr, '-CA', self.ca_pem, '-CAkey', self.ca_key, '-CAcreateserial', '-out', crt, '-days', '2', '-extfile', ext], check=True, capture_output=True)
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(crt, self.leaf_key)
            self.contexts[host] = ctx
            return ctx


IMAGES = []


def read_head(sock):
    data = b''
    while b'\r\n\r\n' not in data:
        chunk = sock.recv(65536)
        if not chunk:
            return None, b''
        data += chunk
        if len(data) > 1 << 20:
            return None, b''
    head, _, rest = data.partition(b'\r\n\r\n')
    return head.decode('latin1'), rest


def serve_http(sock, host):
    while True:
        head, _ = read_head(sock)
        if not head:
            return
        line = head.split('\r\n', 1)[0]
        parts = line.split(' ')
        path = parts[1] if len(parts) > 1 else '/'
        seed = int(hashlib.sha1((host + path).encode()).hexdigest()[:8], 16)
        rng = random.Random(seed)
        time.sleep(rng.choice([0.08, 0.15, 0.25, 0.4, 0.7, 1.1]))
        body = IMAGES[seed % len(IMAGES)]
        with LOCK:
            STATS['images'] += 1
        sock.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nCache-Control: max-age=3600\r\nContent-Length: ' + str(len(body)).encode() + b'\r\nConnection: keep-alive\r\n\r\n' + body)


def handle(client, certs):
    try:
        head, _ = read_head(client)
        if not head:
            return
        method, target = head.split(' ')[:2]
        if method == 'CONNECT':
            host = target.rsplit(':', 1)[0]
            if host.endswith(BLOCK):
                with LOCK:
                    STATS['blocked'] += 1
                return
            with LOCK:
                STATS['hosts'].add(host)
            client.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
            tls = certs.context(host).wrap_socket(client, server_side=True)
            serve_http(tls, host)
        else:
            host = target.split('/')[2] if '://' in target else ''
            if host.endswith(BLOCK):
                return
            # Re-inject the head we already consumed by answering it directly.
            seed = int(hashlib.sha1(target.encode()).hexdigest()[:8], 16)
            time.sleep(random.Random(seed).choice([0.08, 0.15, 0.25, 0.4, 0.7]))
            body = IMAGES[seed % len(IMAGES)]
            with LOCK:
                STATS['images'] += 1
            client.sendall(b'HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nCache-Control: max-age=3600\r\nContent-Length: ' + str(len(body)).encode() + b'\r\nConnection: close\r\n\r\n' + body)
    except (OSError, ssl.SSLError, ValueError):
        pass
    finally:
        try:
            client.close()
        except OSError:
            pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dir', required=True)
    parser.add_argument('--port', type=int, default=8766)
    args = parser.parse_args()
    os.makedirs(args.dir, exist_ok=True)
    certs = Certs(args.dir)
    for i, (w, h) in enumerate([(600, 300), (600, 200), (300, 300), (640, 360), (120, 40), (1, 1)]):
        IMAGES.append(noise_png(w, h, i))
    server = socket.socket()
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('127.0.0.1', args.port))
    server.listen(256)
    def report():
        while True:
            time.sleep(5)
            with LOCK:
                open(os.path.join(args.dir, 'stats.json'), 'w').write(json.dumps({'images': STATS['images'], 'blocked': STATS['blocked'], 'hosts': len(STATS['hosts'])}))
    threading.Thread(target=report, daemon=True).start()
    print('ready', args.port, certs.ca_pem, flush=True)
    while True:
        client, _ = server.accept()
        threading.Thread(target=handle, args=(client, certs), daemon=True).start()


if __name__ == '__main__':
    main()
