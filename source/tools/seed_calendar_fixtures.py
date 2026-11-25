#!/usr/bin/env python3
"""Calendar examples for Ember's invitation card, only in the isolated fixture profile (2831).

Outlook-shaped invitations (calendar inline only) relative to now: an upcoming one with a Zoom link, a past one,
an old version superseded by a newer one, a weekly series that is still running, a cancellation, and three
people's answers to one meeting. Idempotent: existing Message-IDs are skipped.
"""
import json
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import format_datetime
import spark

ME = 'Merritt Franzmann <merritt@spark.test>'
NOW = datetime.now(timezone.utc).replace(second=0, microsecond=0)
stamp = lambda t: t.strftime('%Y%m%dT%H%M%SZ')

def ics(method, uid, title, start, minutes=30, sequence=0, extra=(), organizer=('Ada Lovelace', 'ada@analytical.engineering'), attendee=None):
    lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:Microsoft Exchange Server 2010', f'METHOD:{method}', 'BEGIN:VEVENT',
             f'UID:{uid}', f'DTSTAMP:{stamp(NOW - timedelta(minutes=sequence))}', f'DTSTART:{stamp(start)}', f'DTEND:{stamp(start + timedelta(minutes=minutes))}',
             f'SUMMARY:{title}', f'ORGANIZER;CN={organizer[0]}:mailto:{organizer[1]}',
             attendee or 'ATTENDEE;CN=Merritt;RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:merritt@spark.test',
             f'SEQUENCE:{sequence}', 'STATUS:CANCELLED' if method == 'CANCEL' else 'STATUS:CONFIRMED', *extra, 'END:VEVENT', 'END:VCALENDAR', '']
    return '\r\n'.join(lines)

def mail(mid, subject, author, text, received, calendar, method):
    message = EmailMessage(policy=SMTP)
    message['From'] = author
    message['To'] = ME
    message['Date'] = format_datetime(received)
    message['Message-ID'] = f'<{mid}@spark-calendar.test>'
    message['Subject'] = subject
    message['X-Mozilla-Status'] = '0000'
    message.set_content(text)
    message.add_alternative(f'<p>{text}</p>', subtype='html')
    message.add_alternative(calendar, subtype='calendar', params={'method': method})
    return message

ADA = 'Ada Lovelace <ada@analytical.engineering>'
soon = (NOW + timedelta(days=2)).replace(hour=15, minute=0)
zoom = 'DESCRIPTION:Join Zoom Meeting\\nhttps://northwind.zoom.us/j/81234567890?pwd=SparkTest\\n\\nMeeting ID: 812 3456 7890'
past = NOW - timedelta(days=3)
weekly_start = (NOW - timedelta(days=70)).replace(hour=14, minute=0)
fixtures = [
    mail('upcoming', 'Ember calendar: Roadmap review', ADA, 'Agenda to follow.', NOW - timedelta(minutes=50),
         ics('REQUEST', 'spark-cal-upcoming', 'Roadmap review', soon, extra=[zoom]), 'REQUEST'),
    mail('past', 'Ember calendar: Kickoff (past)', ADA, 'See you there.', NOW - timedelta(days=5),
         ics('REQUEST', 'spark-cal-past', 'Kickoff (past)', past), 'REQUEST'),
    mail('old-version', 'Ember calendar: Budget sync', ADA, 'First version.', NOW - timedelta(hours=6),
         ics('REQUEST', 'spark-cal-versions', 'Budget sync', soon + timedelta(hours=2)), 'REQUEST'),
    mail('new-version', 'Ember calendar: Budget sync', ADA, 'Moved by an hour.', NOW - timedelta(hours=2),
         ics('REQUEST', 'spark-cal-versions', 'Budget sync', soon + timedelta(hours=3), sequence=1), 'REQUEST'),
    mail('weekly', 'Ember calendar: Weekly standup', ADA, 'Every Monday.', NOW - timedelta(days=71),
         ics('REQUEST', 'spark-cal-weekly', 'Weekly standup', weekly_start, extra=['RRULE:FREQ=WEEKLY;COUNT=40',
             'X-MICROSOFT-SKYPETEAMSMEETINGURL:https://teams.microsoft.com/l/meetup-join/19%3ameeting_spark%40thread.v2/0?context=%7b%7d']), 'REQUEST'),
    mail('cancel', 'Canceled: Ember calendar: Design review', ADA, 'This meeting is cancelled.', NOW - timedelta(minutes=40),
         ics('CANCEL', 'spark-cal-cancel', 'Design review', soon + timedelta(days=1)), 'CANCEL'),
]
for i, (name, address, answer) in enumerate([('Chris Okafor', 'chris@spark-team.test', 'ACCEPTED'), ('Karen Holt', 'karen@spark-team.test', 'DECLINED'), ('Mary Quinn', 'mary@spark-team.test', 'ACCEPTED')]):
    verb = {'ACCEPTED': 'Accepted', 'DECLINED': 'Declined'}[answer]
    fixtures.append(mail(f'reply-{i}', f'{verb}: Ember offsite', f'{name} <{address}>', '', NOW - timedelta(minutes=30 - i * 5),
                         ics('REPLY', 'spark-cal-offsite', 'Ember offsite', soon + timedelta(days=3), organizer=('Merritt Franzmann', 'merritt@spark.test'),
                             attendee=f'ATTENDEE;CN={name};PARTSTAT={answer}:mailto:{address}',
                             extra=['COMMENT:Out that week, sorry'] if answer == 'DECLINED' else []), 'REPLY'))

def main():
    client = spark.connect()
    result = []
    for message in fixtures:
        mid = str(message['Message-ID']).strip('<>')
        result.append(client.execute('''const { MailServices } = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const folder = MailServices.accounts.getAccount('account2').incomingServer.rootFolder.getChildNamed('Inbox').QueryInterface(Ci.nsIMsgLocalMailFolder);
const mid = %s;
const mark = (header) => { header.setStringProperty("junkscore", "0"); header.setStringProperty("junkscoreorigin", "user"); };
const existing = folder.msgDatabase.getMsgHdrForMessageID(mid);
// Thunderbird's junk filter can score a seeded invitation as junk, and Ember rightly hides junk.
if (existing) { mark(existing); return { existing: mid }; }
const header = folder.addMessage(%s);
mark(header);
return { added: mid, key: header.messageKey };''' % (json.dumps(mid), json.dumps(message.as_string()))))
    print(json.dumps(result, indent=2))

if __name__ == '__main__':
    main()
