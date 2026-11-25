"""A local mock Exchange (EWS) calendar for live tests: HTTPS on 127.0.0.1 with a throwaway certificate, any number
of test accounts (/EWS/<name>/), events kept in memory and changed by the requests Ember sends (CreateItem,
UpdateItem, DeleteItem, CancelCalendarItem, Accept/Tentative/Decline). Every request is kept in `requests`.

    mock = EwsMock(work_dir, {'A': {...events...}, 'B': {...}})
    keys = mock.add_accounts(chrome)        # chrome(script, args) runs in Thunderbird's chrome
    ...
    mock.remove_accounts(chrome, keys); mock.stop()

An event: dict(subject, start, end (aware datetimes), my='Accept'|'Organizer'|..., all_day, location, body, busy,
organizer=(name, email), attendees=[((name, email), response)], cancelled, type='Single'|'Occurrence', series).

Other calendars (`others`): {'folders': {which: {folder_id: (name, {id: event})}},
'links': {which: [(subject, x500_dn, hex_entry_id)]}, 'people': {x500_dn: (name, email)},
'mailboxes': {email: dict(access='full'|'busy', events={id: event}, folders={hex_entry_id: folder_id}, details=bool)}}.
A mailbox the user may only see busy times of refuses FindItem (ErrorAccessDenied); its busy times come from
GetUserAvailability, with subject and place when `details`.
"""
import base64, http.server, re, ssl, subprocess, threading
from datetime import datetime
from html import unescape

NS = 'xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types"'
esc = lambda s: str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
iso = lambda d: d.strftime('%Y-%m-%dT%H:%M:%SZ')
parse = lambda v: datetime.fromisoformat(v.replace('Z', '+00:00'))


def envelope(body):
    return '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' + body + '</s:Body></s:Envelope>'


def ok(kind, inner=''):
    return envelope(f'<m:{kind}Response {NS}><m:ResponseMessages><m:{kind}ResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>{inner}</m:{kind}ResponseMessage></m:ResponseMessages></m:{kind}Response>')


def value(xml, name):
    m = re.search(rf'<t:{name}(?:\s[^>]*)?>(.*?)</t:{name}>', xml, re.S)
    return unescape(m.group(1)) if m else None


