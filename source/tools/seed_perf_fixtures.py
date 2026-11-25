#!/usr/bin/env python3
"""Reader-performance fixtures, only in the isolated Thunderbird profile (port 2831). Never sends mail.

Newsletters reference remote images on tools/slow_image_server.py (loopback, with latency),
"inline" messages carry CID images, and a six-message HTML thread exercises conversation layout.
"""
import json, os, random, struct, zlib
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import format_datetime
from datetime import datetime, timedelta, timezone
import spark

ME = 'Merritt Franzmann <merritt@spark.test>'
HOST = 'http://127.0.0.1:8765'


def png_noise(width, height, seed):
    rng = random.Random(seed)
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    rows = b''.join(b'\x00' + bytes(rng.randrange(256) for _ in range(width * 3)) for _ in range(height))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')


def base(mid, subject, author, age, refs=None):
    mail = EmailMessage(policy=SMTP)
    mail['From'] = author
    mail['To'] = ME
    mail['Date'] = format_datetime(datetime.now(timezone.utc) - timedelta(minutes=age))
    mail['Message-ID'] = f'<{mid}@spark-perf.test>'
    mail['Subject'] = subject
    mail['X-Mozilla-Status'] = '0001'
    if refs:
        mail['References'] = ' '.join(f'<{r}@spark-perf.test>' for r in refs)
        mail['In-Reply-To'] = f'<{refs[-1]}@spark-perf.test>'
    return mail


def newsletter(n):
    rng = random.Random(n)
    blocks = [f'<tr><td><img src="{HOST}/img/n{n}-hero.png?d=900&w=600&h=260" width="600" alt=""></td></tr>']
    for s in range(22):
        sized = s % 3 != 0  # a third have no width/height attributes, like much real marketing mail
        dims = 'width="600" height="220"' if sized else ''
        blocks.append(f'<tr><td style="padding:18px 24px"><h2 style="font:700 20px Georgia,serif">Section {s + 1}: field notes and updates</h2>'
                      f'<img src="{HOST}/img/n{n}-s{s}.png?d={rng.choice([150, 300, 600, 1200])}&w=600&h=220" {dims} style="display:block;max-width:100%" alt="">'
                      f'<p style="font:15px/1.6 Arial">' + ' '.join(['Partners reported steady progress across every region this month, with new volunteers joining the program.'] * 4) + '</p>'
                      f'<a href="https://example.org/story/{n}/{s}" style="display:inline-block;padding:10px 18px;background:#0a66d8;color:#fff;border-radius:6px">Read the story</a></td></tr>')
    blocks.append(f'<tr><td><img src="{HOST}/img/n{n}-pixel.png?d=2500&w=1&h=1" width="1" height="1" alt=""></td></tr>')
    html = ('<html><head><style>.wrap{background:#f3f4f6}td{vertical-align:top}</style></head><body class="wrap">'
            '<table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" style="background:#fff">' + ''.join(blocks) + '</table></body></html>')
    mail = base(f'newsletter-{n}', f'Perf newsletter {n:02}', 'Field Notes <news@fieldnotes.example>', 30 + n)
    mail.set_content('Plain version of the newsletter.')
    mail.add_alternative(html, subtype='html')
    return mail


def inline(n):
    mail = base(f'inline-{n}', f'Perf inline images {n:02}', 'Grace Hopper <grace@navy.test>', 60 + n)
    mail.set_content('Inline image test.')
    images = [png_noise(360, 240, n * 10 + i) for i in range(5)]
    html = '<html><body><p>Here are the photos from the site visit.</p>' + ''.join(f'<p>Photo {i + 1}</p><img src="cid:photo{n}-{i}@perf">' for i in range(5)) + '<p>Thanks!</p></body></html>'
    mail.add_alternative(html, subtype='html')
    related = mail.get_payload()[1]
    for i, data in enumerate(images):
        related.add_related(data, maintype='image', subtype='png', cid=f'<photo{n}-{i}@perf>', filename=f'photo{i + 1}.png')
    return mail


def thread():
    mails, refs = [], []
    people = ['Ada Lovelace <ada@analytical.engineering>', ME, 'Grace Hopper <grace@navy.test>']
    quote = ''
    for i in range(6):
        mid = f'thread-{i}'
        body = f'<p>Update {i + 1} on the budget review.</p>' + '<p>' + ' '.join(['We reviewed the line items and agreed on the next steps for the quarter.'] * 6) + '</p>'
        html = f'<html><body>{body}<div class="gmail_quote"><blockquote type="cite">{quote}</blockquote></div></body></html>' if quote else f'<html><body>{body}</body></html>'
        mail = base(mid, 'Perf long thread', people[i % 3], 200 - i * 10, refs[:] or None)
        mail.set_content('Update.')
        mail.add_alternative(html, subtype='html')
        mails.append(mail)
        refs.append(mid)
        quote = body + quote
    return mails


def main():
    client = spark.connect()
    fixtures = [newsletter(n) for n in range(1, 7)] + [inline(n) for n in range(1, 4)] + thread()
    result = []
    for mail in fixtures:
        code = '''const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');const folder=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder);const mid=%s;if(folder.msgDatabase.getMsgHdrForMessageID(mid))return {existing:mid};const header=folder.addMessage(%s);return {added:mid,key:header.messageKey};''' % (json.dumps(str(mail['Message-ID']).strip('<>')), json.dumps(mail.as_string()))
        result.append(client.execute(code))
    print(json.dumps({'added': sum('added' in r for r in result), 'existing': sum('existing' in r for r in result)}))


if __name__ == '__main__':
    main()
