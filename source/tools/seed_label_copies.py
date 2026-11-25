#!/usr/bin/env python3
"""Gmail-style label copies, isolated profile only (port 2831): one pinned notification email stored in both
the test Inbox and a "Starred" folder with the same Message-ID, as Gmail keeps it in Inbox, All Mail and
Starred. Before 0.1.64 the two copies became two conversations with the same key, which stopped the Pins
list from rendering. Skips copies already there."""
import json
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import format_datetime
import spark

MID = 'label-copy-statement@spark-copies.test'


def mail():
    m = EmailMessage(policy=SMTP)
    m['From'] = 'Bank Alerts <noreply@bank.example>'
    m['To'] = 'Merritt Franzmann <merritt@spark.test>'
    m['Date'] = format_datetime(datetime.now(timezone.utc) - timedelta(minutes=20))
    m['Message-ID'] = f'<{MID}>'
    m['Subject'] = 'Copies: your statement is ready'
    m['X-Mozilla-Status'] = '0005'  # read + flagged (pinned)
    m.set_content('Your monthly statement is ready.')
    return m


def main():
    client = spark.connect()
    code = '''const {MailServices}=ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const root=MailServices.accounts.getAccount('account2').incomingServer.rootFolder;
if(!root.containsChildNamed('Starred'))root.createSubfolder('Starred',null);
let added=0;
for(const name of ['Inbox','Starred']){
  const folder=root.getChildNamed(name).QueryInterface(Ci.nsIMsgLocalMailFolder);
  if(folder.msgDatabase.getMsgHdrForMessageID(%s))continue;
  folder.addMessage(%s);added++;
}
return added;''' % (json.dumps(MID), json.dumps(mail().as_string()))
    print(json.dumps({'added': client.execute(code)}))


if __name__ == '__main__':
    main()