class EwsMock:
    def __init__(self, work, events, busy=None, others=None):
        self.events = events
        self.others = others or {}
        # Free/busy of other people: {email: [(start, end)]}; addresses ending in @outside.test can't be seen.
        self.busy = busy or {}
        self.requests = []
        self.answers = {}
        self.created = 0
        self.work = work
        mock = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
                which = re.search(r'/EWS/(\w+)/', self.path).group(1)
                mock.requests.append((which, body))
                reply = mock.answer(which, body)
                self.send_response(200 if reply else 500)
                self.send_header('Content-Type', 'text/xml; charset=utf-8')
                self.end_headers()
                self.wfile.write((reply or '').encode())

        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
                        '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', work / 'key.pem', '-out', work / 'cert.pem'], check=True, capture_output=True)
        self.der = subprocess.run(['openssl', 'x509', '-in', work / 'cert.pem', '-outform', 'DER'], check=True, capture_output=True).stdout
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(work / 'cert.pem', work / 'key.pem')
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.port = self.server.server_address[1]

    def item(self, i, e, details=False):
        my = self.answers.get(i, e.get('my', 'Accept'))
        xml = (f'<t:CalendarItem><t:ItemId Id="{i}" ChangeKey="ck-{i}"/><t:Subject>{esc(e["subject"])}</t:Subject><t:Start>{iso(e["start"])}</t:Start><t:End>{iso(e["end"])}</t:End>'
               f'<t:IsAllDayEvent>{"true" if e.get("all_day") else "false"}</t:IsAllDayEvent><t:Location>{esc(e.get("location", ""))}</t:Location>'
               f'<t:LegacyFreeBusyStatus>{e.get("busy", "Busy")}</t:LegacyFreeBusyStatus><t:UID>uid-{e.get("series", i)}</t:UID><t:MyResponseType>{my}</t:MyResponseType>'
               f'<t:IsCancelled>{"true" if e.get("cancelled") else "false"}</t:IsCancelled>')
        if details:
            xml += (f'<t:CalendarItemType>{e.get("type", "Single")}</t:CalendarItemType><t:IsMeeting>{"true" if e.get("attendees") else "false"}</t:IsMeeting>'
                    f'<t:ReminderIsSet>{"true" if e.get("reminder", 15) >= 0 else "false"}</t:ReminderIsSet><t:ReminderMinutesBeforeStart>{max(0, e.get("reminder", 15))}</t:ReminderMinutesBeforeStart>'
                    f'<t:Body BodyType="Text">{esc(e.get("body", ""))}</t:Body>')
            if e.get('organizer'):
                xml += f'<t:Organizer><t:Mailbox><t:Name>{esc(e["organizer"][0])}</t:Name><t:EmailAddress>{e["organizer"][1]}</t:EmailAddress></t:Mailbox></t:Organizer>'
            if e.get('attendees'):
                xml += '<t:RequiredAttendees>' + ''.join(f'<t:Attendee><t:Mailbox><t:Name>{esc(n)}</t:Name><t:EmailAddress>{a}</t:EmailAddress></t:Mailbox><t:ResponseType>{r}</t:ResponseType></t:Attendee>' for (n, a), r in e['attendees']) + '</t:RequiredAttendees>'
        return xml + '</t:CalendarItem>'

    def answer(self, which, body):
        events = self.events.setdefault(which, {})
        others = self.others
        mailboxes = others.get('mailboxes', {})
        if '<m:GetFolder>' in body:
            msg = lambda kind, i: f'<m:GetFolderResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Folders><t:{kind}><t:FolderId Id="{i}" ChangeKey="c"/></t:{kind}></m:Folders></m:GetFolderResponseMessage>'
            return envelope(f'<m:GetFolderResponse {NS}><m:ResponseMessages>{msg("CalendarFolder", f"CAL-{which}")}{msg("Folder", f"DEL-{which}")}</m:ResponseMessages></m:GetFolderResponse>')
        if '<m:FindFolder Traversal="Deep">' in body:
            folders = f'<t:CalendarFolder><t:FolderId Id="CAL-{which}" ChangeKey="c"/><t:ParentFolderId Id="ROOT-{which}" ChangeKey="c"/><t:FolderClass>IPF.Appointment</t:FolderClass><t:DisplayName>Calendar</t:DisplayName></t:CalendarFolder>'
            folders += ''.join(f'<t:CalendarFolder><t:FolderId Id="{i}" ChangeKey="c"/><t:ParentFolderId Id="CAL-{which}" ChangeKey="c"/><t:FolderClass>IPF.Appointment</t:FolderClass><t:DisplayName>{esc(name)}</t:DisplayName></t:CalendarFolder>'
                               for i, (name, _) in others.get('folders', {}).get(which, {}).items())
            folders += f'<t:CalendarFolder><t:FolderId Id="TRASHED-{which}" ChangeKey="c"/><t:ParentFolderId Id="DEL-{which}" ChangeKey="c"/><t:FolderClass>IPF.Appointment</t:FolderClass><t:DisplayName>Old calendar</t:DisplayName></t:CalendarFolder>'
            return ok('FindFolder', f'<m:RootFolder TotalItemsInView="9" IncludesLastItemInRange="true"><t:Folders>{folders}</t:Folders></m:RootFolder>')
        if '<m:FindFolder Traversal="Shallow">' in body and 'Common Views' in body:
            return ok('FindFolder', f'<m:RootFolder TotalItemsInView="1" IncludesLastItemInRange="true"><t:Folders><t:Folder><t:FolderId Id="CV-{which}" ChangeKey="c"/></t:Folder></t:Folders></m:RootFolder>')
        if '<m:FindItem Traversal="Associated">' in body:
            def b64(raw): return base64.b64encode(raw).decode()
            def prop(tag, kind, v): return f'<t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="{tag}" PropertyType="{kind}"/><t:Value>{v}</t:Value></t:ExtendedProperty>'
            cal_type = b64(bytes.fromhex('0278060000000000c000000000000046'))
            items = ''
            for subject, dn, entry in others.get('links', {}).get(which, []):
                ab = b64(bytes(4) + bytes.fromhex('dca740c8c042101ab4b908002b2fe182') + bytes([1, 0, 0, 0, 0, 0, 0, 0]) + dn.encode() + b'\0') if dn else ''
                items += (f'<t:Message><t:ItemId Id="L{len(items)}" ChangeKey="c"/><t:Subject>{esc(subject)}</t:Subject>{prop("0x684c", "Binary", b64(bytes.fromhex(entry)))}{prop("0x684f", "Binary", cal_type)}'
                          f'{prop("0x6851", "String", "People&apos;s calendars")}{prop("0x6854", "Binary", ab) if ab else ""}</t:Message>')
            return ok('FindItem', f'<m:RootFolder IndexedPagingOffset="0" TotalItemsInView="9" IncludesLastItemInRange="true"><t:Items>{items}</t:Items></m:RootFolder>')
        if '<m:ResolveNames' in body:
            person = others.get('people', {}).get(unescape(value(body.replace('m:UnresolvedEntry', 't:UnresolvedEntry'), 'UnresolvedEntry') or ''))
            if not person:
                return envelope(f'<m:ResolveNamesResponse {NS}><m:ResponseMessages><m:ResolveNamesResponseMessage ResponseClass="Error"><m:MessageText>No results were found.</m:MessageText><m:ResponseCode>ErrorNameResolutionNoResults</m:ResponseCode></m:ResolveNamesResponseMessage></m:ResponseMessages></m:ResolveNamesResponse>')
            return ok('ResolveNames', f'<m:ResolutionSet TotalItemsInView="1" IncludesLastItemInRange="true"><t:Resolution><t:Mailbox><t:Name>{esc(person[0])}</t:Name><t:EmailAddress>{person[1]}</t:EmailAddress><t:RoutingType>SMTP</t:RoutingType><t:MailboxType>Mailbox</t:MailboxType></t:Mailbox></t:Resolution></m:ResolutionSet>')
        if '<m:ConvertId' in body:
            entry, box = re.search(r'Format="HexEntryId" Id="([^"]+)" Mailbox="([^"]+)"', body).groups()
            folder = mailboxes.get(box, {}).get('folders', {}).get(entry)
            if not folder:
                return envelope(f'<m:ConvertIdResponse {NS}><m:ResponseMessages><m:ConvertIdResponseMessage ResponseClass="Error"><m:MessageText>Id is malformed.</m:MessageText><m:ResponseCode>ErrorInvalidIdMalformed</m:ResponseCode></m:ConvertIdResponseMessage></m:ResponseMessages></m:ConvertIdResponse>')
            return ok('ConvertId', f'<m:AlternateId Format="EwsId" Id="{folder}" Mailbox="{box}"/>')
        if '<m:FindItem' in body and 'calendar:Start' in body and '<m:ParentFolderIds><t:DistinguishedFolderId Id="calendar"/>' not in body:
            # Another calendar: one of the user's folders, a person's calendar by address, or a person's folder.
            folder = re.search(r'<m:ParentFolderIds><t:FolderId Id="([^"]+)"', body)
            box = re.search(r'<t:Mailbox><t:EmailAddress>([^<]+)</t:EmailAddress>', body)
            own = folder and others.get('folders', {}).get(which, {}).get(folder.group(1))
            person = None
            if box: person = mailboxes.get(box.group(1))
            elif folder and not own: person = next((mb for mb in mailboxes.values() if folder.group(1) in mb.get('folders', {}).values()), None)
            source = own[1] if own else person['events'] if person and person.get('access') == 'full' else None
            if source is None:
                return envelope(f'<m:FindItemResponse {NS}><m:ResponseMessages><m:FindItemResponseMessage ResponseClass="Error"><m:MessageText>Access is denied. Check credentials and try again.</m:MessageText><m:ResponseCode>ErrorAccessDenied</m:ResponseCode></m:FindItemResponseMessage></m:ResponseMessages></m:FindItemResponse>')
            start, end = (parse(v) for v in re.search(r'StartDate="([^"]+)" EndDate="([^"]+)"', body).groups())
            shown = ''.join(self.item(i, e) for i, e in source.items() if e['start'] < end and e['end'] > start)
            return ok('FindItem', f'<m:RootFolder IncludesLastItemInRange="true"><t:Items>{shown}</t:Items></m:RootFolder>')
        if '<m:GetUserAvailabilityRequest' in body:
            window = [parse(v + 'Z') for v in re.search(r'<t:StartTime>([^<]+)</t:StartTime><t:EndTime>([^<]+)</t:EndTime>', body).groups()]
            out = ''
            for email in re.findall(r'<t:Address>([^<]+)</t:Address>', body):
                if email.endswith('@outside.test'):
                    out += '<m:FreeBusyResponse><m:ResponseMessage ResponseClass="Error"><m:MessageText>The mailbox is outside the organization.</m:MessageText><m:ResponseCode>ErrorMailRecipientNotFound</m:ResponseCode></m:ResponseMessage></m:FreeBusyResponse>'
                    continue
                own = email == f'merritt-{which.lower()}@ews.test'
                box = mailboxes.get(email)
                detailed = '<t:RequestedView>Detailed</t:RequestedView>' in body and box and box.get('details')
                if own: spans = [(e['start'], e['end'], None) for e in events.values() if e.get('busy', 'Busy') != 'Free' and not e.get('cancelled')]
                elif box: spans = [(e['start'], e['end'], e) for e in box['events'].values() if not e.get('cancelled')]
                else: spans = [(a, b, None) for a, b in self.busy.get(email, [])]
                def details(e):
                    return f'<t:CalendarEventDetails><t:ID>x</t:ID><t:Subject>{esc(e["subject"])}</t:Subject><t:Location>{esc(e.get("location", ""))}</t:Location><t:IsMeeting>false</t:IsMeeting><t:IsRecurring>false</t:IsRecurring><t:IsException>false</t:IsException><t:IsReminderSet>false</t:IsReminderSet><t:IsPrivate>false</t:IsPrivate></t:CalendarEventDetails>' if detailed and e else ''
                cal = ''.join(f'<t:CalendarEvent><t:StartTime>{a.strftime("%Y-%m-%dT%H:%M:%S")}</t:StartTime><t:EndTime>{b.strftime("%Y-%m-%dT%H:%M:%S")}</t:EndTime><t:BusyType>{(e or {}).get("busy", "Busy")}</t:BusyType>{details(e)}</t:CalendarEvent>'
                              for a, b, e in spans if a < window[1] and b > window[0])
                out += f'<m:FreeBusyResponse><m:ResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode></m:ResponseMessage><m:FreeBusyView><t:FreeBusyViewType>FreeBusy</t:FreeBusyViewType><t:CalendarEventArray>{cal}</t:CalendarEventArray></m:FreeBusyView></m:FreeBusyResponse>'
            return envelope(f'<m:GetUserAvailabilityResponse {NS}><m:FreeBusyResponseArray>{out}</m:FreeBusyResponseArray></m:GetUserAvailabilityResponse>')
        if '<m:FindItem' in body and 'calendar:Start' in body:
            start, end = (parse(v) for v in re.search(r'StartDate="([^"]+)" EndDate="([^"]+)"', body).groups())
            shown = ''.join(self.item(i, e) for i, e in events.items() if e['start'] < end and e['end'] > start)
            return ok('FindItem', f'<m:RootFolder IncludesLastItemInRange="true"><t:Items>{shown}</t:Items></m:RootFolder>')
        if '<m:GetItem' in body:
            ids = re.findall(r'<t:ItemId Id="([^"]+)"/>', body)
            pool = dict(events)
            for _, (_, extra) in others.get('folders', {}).get(which, {}).items(): pool.update(extra)
            for box in mailboxes.values():
                if box.get('access') == 'full': pool.update(box['events'])
            return ok('GetItem', '<m:Items>' + ''.join(self.item(i, pool[i], details='item:Body' in body) for i in ids if i in pool) + '</m:Items>')
        if '<m:CreateItem' in body and '<t:CalendarItem>' in body:
            self.created += 1
            i = f'NEW{self.created}'
            people = re.findall(r'<t:Attendee><t:Mailbox>(?:<t:Name>(.*?)</t:Name>)?<t:EmailAddress>(.*?)</t:EmailAddress>', body)
            events[i] = dict(subject=value(body, 'Subject'), start=parse(value(body, 'Start')), end=parse(value(body, 'End')), my='Organizer',
                             all_day=value(body, 'IsAllDayEvent') == 'true', location=value(body, 'Location') or '', body=value(body, 'Body') or '',
                             busy=value(body, 'LegacyFreeBusyStatus') or 'Busy', organizer=('Merritt (EWS test)', 'merritt@ews.test'),
                             attendees=[((unescape(n), unescape(a)), 'NoResponseReceived') for n, a in people])
            return ok('CreateItem', f'<m:Items><t:CalendarItem><t:ItemId Id="{i}" ChangeKey="ck-{i}"/></t:CalendarItem></m:Items>')
        if '<m:UpdateItem' in body:
            i = re.search(r'<t:(?:ItemId Id|RecurringMasterItemId OccurrenceId)="([^"]+)"', body).group(1)
            e = events.get(i)
            if e:
                for field, key, conv in (('Subject', 'subject', str), ('Location', 'location', str), ('Start', 'start', parse), ('End', 'end', parse)):
                    v = value(body, field)
                    if v is not None and f'FieldURI="{"item" if field == "Subject" else "calendar"}:{field}"' in body: e[key] = conv(v)
                if 'DeleteItemField><t:FieldURI FieldURI="calendar:Location"' in body: e['location'] = ''
            return ok('UpdateItem', '<m:Items/>')
        if '<m:DeleteItem' in body:
            for i in re.findall(r'<t:ItemId Id="([^"]+)"/>', body): events.pop(i, None)
            for i in re.findall(r'<t:RecurringMasterItemId OccurrenceId="([^"]+)"/>', body):
                series = events.get(i, {}).get('series', i)
                for k in [k for k, e in events.items() if e.get('series', k) == series]: events.pop(k, None)
            return ok('DeleteItem')
        if '<m:CreateItem' in body:
            cancel = re.search(r'<t:CancelCalendarItem><t:ReferenceItemId Id="([^"]+)"', body)
            if cancel: events.pop(cancel.group(1), None)
            for kind, word in (('AcceptItem', 'Accept'), ('TentativelyAcceptItem', 'Tentative'), ('DeclineItem', 'Decline')):
                hit = re.search(rf'<t:{kind}><t:ReferenceItemId Id="([^"]+)"', body)
                if hit: self.answers[hit.group(1)] = word
            return ok('CreateItem', '<m:Items/>')
        return None

    def add_accounts(self, chrome, names=None):
        """One Exchange test account per events key (prettyName "Calendar test <name>"); returns their keys."""
        return chrome('''
const [port, der, names] = arguments;
const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
const cert = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB).constructX509FromBase64(der);
Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).rememberValidityOverride("127.0.0.1", port, {}, cert, false);
const keys = [];
for (const which of names) {
  const address = `merritt-${which.toLowerCase()}@ews.test`;
  const server = MailServices.accounts.createIncomingServer(address, "127.0.0.1", "ews");
  server.setStringValue("ews_url", `https://127.0.0.1:${port}/EWS/${which}/Exchange.asmx`);
  server.authMethod = Ci.nsMsgAuthMethod.passwordCleartext;
  server.password = "spark-test-password";
  server.loginAtStartUp = false; server.doBiff = false;
  server.prettyName = `Calendar test ${which}`;
  const account = MailServices.accounts.createAccount();
  account.incomingServer = server;
  const identity = MailServices.accounts.createIdentity(); identity.email = address; identity.fullName = "Merritt (EWS test)";
  account.addIdentity(identity);
  keys.push(account.key);
}
return keys;''', [self.port, base64.b64encode(self.der).decode(), names or list(self.events)])

    def remove_accounts(self, chrome, keys):
        chrome('''
const [keys, port] = arguments;
const {MailServices} = ChromeUtils.importESModule('resource:///modules/MailServices.sys.mjs');
for (const key of keys || []) { const account = MailServices.accounts.getAccount(key); if (account) MailServices.accounts.removeAccount(account, true); }
Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).clearValidityOverride("127.0.0.1", port, {});
return true;''', [keys, self.port])

    def stop(self):
        self.server.shutdown()
        subprocess.run(['rm', '-rf', str(self.work)])
