"""A local mock CalDAV server for live tests of Thunderbird's own calendars in Ember (Google Calendar works the same
way: Thunderbird syncs it over CalDAV). HTTPS on localhost with a throwaway certificate; calendars and events kept
in memory and changed by what Thunderbird sends (PUT, DELETE). It says it schedules itself (calendar-auto-schedule,
as Google's server does), so Thunderbird sends no invitation or reply emails; free/busy questions to its outbox are
answered from `busy`. Every request is kept in `requests`.

    mock = CalDavMock(work_dir, 'alex@gmail.com', {'personal': dict(name=..., color=..., events={...}), ...})
    mock.trust(chrome)                  # chrome(script, args) runs in Thunderbird's chrome
    location = mock.location           # where Thunderbird's calendar detection looks
    ...
    mock.untrust(chrome); mock.stop()

A calendar: dict(name, color, read_only=False, events={href_name: ics_text}).
"""
import hashlib, http.server, re, ssl, subprocess, threading
from html import escape, unescape

DAV = 'xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/"'


def etag(text):
    return '"' + hashlib.md5(text.encode()).hexdigest() + '"'


class CalDavMock:
    def __init__(self, work, user, calendars, busy=None):
        self.user = user
        self.calendars = calendars
        # Other people's busy times for the outbox: {email: [(start 'YYYYMMDDTHHMMSSZ', end)]}.
        self.busy = busy or {}
        self.requests = []
        self.ctag = 1
        self.work = work
        mock = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def handle_any(self):
                body = self.rfile.read(int(self.headers.get('Content-Length', 0) or 0)).decode('utf-8', 'replace')
                mock.requests.append((self.command, self.path, dict(self.headers), body))
                status, headers, reply = mock.answer(self.command, self.path, self.headers, body)
                self.send_response(status)
                for k, v in headers.items():
                    self.send_header(k, v)
                data = reply.encode()
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                if self.command != 'HEAD':
                    self.wfile.write(data)

            do_GET = do_PUT = do_DELETE = do_OPTIONS = do_PROPFIND = do_REPORT = do_POST = do_HEAD = do_PROPPATCH = handle_any

        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
                        '-addext', 'subjectAltName=DNS:localhost', '-keyout', work / 'caldav-key.pem', '-out', work / 'caldav-cert.pem'], check=True, capture_output=True)
        self.der = subprocess.run(['openssl', 'x509', '-in', work / 'caldav-cert.pem', '-outform', 'DER'], check=True, capture_output=True).stdout
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(work / 'caldav-cert.pem', work / 'caldav-key.pem')
        self.server.socket = context.wrap_socket(self.server.socket, server_side=True)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.port = self.server.server_address[1]
        self.location = f'https://localhost:{self.port}/dav/'

    # ---- answers ----
    def multistatus(self, responses):
        return 207, {'Content-Type': 'application/xml; charset=utf-8'}, f'<?xml version="1.0" encoding="utf-8"?><D:multistatus {DAV}>{"".join(responses)}</D:multistatus>'

    @staticmethod
    def response(href, found, missing=()):
        out = f'<D:response><D:href>{escape(href)}</D:href>'
        if found:
            out += f'<D:propstat><D:prop>{"".join(found)}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>'
        if missing:
            out += f'<D:propstat><D:prop>{"".join(missing)}</D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>'
        return out + '</D:response>'

    @staticmethod
    def wanted(body):
        """The property names a PROPFIND asks for (local names); all of ours when it asks for allprop/none."""
        prop = re.search(r'<(?:\w+:)?prop\b[^>]*>(.*?)</(?:\w+:)?prop>', body, re.S)
        if not prop:
            return None
        return re.findall(r'<(?:\w+:)?([\w-]+)\s*/>', prop.group(1)) + re.findall(r'<(?:\w+:)?([\w-]+)\s*>\s*</', prop.group(1))

    def props(self, path, names):
        """(found, missing) for one resource."""
        known = {}
        cal_match = re.fullmatch(r'/dav/cal/(\w+)/', path)
        privileges = lambda read_only: '<D:current-user-privilege-set><D:privilege><D:read/></D:privilege>' + ('' if read_only else '<D:privilege><D:write/></D:privilege><D:privilege><D:write-content/></D:privilege><D:privilege><D:bind/></D:privilege><D:privilege><D:unbind/></D:privilege>') + '</D:current-user-privilege-set>'
        principal = '<D:href>/dav/principal/</D:href>'
        if path == '/dav/':
            known = {'resourcetype': '<D:resourcetype><D:collection/></D:resourcetype>', 'current-user-principal': f'<D:current-user-principal>{principal}</D:current-user-principal>',
                     'calendar-home-set': '<C:calendar-home-set><D:href>/dav/cal/</D:href></C:calendar-home-set>'}
        elif path == '/dav/principal/':
            known = {'resourcetype': '<D:resourcetype><D:principal/></D:resourcetype>', 'displayname': '<D:displayname>Alex Morgan</D:displayname>',
                     'current-user-principal': f'<D:current-user-principal>{principal}</D:current-user-principal>',
                     'calendar-home-set': '<C:calendar-home-set><D:href>/dav/cal/</D:href></C:calendar-home-set>',
                     'calendar-user-address-set': f'<C:calendar-user-address-set><D:href>mailto:{self.user}</D:href></C:calendar-user-address-set>',
                     'schedule-inbox-URL': '<C:schedule-inbox-URL><D:href>/dav/inbox/</D:href></C:schedule-inbox-URL>',
                     'schedule-outbox-URL': '<C:schedule-outbox-URL><D:href>/dav/outbox/</D:href></C:schedule-outbox-URL>'}
        elif path == '/dav/cal/':
            known = {'resourcetype': '<D:resourcetype><D:collection/></D:resourcetype>', 'displayname': '<D:displayname>Calendars</D:displayname>',
                     'current-user-principal': f'<D:current-user-principal>{principal}</D:current-user-principal>', 'owner': f'<D:owner>{principal}</D:owner>'}
        elif cal_match and cal_match.group(1) in self.calendars:
            c = self.calendars[cal_match.group(1)]
            known = {'resourcetype': '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>', 'displayname': f'<D:displayname>{escape(c["name"])}</D:displayname>',
                     'calendar-color': f'<A:calendar-color>{c.get("color", "#16a765")}FF</A:calendar-color>', 'owner': f'<D:owner>{principal}</D:owner>',
                     'current-user-principal': f'<D:current-user-principal>{principal}</D:current-user-principal>', 'current-user-privilege-set': privileges(c.get('read_only')),
                     'getctag': f'<CS:getctag>"ctag-{self.ctag}"</CS:getctag>', 'getetag': f'<D:getetag>"ctag-{self.ctag}"</D:getetag>',
                     'supported-calendar-component-set': '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>',
                     'supported-report-set': '<D:supported-report-set><D:supported-report><D:report><C:calendar-multiget/></D:report></D:supported-report><D:supported-report><D:report><C:calendar-query/></D:report></D:supported-report></D:supported-report-set>'}
        else:
            item = self.item(path)
            if item is not None:
                known = {'resourcetype': '<D:resourcetype/>', 'getetag': f'<D:getetag>{etag(item)}</D:getetag>', 'getcontenttype': '<D:getcontenttype>text/calendar; charset=utf-8; component=VEVENT</D:getcontenttype>'}
        if names is None:
            return list(known.values()), []
        found = [known[n] for n in names if n in known]
        missing = [f'<D:{n}/>' for n in names if n not in known]
        return found, missing

    def item(self, path):
        hit = re.fullmatch(r'/dav/cal/(\w+)/([^/]+)', path)
        if not hit or hit.group(1) not in self.calendars:
            return None
        return self.calendars[hit.group(1)]['events'].get(unescape(hit.group(2)).replace('%40', '@'))

    def answer(self, method, path, headers, body):
        path = path.split('?')[0]
        if method == 'OPTIONS':
            return 200, {'DAV': '1, 2, 3, access-control, calendar-access, calendar-auto-schedule, calendar-schedule', 'Allow': 'OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT, POST'}, ''
        if method == 'PROPFIND':
            names = self.wanted(body)
            depth = headers.get('Depth', '0')
            if path not in ('/dav/', '/dav/principal/', '/dav/cal/') and not re.fullmatch(r'/dav/cal/\w+/', path) and self.item(path) is None:
                return 404, {}, ''
            out = [self.response(path, *self.props(path, names))]
            if depth == '1' and path == '/dav/cal/':
                out += [self.response(f'/dav/cal/{k}/', *self.props(f'/dav/cal/{k}/', names)) for k in self.calendars]
            hit = re.fullmatch(r'/dav/cal/(\w+)/', path)
            if depth == '1' and hit and hit.group(1) in self.calendars:
                out += [self.response(f'{path}{n}', *self.props(f'{path}{n}', names)) for n in self.calendars[hit.group(1)]['events']]
            return self.multistatus(out)
        if method == 'REPORT':
            hit = re.fullmatch(r'/dav/cal/(\w+)/', path)
            if not hit or hit.group(1) not in self.calendars:
                return 404, {}, ''
            events = self.calendars[hit.group(1)]['events']
            if 'calendar-multiget' in body:
                hrefs = [unescape(h) for h in re.findall(r'<(?:\w+:)?href>([^<]+)</(?:\w+:)?href>', body)]
                names = [h.rsplit('/', 1)[-1].replace('%40', '@') for h in hrefs]
            else:
                names = list(events)
            want_data = 'calendar-data' in body
            out = []
            for n in names:
                if n not in events:
                    out.append(f'<D:response><D:href>{path}{escape(n)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>')
                    continue
                found = [f'<D:getetag>{etag(events[n])}</D:getetag>'] + ([f'<C:calendar-data>{escape(events[n])}</C:calendar-data>'] if want_data else [])
                out.append(self.response(f'{path}{n}', found))
            return self.multistatus(out)
        if method == 'GET':
            text = self.item(path)
            return (200, {'Content-Type': 'text/calendar; charset=utf-8', 'ETag': etag(text)}, text) if text is not None else (404, {}, '')
        if method == 'PUT':
            hit = re.fullmatch(r'/dav/cal/(\w+)/([^/]+)', path)
            if not hit or hit.group(1) not in self.calendars:
                return 404, {}, ''
            c = self.calendars[hit.group(1)]
            if c.get('read_only'):
                return 403, {}, ''
            name = unescape(hit.group(2)).replace('%40', '@')
            if headers.get('If-None-Match') == '*' and name in c['events']:
                return 412, {}, ''
            created = name not in c['events']
            c['events'][name] = body
            self.ctag += 1
            return (201 if created else 204), {'ETag': etag(body)}, ''
        if method == 'DELETE':
            hit = re.fullmatch(r'/dav/cal/(\w+)/([^/]+)', path)
            name = hit and unescape(hit.group(2)).replace('%40', '@')
            if not hit or hit.group(1) not in self.calendars or name not in self.calendars[hit.group(1)]['events']:
                return 404, {}, ''
            del self.calendars[hit.group(1)]['events'][name]
            self.ctag += 1
            return 204, {}, ''
        if method == 'POST' and path == '/dav/outbox/':
            # A free/busy question (VFREEBUSY REQUEST): each attendee's busy times, or "not known".
            responses = []
            for who in re.findall(r'^ATTENDEE[^:]*:mailto:(\S+)', body.replace('\r\n ', ''), re.M | re.I):
                who = who.strip().lower()
                if who not in self.busy:
                    responses.append(f'<C:response><C:recipient><D:href>mailto:{who}</D:href></C:recipient><C:request-status>3.7;Invalid calendar user</C:request-status></C:response>')
                    continue
                periods = ''.join(f'FREEBUSY;FBTYPE=BUSY:{s}/{e}\r\n' for s, e in self.busy[who])
                fb = (f'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Ember tests//CalDAV mock//EN\r\nMETHOD:REPLY\r\nBEGIN:VFREEBUSY\r\nUID:fb-{who}\r\nDTSTAMP:20260101T000000Z\r\n'
                      f'ORGANIZER:mailto:{self.user}\r\nATTENDEE:mailto:{who}\r\n{periods}END:VFREEBUSY\r\nEND:VCALENDAR\r\n')
                responses.append(f'<C:response><C:recipient><D:href>mailto:{who}</D:href></C:recipient><C:request-status>2.0;Success</C:request-status><C:calendar-data>{escape(fb)}</C:calendar-data></C:response>')
            return 200, {'Content-Type': 'application/xml; charset=utf-8'}, f'<?xml version="1.0" encoding="utf-8"?><C:schedule-response {DAV}>{"".join(responses)}</C:schedule-response>'
        return 405, {}, ''

    # ---- Thunderbird ----
    def trust(self, chrome):
        chrome('''const [port, der] = arguments;
const cert = Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB).constructX509FromBase64(der);
Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).rememberValidityOverride("localhost", port, {}, cert, false);
return true;''', [self.port, __import__('base64').b64encode(self.der).decode()])

    def untrust(self, chrome):
        chrome('''const [port] = arguments;
Cc["@mozilla.org/security/certoverride;1"].getService(Ci.nsICertOverrideService).clearValidityOverride("localhost", port, {});
return true;''', [self.port])

    def stop(self):
        self.server.shutdown()
        for name in ('caldav-key.pem', 'caldav-cert.pem'):
            try:
                (self.work / name).unlink()
            except FileNotFoundError:
                pass
