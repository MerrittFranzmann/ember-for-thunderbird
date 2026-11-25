#!/usr/bin/env python3
"""A 60-message reply chain (References/In-Reply-To, alternating senders, quoted history), isolated profile
only (port 2831). Adds "Long thread: venue planning" messages to the test Inbox (skips existing ones)."""
import json
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import format_datetime
import spark

ME = 'Merritt Franzmann <merritt@spark.test>'
ADA = 'Ada Lovelace <ada@analytical.engineering>'
N = 60


def main():
    client = spark.connect()
    added, ids = 0, []
    start = datetime.now(timezone.utc) - timedelta(hours=N * 2)
    for i in range(N):
        mid = f'long-thread-{i:02d}@spark-long.test'
        m = EmailMessage(policy=SMTP)
        m['From'], m['To'] = (ADA, ME) if i % 2 == 0 else (ME, ADA)
        m['Date'] = format_datetime(start + timedelta(hours=2 * i))
        m['Message-ID'] = f'<{mid}>'
        m['Subject'] = 'Long thread: venue planning' if i == 0 else 'Re: Long thread: venue planning'
        if ids:
            m['In-Reply-To'] = f'<{ids[-1]}>'
            m['References'] = ' '.join(f'<{x}>' for x in ids[-20:])
        m['X-Mozilla-Status'] = '0001'
        quoted = '\n'.join(f'> Message {j}: notes on the venue, catering and timing.' for j in range(max(0, i - 3), i))
        m.set_content(f'Message {i}: here are my thoughts on the venue, catering and timing for the event.\n\n{quoted}\n')
        m.add_alternative(f'<p>Message {i}: here are my thoughts on the <b>venue</b>, catering and timing for the event.</p>'
                          + (f'<blockquote type="cite">{quoted.replace(chr(10), "<br>")}</blockquote>' if quoted else ''), subtype='html')
        ids.append(mid)
        code = '''const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');const folder=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder);const mid=%s;if(folder.msgDatabase.getMsgHdrForMessageID(mid))return 0;folder.addMessage(%s);return 1;''' % (json.dumps(mid), json.dumps(m.as_string()))
        added += client.execute(code)
    print(json.dumps({'added': added}))


if __name__ == '__main__':
    main()
