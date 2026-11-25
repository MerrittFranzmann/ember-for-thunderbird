#!/usr/bin/env python3
"""Add quoted-history and invitation examples only to Ember's isolated fixture profile (2831)."""
import json
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import format_datetime
import spark

ME = 'Merritt Franzmann <merritt@spark.test>'
ADA = 'Ada Lovelace <ada@analytical.engineering>'
# The invitations stay upcoming (a past meeting has no Accept/Decline): a week from whenever this runs.
NOW = datetime.now(timezone.utc).replace(microsecond=0)
START = (NOW + timedelta(days=7)).replace(hour=14, minute=0, second=0)
stamp = lambda t: t.strftime('%Y%m%dT%H%M%SZ')

def message(mid, subject, author, body, age, refs=None):
    mail = EmailMessage(policy=SMTP)
    mail['From'] = author
    mail['To'] = ADA if author == ME else ME
    mail['Date'] = format_datetime(datetime.now(timezone.utc) - timedelta(minutes=age))
    mail['Message-ID'] = f'<{mid}@spark-smoke.test>'
    mail['Subject'] = subject
    mail['X-Mozilla-Status'] = '0001'
    if refs:
        mail['References'] = ' '.join(f'<{ref}@spark-smoke.test>' for ref in refs)
        mail['In-Reply-To'] = f'<{refs[-1]}@spark-smoke.test>'
    mail.set_content(body)
    return mail

def main():
    client = spark.connect()
    subject = 'Spark smoke quoted history'
    original = 'The board review is Friday at 10. Please send the deck Thursday afternoon.'
    reply = 'I will send the revised deck by Thursday at 3, with the updated budget.'
    root = message('history-root', subject, ADA, original, 150)
    sent = message('history-reply', subject, ME, reply + '\n\nOn Monday, Ada wrote:\n> ' + original, 140, ['history-root'])
    last = message('history-latest', subject, ADA, 'Perfect. Please include the updated budget slide.\n\nOn Monday, Merritt wrote:\n> ' + reply + '\n>\n> On Monday, Ada wrote:\n>> ' + original, 130, ['history-root', 'history-reply'])
    invite = message('invitation', 'Spark smoke calendar invitation', ADA, 'Please join the board review. The event details are in the invitation.', 120)
    ics = '\r\n'.join(['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Ember Smoke//EN','METHOD:REQUEST','BEGIN:VEVENT','UID:spark-board-review@spark-smoke.test','DTSTAMP:' + stamp(NOW),'DTSTART:' + stamp(START),'DTEND:' + stamp(START + timedelta(hours=1)),'SUMMARY:Board review smoke test','ORGANIZER;CN=Ada Lovelace:mailto:ada@analytical.engineering','ATTENDEE;CN=Merritt;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:merritt@spark.test','LOCATION:Room 4B','DESCRIPTION:Review the deck and budget.','SEQUENCE:0','END:VEVENT','END:VCALENDAR',''])
    invite.add_attachment(ics.encode(), maintype='text', subtype='calendar', filename='board-review.ics', params={'method':'REQUEST'})
    old_pin = message('old-pin', 'Spark smoke older pinned email', ADA, 'This older pinned message must remain available locally beyond ninety days.', 500000)
    old_pin.replace_header('Date', format_datetime(datetime(2025, 1, 15, 12, tzinfo=timezone.utc)))
    old_pin.replace_header('X-Mozilla-Status', '0005')
    # Outlook/Exchange shape: the calendar only inline, as the last multipart/alternative part.
    outlook = message('outlook-invitation', 'Spark smoke Outlook invitation', ADA, 'Agenda to follow.', 110)
    outlook.add_alternative('<p>Agenda to follow.</p>', subtype='html')
    outlook.add_alternative(ics.replace('spark-board-review@', 'spark-outlook-review@').replace('Board review smoke test', 'Outlook review smoke test'), subtype='calendar', params={'method': 'REQUEST'})
    fixtures = [('Inbox', old_pin), ('Inbox', root), ('Sent', sent), ('Inbox', last), ('Inbox', invite), ('Inbox', outlook)]
    result = []
    for folder, mail in fixtures:
        code = '''const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const root = MailServices.accounts.getAccount('account2').incomingServer.rootFolder;
const folder = root.getChildNamed(%s).QueryInterface(Ci.nsIMsgLocalMailFolder);
const mid = %s;
if (folder.msgDatabase.getMsgHdrForMessageID(mid)) return { existing: mid };
const header = folder.addMessage(%s);
return { added: mid, key: header.messageKey };''' % (json.dumps(folder), json.dumps(str(mail['Message-ID']).strip('<>')), json.dumps(mail.as_string()))
        result.append(client.execute(code))
    result.append(client.execute("const {cal}=ChromeUtils.importESModule('resource:///modules/calendar/calUtils.sys.mjs'); const c=cal.manager.getCalendars()[0]; if(c){c.setProperty('disabled',false);c.setProperty('imip.identity.key','id1');c.setProperty('calendar-main-in-composite',true);} return {testCalendarEnabled:!!c};"))
    print(json.dumps(result, indent=2))

if __name__ == '__main__':
    main()
