#!/usr/bin/env python3
"""Layout edge cases from real mail, isolated profile only (port 2831): very long subject and sender, no
subject, emoji, right-to-left text, an unbroken URL, a fixed-width wide table, many recipients, many
attachments. Adds "Edge: ..." messages to the test Inbox (skips ones already there)."""
import json
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import format_datetime
import spark

ME = 'Merritt Franzmann <merritt@spark.test>'
LONG_URL = 'https://example.invalid/track?' + '&'.join(f'param{i}=value{i}abcdefghij' for i in range(25))


def mail(mid, subject, author, age, html=None, text='Plain version.', to=ME, attachments=0):
    m = EmailMessage(policy=SMTP)
    m['From'] = author
    m['To'] = to
    m['Date'] = format_datetime(datetime.now(timezone.utc) - timedelta(minutes=age))
    m['Message-ID'] = f'<{mid}@spark-edge.test>'
    if subject is not None:
        m['Subject'] = subject
    m['X-Mozilla-Status'] = '0001'
    m.set_content(text)
    if html:
        m.add_alternative(html, subtype='html')
    for i in range(attachments):
        m.add_attachment(f'File {i}\n'.encode(), maintype='application', subtype='octet-stream', filename=f'quarterly-report-section-{i:02d}-final-version.xlsx')
    return m


def main():
    client = spark.connect()
    many = ', '.join(f'Person {i} <person{i}@example.org>' for i in range(30))
    fixtures = [
        mail('edge-long-subject', 'Edge: ' + 'A very long subject line that keeps going because some senders write whole sentences in the subject field ' * 3, 'Ada Lovelace <ada@analytical.engineering>', 2),
        mail('edge-long-sender', 'Edge: long sender name', '"Dr. Bartholomew Montgomery-Fitzgerald III, Director of Strategic Partnerships 🚀✨" <bart@partners.example>', 3),
        mail('edge-no-subject', None, 'Grace Hopper <grace@navy.test>', 4, text='This message has no subject at all.'),
        mail('edge-rtl', 'Edge: right-to-left text', 'نور الهدى <noor@example.org>', 5,
             html='<div dir="rtl" style="font-family:Arial">مرحبا ميريت، هذه رسالة باللغة العربية للتأكد من أن النص يظهر من اليمين إلى اليسار بشكل صحيح.<br><br>שלום, זו שורה בעברית.</div>'),
        mail('edge-long-url', 'Edge: unbroken URL', 'Tracker <noreply@tracker.example>', 6,
             html=f'<p>Click this link:</p><p>{LONG_URL}</p><p><a href="{LONG_URL}">{LONG_URL}</a></p>', text=LONG_URL),
        mail('edge-wide-table', 'Edge: fixed 1200px table', 'Reports <reports@corp.example>', 7,
             html='<table width="1200" style="width:1200px;border-collapse:collapse" border="1"><tr>' + ''.join(f'<td style="padding:8px;white-space:nowrap">Column {i} heading</td>' for i in range(12)) + '</tr><tr>' + ''.join(f'<td style="padding:8px">{i * 1234:,}</td>' for i in range(12)) + '</tr></table>'),
        mail('edge-many-recipients', 'Edge: thirty recipients', 'Ada Lovelace <ada@analytical.engineering>', 8, to=many + ', ' + ME),
        mail('edge-many-attachments', 'Edge: twelve attachments', 'Grace Hopper <grace@navy.test>', 9, attachments=12),
        mail('edge-emoji', 'Edge: 🎉 Launch day! 🚀 Emoji subject ✅', 'Product Team 🛠️ <team@product.example>', 10, html='<p>We did it 🎉🎉🎉 — thanks everyone! 👏</p>'),
    ]
    added = 0
    for m in fixtures:
        code = '''const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');const folder=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder);const mid=%s;if(folder.msgDatabase.getMsgHdrForMessageID(mid))return 0;folder.addMessage(%s);return 1;''' % (json.dumps(str(m['Message-ID']).strip('<>')), json.dumps(m.as_string()))
        added += client.execute(code)
    print(json.dumps({'added': added}))


if __name__ == '__main__':
    main()
