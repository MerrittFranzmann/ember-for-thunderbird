#!/usr/bin/env python3
"""Heavy, realistic marketing emails (nested tables, inline styles everywhere), isolated profile only (port 2831).

Real newsletters are often 100-300 KB of HTML with thousands of elements; the regular fixtures are small,
so opening cost on real mail is invisible there. Adds "Heavy newsletter NN" messages to the test Inbox.
"""
import json, random
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import format_datetime
import spark

FONTS = ['Helvetica,Arial,sans-serif', "'Segoe UI',Tahoma,sans-serif", 'Georgia,serif', 'Verdana,Geneva,sans-serif']
COLORS = ['#333333', '#555555', '#1a1a1a', '#0b5cad', '#c0392b', '#6b6b6b', '#2d3e50']


def block(rng, n):
    font, color = rng.choice(FONTS), rng.choice(COLORS)
    cells = ''.join(
        f'<td width="50%" valign="top" style="padding:12px 16px;font-family:{font};font-size:14px;line-height:21px;color:{color};">'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:0 0 8px 0;">'
        f'<img src="https://images.example.invalid/{n}-{i}.jpg" width="260" height="140" alt="" style="display:block;border:0;width:100%;height:auto;"></td></tr>'
        f'<tr><td style="font-family:{font};font-size:18px;line-height:24px;font-weight:bold;color:#111111;padding:0 0 6px 0;">'
        f'<a href="https://example.invalid/{n}/{i}" style="color:#111111;text-decoration:none;"><span style="color:#111111;">Story {n}.{i}: what changed this week</span></a></td></tr>'
        f'<tr><td style="font-family:{font};font-size:14px;line-height:21px;color:{color};">'
        + ''.join(f'<span style="font-family:{font};color:{color};">Sentence {k} about the update, with <b>emphasis</b> and a <a href="https://example.invalid/l{k}" style="color:#0b5cad;">link</a>. </span>' for k in range(rng.randint(4, 9)))
        + f'</td></tr><tr><td style="padding:10px 0 0 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
        f'<td bgcolor="#0b5cad" style="border-radius:4px;background:#0b5cad;"><a href="https://example.invalid/cta/{n}/{i}" style="display:inline-block;padding:10px 18px;font-family:{font};font-size:14px;color:#ffffff;text-decoration:none;">Read more</a></td>'
        f'</tr></table></td></tr></table></td>'
        for i in range(2))
    return f'<tr><td style="padding:0 0 12px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;"><tr>{cells}</tr></table></td></tr>'


def newsletter(seed):
    rng = random.Random(seed)
    rows = ''.join(block(rng, n) for n in range(40))
    return ('<!DOCTYPE html><html><head><meta charset="utf-8"><style>@media only screen and (max-width:600px){.wrap{width:100%!important}}'
            'a{color:#0b5cad}.preheader{display:none!important}</style></head>'
            '<body style="margin:0;padding:0;background:#f2f4f7;"><div class="preheader">This week in field notes</div>'
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f2f4f7"><tr><td align="center">'
            '<table class="wrap" role="presentation" width="640" cellpadding="0" cellspacing="0" border="0">'
            f'{rows}<tr><td style="font-family:Arial;font-size:11px;color:#999999;padding:20px;">You are receiving this because you subscribed. <a href="https://example.invalid/u" style="color:#999999;">Unsubscribe</a></td></tr>'
            '</table></td></tr></table></body></html>')


def main():
    client = spark.connect()
    added = 0
    for i in range(1, 6):
        html = newsletter(i)
        mail = EmailMessage(policy=SMTP)
        mail['From'] = 'Weekly Digest <digest@heavy.example>'
        mail['To'] = 'Merritt Franzmann <merritt@spark.test>'
        mail['Date'] = format_datetime(datetime.now(timezone.utc) - timedelta(minutes=30 + i))
        mail['Message-ID'] = f'<heavy-{i}@spark-heavy.test>'
        mail['Subject'] = f'Heavy newsletter {i:02d}'
        mail['List-Unsubscribe'] = '<https://example.invalid/u>'
        mail['X-Mozilla-Status'] = '0001'
        mail.set_content('Plain version of the heavy newsletter.')
        mail.add_alternative(html, subtype='html')
        code = '''const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');const folder=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder);const mid=%s;if(folder.msgDatabase.getMsgHdrForMessageID(mid))return 0;folder.addMessage(%s);return 1;''' % (json.dumps(str(mail['Message-ID']).strip('<>')), json.dumps(mail.as_string()))
        added += client.execute(code)
    print(json.dumps({'added': added, 'htmlKB': round(len(newsletter(1)) / 1024)}))


if __name__ == '__main__':
    main()
