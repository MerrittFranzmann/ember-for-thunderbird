#!/usr/bin/env python3
"""Email-formatting fixtures (Spark-style typography and dark mode), isolated profile only (port 2831).

One message per dark-mode rule: plain Gmail-style HTML (adapt), Outlook/Word HTML (paper),
an email that declares its own dark mode (native), and a coloured newsletter (adapt).
"""
import json
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import format_datetime
import spark

ME = 'Merritt Franzmann <merritt@spark.test>'

GMAIL = '<div dir="ltr">Hi Merritt,<div><br></div><div>Thanks for the update on the budget review. Here is the <a href="https://example.org/plan">plan</a> and a <b>bold</b> note.</div><div><br></div><div>Best,<br>Ada</div></div>'
OUTLOOK = '''<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><meta http-equiv="X-UA-Compatible" content="IE=edge"><style>p.MsoNormal{margin:0in;font-size:11.0pt;font-family:"Calibri",sans-serif;}</style></head>
<body lang="EN-US"><div class="WordSection1"><p class="MsoNormal">Hello team,</p><p class="MsoNormal">&nbsp;</p><p class="MsoNormal">Please find the agenda for Thursday attached. <span style="color:#1F497D">Coloured Outlook text.</span></p><p class="MsoNormal">&nbsp;</p><p class="MsoNormal">Grace</p></div></body></html>'''
NATIVE = '''<html><head><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><style>
body{background:#ffffff;color:#222}.card{background:#f3f4f6;padding:16px;border-radius:8px}
@media (prefers-color-scheme: dark){body{background:#101418!important;color:#e6e6e6!important}.card{background:#1d242c!important}}
</style></head><body><div class="card"><h2>Product update</h2><p>This email ships its own dark mode.</p></div></body></html>'''
GMAIL_STYLED = '<div dir="ltr"><div class="gmail_default" style="font-family:arial,helvetica,sans-serif;font-size:small;color:#444444">Hi Merritt, here are the notes in my default Gmail font.</div><div class="gmail_default" style="font-family:verdana,sans-serif;font-size:13px;color:#ff0000">Important: this line is red on purpose.</div><br><table><tr><td style="font-family:Georgia,serif;font-size:12px;color:#555">Ada Lovelace | Analytical Engines</td></tr></table></div>'
NEWSLETTER = '''<html><body style="background:#eef1f5"><table width="600" align="center" style="background:#ffffff"><tr><td style="padding:24px;font-family:Georgia,serif;color:#333333">
<h1 style="color:#111">Weekly digest</h1><p>Body copy in dark grey on white.</p>
<p style="background:#fff4d6;color:#7a4b00;padding:8px">Highlighted note on a pale yellow box.</p>
<p><a href="https://example.org/more" style="color:#0a58ca">Read more</a> · <span style="color:#c0392b">red accent</span></p>
<table width="100%"><tr><td style="background:#1a73e8;color:#ffffff;padding:10px;text-align:center">White on blue button</td></tr></table>
</td></tr></table></body></html>'''


def message(mid, subject, author, html, age):
    mail = EmailMessage(policy=SMTP)
    mail['From'] = author
    mail['To'] = ME
    mail['Date'] = format_datetime(datetime.now(timezone.utc) - timedelta(minutes=age))
    mail['Message-ID'] = f'<{mid}@spark-format.test>'
    mail['Subject'] = subject
    mail['X-Mozilla-Status'] = '0001'
    mail.set_content('Plain version.')
    mail.add_alternative(html, subtype='html')
    return mail


def main():
    client = spark.connect()
    fixtures = [
        message('format-gmail', 'Format: plain Gmail reply', 'Ada Lovelace <ada@analytical.engineering>', GMAIL, 5),
        message('format-outlook', 'Format: Outlook agenda', 'Grace Hopper <grace@navy.test>', OUTLOOK, 6),
        message('format-native', 'Format: designed dark mode', 'Product <news@product.example>', NATIVE, 7),
        message('format-gmail-styled', 'Format: styled Gmail reply', 'Ada Lovelace <ada@analytical.engineering>', GMAIL_STYLED, 4),
        message('format-newsletter', 'Format: coloured newsletter', 'Digest <digest@weekly.example>', NEWSLETTER, 8),
    ]
    result = []
    for mail in fixtures:
        code = '''const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');const folder=MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder);const mid=%s;if(folder.msgDatabase.getMsgHdrForMessageID(mid))return {existing:mid};const header=folder.addMessage(%s);return {added:mid,key:header.messageKey};''' % (json.dumps(str(mail['Message-ID']).strip('<>')), json.dumps(mail.as_string()))
        result.append(client.execute(code))
    print(json.dumps({'added': sum('added' in r for r in result), 'existing': sum('existing' in r for r in result)}))


if __name__ == '__main__':
    main()
