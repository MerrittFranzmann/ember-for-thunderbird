/* Ember calendar responses. The public MailExtension API can neither answer an Exchange meeting
 * request nor send a correct iMIP reply (compose attachments lose `method=REPLY`), so this small
 * Experiment uses Thunderbird's own plumbing:
 * - Exchange (EWS) accounts: the AcceptItem / TentativelyAcceptItem / DeclineItem request Outlook
 *   makes, with Thunderbird's sign-in. Exchange updates the user's calendar and tells the organizer.
 * - Other accounts: the same MIME Thunderbird's invitation bar sends (CalItipEmailTransport),
 *   through Thunderbird's own sender.
 * The pure helpers at the top are unit-tested (test/calendar-experiment.test.ts). */
"use strict";

const EWS_RESPONSES = { accept: "AcceptItem", tentative: "TentativelyAcceptItem", decline: "DeclineItem" };
const EWS_ERRORS = {
  ErrorItemNotFound: "This invitation is no longer in your Exchange mailbox. It may have been answered or moved already.",
  ErrorCalendarMeetingRequestIsOutOfDate: "The organizer has updated this meeting. Respond to the newest invitation.",
  ErrorCalendarIsOrganizerForAccept: "You're the organizer of this meeting.",
  ErrorCalendarIsOrganizerForDecline: "You're the organizer of this meeting.",
  ErrorCalendarIsOrganizerForTentative: "You're the organizer of this meeting.",
  ErrorCalendarIsCancelledForAccept: "This meeting has been cancelled.",
  ErrorCalendarIsCancelledForDecline: "This meeting has been cancelled.",
  ErrorCalendarIsCancelledForTentative: "This meeting has been cancelled.",
};

function xmlEscape(value) {
  return String(value).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
}
function xmlUnescape(value) {
  return String(value || "").replace(/&(lt|gt|quot|apos|amp|#x[0-9a-f]+|#\d+);/gi, (_, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" }[e.toLowerCase()];
  }).trim();
}

function ewsEnvelope(body) {
  return '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">' +
    '<soap:Header><t:RequestServerVersion Version="Exchange2013"/></soap:Header>' +
    `<soap:Body>${body}</soap:Body></soap:Envelope>`;
}

/** The EWS CreateItem request Outlook sends for a meeting response. Without `send`, Exchange
 *  updates the calendar but tells nobody (Outlook's "Don't send a response"). */
function ewsResponseRequest(response, itemId, { note = "", send = true, changeKey = "" } = {}) {
  const element = EWS_RESPONSES[response];
  if (!element) throw new Error(`Unknown response: ${response}`);
  const body = note ? `<t:Body BodyType="Text">${xmlEscape(note)}</t:Body>` : "";
  return ewsEnvelope(`<m:CreateItem MessageDisposition="${send ? "SendAndSaveCopy" : "SaveOnly"}"><m:Items>` +
    `<t:${element}>${body}${referenceItem(itemId, changeKey)}</t:${element}>` +
    "</m:Items></m:CreateItem>");
}

/** Outlook's "Remove from calendar" for a meeting cancellation. */
function ewsRemoveRequest(itemId, changeKey = "") {
  return ewsEnvelope(`<m:CreateItem><m:Items><t:RemoveItem>${referenceItem(itemId, changeKey)}</t:RemoveItem></m:Items></m:CreateItem>`);
}
/** The item a response refers to, with its ChangeKey (the version Outlook answers) when known. */
function referenceItem(itemId, changeKey) {
  return `<t:ReferenceItemId Id="${xmlEscape(itemId)}"${changeKey ? ` ChangeKey="${xmlEscape(changeKey)}"` : ""}/>`;
}

/** GetItem for items by id; with `master`, each id is an occurrence and its series (the recurring master) is read. */
function ewsGetItemRequest(itemIds, fields, bodyType = "", { master = false } = {}) {
  const uris = fields.map((field) => `<t:FieldURI FieldURI="${field}"/>`).join("");
  const id = (value) => master ? `<t:RecurringMasterItemId OccurrenceId="${xmlEscape(value)}"/>` : `<t:ItemId Id="${xmlEscape(value)}"/>`;
  return ewsEnvelope(`<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape>${bodyType ? `<t:BodyType>${bodyType}</t:BodyType>` : ""}` +
    `<t:AdditionalProperties>${uris}</t:AdditionalProperties></m:ItemShape>` +
    `<m:ItemIds>${itemIds.map(id).join("")}</m:ItemIds></m:GetItem>`);
}

function ewsDeleteRequest(itemId) {
  return ewsEnvelope(`<m:DeleteItem DeleteType="HardDelete"><m:ItemIds><t:ItemId Id="${xmlEscape(itemId)}"/></m:ItemIds></m:DeleteItem>`);
}

const CALENDAR_FIELDS = ["item:Subject", "calendar:Start", "calendar:End", "calendar:IsAllDayEvent", "calendar:Location", "calendar:LegacyFreeBusyStatus", "calendar:MyResponseType", "calendar:IsCancelled"];
const PEOPLE_FIELDS = ["calendar:Organizer", "calendar:RequiredAttendees", "calendar:OptionalAttendees"];
// Not every server returns these from FindItem; the view is retried without them.
const OPTIONAL_CALENDAR_FIELDS = ["calendar:UID", "item:ReminderIsSet", "item:ReminderMinutesBeforeStart"];
/** The user's calendar between two instants (recurring meetings expanded), like Outlook's day view. */
function ewsCalendarViewRequest(start, end, withOptional = true, folder = "") {
  const fields = [...CALENDAR_FIELDS, ...(withOptional ? OPTIONAL_CALENDAR_FIELDS : [])].map((field) => `<t:FieldURI FieldURI="${field}"/>`).join("");
  return ewsEnvelope(`<m:FindItem Traversal="Shallow"><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>${fields}</t:AdditionalProperties></m:ItemShape>` +
    `<m:CalendarView MaxEntriesReturned="1000" StartDate="${xmlEscape(start)}" EndDate="${xmlEscape(end)}"/>` +
    `<m:ParentFolderIds>${folder || '<t:DistinguishedFolderId Id="calendar"/>'}</m:ParentFolderIds></m:FindItem>`);
}
/** The folder of another calendar: a folder id, or a person's (or group's) main calendar by address. */
function ewsCalendarFolder({ folderId = "", email = "" } = {}) {
  if (folderId) return `<t:FolderId Id="${xmlEscape(folderId)}"/>`;
  if (email) return `<t:DistinguishedFolderId Id="calendar"><t:Mailbox><t:EmailAddress>${xmlEscape(email)}</t:EmailAddress></t:Mailbox></t:DistinguishedFolderId>`;
  return "";
}

// ---- Other calendars: the user's own extra calendars, and the shared ones in their Outlook calendar list ----
/** The ids of the user's main Calendar and Deleted Items folders (to tell the extra calendars apart). */
function ewsDefaultFoldersRequest() {
  return ewsEnvelope('<m:GetFolder><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape>' +
    '<m:FolderIds><t:DistinguishedFolderId Id="calendar"/><t:DistinguishedFolderId Id="deleteditems"/></m:FolderIds></m:GetFolder>');
}
function ewsDefaultFolders(xml) {
  const [calendar, deleted] = ewsElements(xml, "GetFolderResponseMessage").map(({ inner }) => ewsId(inner, "FolderId"));
  return { calendar: calendar || "", deleted: deleted || "" };
}
/** Every calendar folder in the user's mailbox. */
function ewsCalendarFoldersRequest() {
  const fields = ["folder:DisplayName", "folder:FolderClass", "folder:ParentFolderId"].map((f) => `<t:FieldURI FieldURI="${f}"/>`).join("");
  return ewsEnvelope(`<m:FindFolder Traversal="Deep"><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>${fields}</t:AdditionalProperties></m:FolderShape>` +
    '<m:Restriction><t:Contains ContainmentMode="Prefixed" ContainmentComparison="IgnoreCase"><t:FieldURI FieldURI="folder:FolderClass"/><t:Constant Value="IPF.Appointment"/></t:Contains></m:Restriction>' +
    '<m:ParentFolderIds><t:DistinguishedFolderId Id="msgfolderroot"/></m:ParentFolderIds></m:FindFolder>');
}
/** The extra calendars (not the main one, nor any in Deleted Items): { id, name }. */
function ewsCalendarFolders(xml, defaults = {}) {
  return ewsElements(xml, "CalendarFolder").map(({ inner }) => ({
    id: ewsId(inner, "FolderId"), parent: ewsId(inner, "ParentFolderId"), name: ewsValue(inner, "DisplayName"),
  })).filter((f) => f.id && f.id !== defaults.calendar && (!defaults.deleted || f.parent !== defaults.deleted))
    .map(({ id, name }) => ({ id, name: name || "Calendar" }));
}
/** Outlook keeps its calendar list (navigation links) as hidden items in the "Common Views" folder. */
function ewsCommonViewsRequest() {
  return ewsEnvelope('<m:FindFolder Traversal="Shallow"><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape>' +
    '<m:Restriction><t:IsEqualTo><t:FieldURI FieldURI="folder:DisplayName"/><t:FieldURIOrConstant><t:Constant Value="Common Views"/></t:FieldURIOrConstant></t:IsEqualTo></m:Restriction>' +
    '<m:ParentFolderIds><t:DistinguishedFolderId Id="root"/></m:ParentFolderIds></m:FindFolder>');
}
// MS-OXOCFG navigation shortcut properties.
const WLINK = { entryId: 0x684c, folderType: 0x684f, groupName: 0x6851, addressBook: 0x6854 };
const WLINK_CALENDAR_TYPE = "0278060000000000c000000000000046"; // {00067802-0000-0000-C000-000000000046}
const EMS_AB_PROVIDER = "dca740c8c042101ab4b908002b2fe182";
function ewsLinksRequest(folderId) {
  const props = [[WLINK.entryId, "Binary"], [WLINK.folderType, "Binary"], [WLINK.groupName, "String"], [WLINK.addressBook, "Binary"]]
    .map(([tag, type]) => `<t:ExtendedFieldURI PropertyTag="0x${tag.toString(16)}" PropertyType="${type}"/>`).join("");
  return ewsEnvelope(`<m:FindItem Traversal="Associated"><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties><t:FieldURI FieldURI="item:Subject"/>${props}</t:AdditionalProperties></m:ItemShape>` +
    '<m:IndexedPageItemView MaxEntriesReturned="500" Offset="0" BasePoint="Beginning"/>' +
    '<m:Restriction><t:IsEqualTo><t:FieldURI FieldURI="item:ItemClass"/><t:FieldURIOrConstant><t:Constant Value="IPM.Microsoft.WunderBar.Link"/></t:FieldURIOrConstant></t:IsEqualTo></m:Restriction>' +
    `<m:ParentFolderIds><t:FolderId Id="${xmlEscape(folderId)}"/></m:ParentFolderIds></m:FindItem>`);
}
function ewsBytes(base64) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = String(base64 || "").replace(/[^A-Za-z0-9+/]/g, "");
  const bytes = [];
  for (let i = 0, bits = 0, value = 0; i < clean.length; i++) {
    value = (value << 6) | alphabet.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((value >> bits) & 0xff); }
  }
  return bytes;
}
const ewsHex = (bytes) => bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
/** The X.500 address in an Exchange address-book entry id (a person's or group's mailbox), or "". */
function ewsAddressBookDn(base64) {
  const bytes = ewsBytes(base64);
  if (bytes.length < 30 || ewsHex(bytes.slice(4, 20)) !== EMS_AB_PROVIDER) return "";
  const end = bytes.indexOf(0, 28);
  const dn = String.fromCharCode(...bytes.slice(28, end < 0 ? bytes.length : end));
  return dn.startsWith("/") ? dn : "";
}
/** The calendars in Outlook's calendar list that live in someone else's mailbox: { name, group, dn, entryId (hex) }. */
function ewsCalendarLinks(xml) {
  const links = [], seen = new Set();
  for (const { inner } of [...ewsElements(xml, "Message"), ...ewsElements(xml, "Item")]) {
    const props = {};
    for (const p of ewsElements(inner, "ExtendedProperty")) {
      const tag = /PropertyTag="([^"]+)"/.exec(p.inner);
      if (tag) props[parseInt(tag[1], tag[1].startsWith("0x") ? 16 : 10)] = ewsValue(p.inner, "Value");
    }
    if (ewsHex(ewsBytes(props[WLINK.folderType])) !== WLINK_CALENDAR_TYPE) continue;
    const dn = ewsAddressBookDn(props[WLINK.addressBook]);
    if (!dn) continue; // a calendar in the user's own mailbox (FindFolder has it)
    const entryId = ewsHex(ewsBytes(props[WLINK.entryId])).toUpperCase();
    if (seen.has(`${dn}|${entryId}`)) continue;
    seen.add(`${dn}|${entryId}`);
    links.push({ name: ewsValue(inner, "Subject"), group: props[WLINK.groupName] || "", dn, entryId });
  }
  return links;
}
/** An address (an X.500 one from a calendar link, or a name) to the person's name and email. */
function ewsResolveRequest(entry) {
  return ewsEnvelope(`<m:ResolveNames ReturnFullContactData="false" SearchScope="ActiveDirectory"><m:UnresolvedEntry>${xmlEscape(entry)}</m:UnresolvedEntry></m:ResolveNames>`);
}
function ewsResolved(xml) {
  const [resolution] = ewsElements(xml, "Resolution");
  const [mailbox] = resolution ? ewsElements(resolution.inner, "Mailbox") : [];
  const email = mailbox ? ewsValue(mailbox.inner, "EmailAddress").toLowerCase() : "";
  return /^[^@\s]+@[^@\s]+$/.test(email) ? { name: ewsValue(mailbox.inner, "Name"), email } : null;
}
/** A folder's Outlook (hex) entry id to the id EWS uses, in that person's mailbox. */
function ewsConvertIdRequest(hexEntryId, mailbox) {
  return ewsEnvelope(`<m:ConvertId DestinationFormat="EwsId"><m:SourceIds><t:AlternateId Format="HexEntryId" Id="${xmlEscape(hexEntryId)}" Mailbox="${xmlEscape(mailbox)}"/></m:SourceIds></m:ConvertId>`);
}
function ewsConvertedId(xml) {
  return ewsResult(200, xml).ok ? ewsId(xml, "AlternateId") : "";
}

/** Each element called `name` (any namespace prefix): its attributes text and inner XML. */
function ewsElements(xml, name) {
  const pattern = new RegExp(`<(?:\\w+:)?${name}(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</(?:\\w+:)?${name}>)`, "g");
  return [...String(xml || "").matchAll(pattern)].map((m) => ({ attributes: m[1] || "", inner: m[2] || "" }));
}
function ewsValue(xml, name) {
  const [element] = ewsElements(xml, name);
  return element ? xmlUnescape(element.inner) : "";
}
function ewsId(xml, name, attribute = "Id") {
  const [element] = ewsElements(xml, name);
  const id = element && new RegExp(`\\b${attribute}="([^"]*)"`).exec(element.attributes);
  return id ? xmlUnescape(id[1]) : "";
}

const EWS_MY_RESPONSE = { Accept: "accept", Tentative: "tentative", Decline: "decline", Organizer: "organizer", NoResponseReceived: "none", Unknown: "none" };
/** An all-day event is a run of dates, but Exchange gives it as midnight to midnight in the zone it was made in
 *  (often UTC: 7 PM to 7 PM in New York, which would draw it on two days). Outlook and Apple show the dates:
 *  each end moves to the nearest local midnight. */
function allDayDates(start, end) {
  const nearest = (iso) => {
    const at = Date.parse(iso);
    const before = new Date(at); before.setHours(0, 0, 0, 0);
    const after = new Date(before); after.setDate(after.getDate() + 1);
    return at - before.getTime() <= after.getTime() - at ? before : after;
  };
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) return { start, end };
  const from = nearest(start);
  let to = nearest(end);
  if (to <= from) { to = new Date(from); to.setDate(to.getDate() + 1); }
  return { start: from.toISOString(), end: to.toISOString() };
}
/** Calendar items from a FindItem / GetItem answer. */
function ewsCalendarItems(xml) {
  return ewsElements(xml, "CalendarItem").map(({ inner }) => {
    const allDay = ewsValue(inner, "IsAllDayEvent") === "true";
    const when = allDay ? allDayDates(ewsValue(inner, "Start"), ewsValue(inner, "End")) : { start: ewsValue(inner, "Start"), end: ewsValue(inner, "End") };
    return {
    id: ewsId(inner, "ItemId"),
    uid: ewsValue(inner, "UID"),
    subject: ewsValue(inner, "Subject"),
    start: when.start,
    end: when.end,
    allDay,
    location: ewsValue(inner, "Location"),
    freeBusy: ewsValue(inner, "LegacyFreeBusyStatus"),
    response: EWS_MY_RESPONSE[ewsValue(inner, "MyResponseType")] || "none",
    cancelled: ewsValue(inner, "IsCancelled") === "true",
    // Outlook's reminder for this meeting: minutes before, or -1 for none; null when Exchange didn't say.
    reminder: ewsValue(inner, "ReminderIsSet") === "false" ? -1 : ewsValue(inner, "ReminderMinutesBeforeStart") ? Number(ewsValue(inner, "ReminderMinutesBeforeStart")) : null,
    };
  });
}
const EWS_ATTENDEE_RESPONSE = { Accept: "accept", Tentative: "tentative", Decline: "decline", Organizer: "organizer", NoResponseReceived: "none", Unknown: "none" };
/** A meeting's organizer and attendees ({ name, email, role, response? }), from a GetItem answer's
 *  CalendarItem. `response` is the attendee's answer when Exchange tracks it (the organizer's copy).
 *  Exchange can give an internal attendee as an X.500 address; only SMTP addresses are kept. */
function ewsPeople(xml) {
  const people = [];
  const seen = new Set();
  const add = (mailbox, role, response) => {
    const email = ewsValue(mailbox, "EmailAddress").toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email) || seen.has(email)) return;
    seen.add(email);
    const person = { name: ewsValue(mailbox, "Name"), email, role };
    if (response) person.response = EWS_ATTENDEE_RESPONSE[response] || "none";
    people.push(person);
  };
  for (const { inner } of ewsElements(xml, "Organizer")) for (const box of ewsElements(inner, "Mailbox")) add(box.inner, "organizer");
  for (const [list, role] of [["RequiredAttendees", "required"], ["OptionalAttendees", "optional"]]) {
    for (const { inner } of ewsElements(xml, list)) {
      for (const attendee of ewsElements(inner, "Attendee")) {
        for (const box of ewsElements(attendee.inner, "Mailbox")) add(box.inner, role, ewsValue(attendee.inner, "ResponseType"));
      }
    }
  }
  return people;
}
/** The fields of a meeting request/cancellation that tell whether it's current and where its calendar entry is. */
function ewsMeetingMessage(xml) {
  return {
    calendarItemId: ewsId(xml, "AssociatedCalendarItemId"),
    changeKey: ewsId(xml, "ItemId", "ChangeKey"),
    outOfDate: ewsValue(xml, "IsOutOfDate") === "true",
    response: EWS_MY_RESPONSE[ewsValue(xml, "ResponseType")] || "none",
    itemClass: ewsValue(xml, "ItemClass"),
  };
}

/** Success, or a readable reason, from an EWS CreateItem response. */
function ewsResult(status, text) {
  const responseClass = /ResponseClass="(\w+)"/.exec(text || "");
  const code = /<(?:\w+:)?ResponseCode>([^<]*)</.exec(text || "");
  // A Warning is only a success when Exchange still reports NoError.
  if (responseClass && (responseClass[1] === "Success" || (responseClass[1] === "Warning" && (!code || code[1] === "NoError")))) return { ok: true, code: code ? code[1] : "NoError" };
  const message = /<(?:\w+:)?MessageText>([^<]*)</.exec(text || "");
  if (responseClass) return { ok: false, code: code ? code[1] : "Error", message: EWS_ERRORS[code && code[1]] || xmlUnescape(message && message[1]) || "Exchange refused the response." };
  const fault = /<(?:\w+:)?faultstring[^>]*>([^<]*)</.exec(text || "");
  if (fault) return { ok: false, code: "fault", message: xmlUnescape(fault[1]) };
  if (status === 401 || status === 403) return { ok: false, code: String(status), message: "Exchange didn't accept Thunderbird's sign-in for this account. Check the account in Thunderbird." };
  return { ok: false, code: String(status), message: `Exchange answered HTTP ${status}.` };
}

/** Thunderbird's iMIP message body (CalItipEmailTransport._createTempImipFile), after its headers. */
function imipBody(text, calendar) {
  const crlf = (value) => String(value).replace(/\r?\n/g, "\r\n");
  return 'Content-type: multipart/mixed; boundary="Boundary_(ID_qyG4ZdjoAsiZ+Jo19dCbWQ)"\r\n' +
    "\r\n\r\n" +
    "--Boundary_(ID_qyG4ZdjoAsiZ+Jo19dCbWQ)\r\n" +
    "Content-type: multipart/alternative;\r\n" +
    ' boundary="Boundary_(ID_ryU4ZdJoASiZ+Jo21dCbwA)"\r\n' +
    "\r\n\r\n" +
    "--Boundary_(ID_ryU4ZdJoASiZ+Jo21dCbwA)\r\n" +
    "Content-type: text/plain; charset=UTF-8\r\n" +
    "Content-transfer-encoding: 8BIT\r\n" +
    "\r\n" +
    crlf(text) +
    "\r\n\r\n\r\n" +
    "--Boundary_(ID_ryU4ZdJoASiZ+Jo21dCbwA)\r\n" +
    "Content-type: text/calendar; method=REPLY; charset=UTF-8\r\n" +
    "Content-transfer-encoding: 8BIT\r\n" +
    "\r\n" +
    crlf(calendar) +
    "\r\n\r\n" +
    "--Boundary_(ID_ryU4ZdJoASiZ+Jo21dCbwA)--\r\n" +
    "\r\n" +
    "--Boundary_(ID_qyG4ZdjoAsiZ+Jo19dCbWQ)\r\n" +
    "Content-type: application/ics; name=invite.ics\r\n" +
    "Content-transfer-encoding: 8BIT\r\n" +
    "Content-disposition: attachment; filename=invite.ics\r\n" +
    "\r\n" +
    crlf(calendar) +
    "\r\n\r\n" +
    "--Boundary_(ID_qyG4ZdjoAsiZ+Jo19dCbWQ)--\r\n";
}

// ---- Making and changing events (the Calendar page) ----
const EWS_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const EWS_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const EWS_FREE_BUSY = ["Free", "Tentative", "Busy", "OOF", "WorkingElsewhere"];
/** EWS Recurrence for { kind, start: "YYYY-MM-DD" } (the pattern follows the first day). */
function ewsRecurrence(recurrence) {
  if (!recurrence || !/^\d{4}-\d{2}-\d{2}$/.test(recurrence.start || "")) return "";
  const [y, m, d] = recurrence.start.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, d));
  const weekday = EWS_WEEKDAYS[first.getUTCDay()];
  const pattern = {
    daily: "<t:DailyRecurrence><t:Interval>1</t:Interval></t:DailyRecurrence>",
    weekdays: "<t:WeeklyRecurrence><t:Interval>1</t:Interval><t:DaysOfWeek>Monday Tuesday Wednesday Thursday Friday</t:DaysOfWeek></t:WeeklyRecurrence>",
    weekly: `<t:WeeklyRecurrence><t:Interval>1</t:Interval><t:DaysOfWeek>${weekday}</t:DaysOfWeek></t:WeeklyRecurrence>`,
    biweekly: `<t:WeeklyRecurrence><t:Interval>2</t:Interval><t:DaysOfWeek>${weekday}</t:DaysOfWeek></t:WeeklyRecurrence>`,
    monthly: `<t:AbsoluteMonthlyRecurrence><t:Interval>1</t:Interval><t:DayOfMonth>${d}</t:DayOfMonth></t:AbsoluteMonthlyRecurrence>`,
    yearly: `<t:AbsoluteYearlyRecurrence><t:DayOfMonth>${d}</t:DayOfMonth><t:Month>${EWS_MONTHS[m - 1]}</t:Month></t:AbsoluteYearlyRecurrence>`,
  }[recurrence.kind];
  if (!pattern) return "";
  const end = /^\d{4}-\d{2}-\d{2}$/.test(recurrence.until || "")
    ? `<t:EndDateRecurrence><t:StartDate>${recurrence.start}</t:StartDate><t:EndDate>${recurrence.until}</t:EndDate></t:EndDateRecurrence>`
    : `<t:NoEndRecurrence><t:StartDate>${recurrence.start}</t:StartDate></t:NoEndRecurrence>`;
  return `<t:Recurrence>${pattern}${end}</t:Recurrence>`;
}
function ewsDate(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) throw new Error("The event needs a start and an end.");
  return new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function ewsAttendees(attendees) {
  const valid = (attendees || []).filter((a) => a && /^[^@\s]+@[^@\s]+$/.test(a.email || ""));
  return valid.map((a) => `<t:Attendee><t:Mailbox>${a.name ? `<t:Name>${xmlEscape(a.name)}</t:Name>` : ""}<t:EmailAddress>${xmlEscape(a.email)}</t:EmailAddress></t:Mailbox></t:Attendee>`).join("");
}
/** The fields of a new calendar item, in the order the EWS schema requires. */
function ewsEventFields(event) {
  if (!(Date.parse(event.end) >= Date.parse(event.start))) throw new Error("The event ends before it starts.");
  const reminder = Number.isFinite(event.reminder) ? event.reminder : -1;
  const people = ewsAttendees(event.attendees);
  const zone = event.timeZone ? `<t:StartTimeZone Id="${xmlEscape(event.timeZone)}"/><t:EndTimeZone Id="${xmlEscape(event.timeZone)}"/>` : "";
  return `<t:Subject>${xmlEscape(event.subject || "New event")}</t:Subject>` +
    (event.body ? `<t:Body BodyType="Text">${xmlEscape(event.body)}</t:Body>` : "") +
    `<t:ReminderIsSet>${reminder >= 0 ? "true" : "false"}</t:ReminderIsSet>` +
    (reminder >= 0 ? `<t:ReminderMinutesBeforeStart>${Math.round(reminder)}</t:ReminderMinutesBeforeStart>` : "") +
    `<t:Start>${ewsDate(event.start)}</t:Start><t:End>${ewsDate(event.end)}</t:End>` +
    `<t:IsAllDayEvent>${event.allDay ? "true" : "false"}</t:IsAllDayEvent>` +
    `<t:LegacyFreeBusyStatus>${EWS_FREE_BUSY.includes(event.freeBusy) ? event.freeBusy : "Busy"}</t:LegacyFreeBusyStatus>` +
    (event.location ? `<t:Location>${xmlEscape(event.location)}</t:Location>` : "") +
    (people ? `<t:RequiredAttendees>${people}</t:RequiredAttendees>` : "") +
    ewsRecurrence(event.recurrence) + zone;
}
/** Make an event on the account's calendar; with attendees, Exchange sends them the invitation. */
function ewsCreateEventRequest(event) {
  const send = ewsAttendees(event.attendees) ? "SendToAllAndSaveCopy" : "SendToNone";
  return ewsEnvelope(`<m:CreateItem SendMeetingInvitations="${send}"><m:SavedItemFolderId><t:DistinguishedFolderId Id="calendar"/></m:SavedItemFolderId>` +
    `<m:Items><t:CalendarItem>${ewsEventFields(event)}</t:CalendarItem></m:Items></m:CreateItem>`);
}
/** The item to change: one occurrence (its own id) or the whole series it belongs to. */
function ewsTarget(itemId, { series = false, changeKey = "" } = {}) {
  return series ? `<t:RecurringMasterItemId OccurrenceId="${xmlEscape(itemId)}"/>` : `<t:ItemId Id="${xmlEscape(itemId)}"${changeKey ? ` ChangeKey="${xmlEscape(changeKey)}"` : ""}/>`;
}
/** Change an event. Only the fields present in `event` change; with attendees (before or after) they're told. */
function ewsUpdateEventRequest(itemId, event, { series = false, changeKey = "", send = false } = {}) {
  const set = (uri, xml) => `<t:SetItemField><t:FieldURI FieldURI="${uri}"/><t:CalendarItem>${xml}</t:CalendarItem></t:SetItemField>`;
  const remove = (uri) => `<t:DeleteItemField><t:FieldURI FieldURI="${uri}"/></t:DeleteItemField>`;
  const changes = [];
  if ("subject" in event) changes.push(set("item:Subject", `<t:Subject>${xmlEscape(event.subject || "New event")}</t:Subject>`));
  if ("body" in event) changes.push(event.body ? set("item:Body", `<t:Body BodyType="Text">${xmlEscape(event.body)}</t:Body>`) : remove("item:Body"));
  if ("reminder" in event) {
    const on = Number.isFinite(event.reminder) && event.reminder >= 0;
    changes.push(set("item:ReminderIsSet", `<t:ReminderIsSet>${on}</t:ReminderIsSet>`));
    if (on) changes.push(set("item:ReminderMinutesBeforeStart", `<t:ReminderMinutesBeforeStart>${Math.round(event.reminder)}</t:ReminderMinutesBeforeStart>`));
  }
  if ("start" in event || "end" in event) {
    if (!(Date.parse(event.end) >= Date.parse(event.start))) throw new Error("The event ends before it starts.");
    changes.push(set("calendar:Start", `<t:Start>${ewsDate(event.start)}</t:Start>`), set("calendar:End", `<t:End>${ewsDate(event.end)}</t:End>`));
  }
  if ("allDay" in event) changes.push(set("calendar:IsAllDayEvent", `<t:IsAllDayEvent>${event.allDay ? "true" : "false"}</t:IsAllDayEvent>`));
  if ("freeBusy" in event) changes.push(set("calendar:LegacyFreeBusyStatus", `<t:LegacyFreeBusyStatus>${EWS_FREE_BUSY.includes(event.freeBusy) ? event.freeBusy : "Busy"}</t:LegacyFreeBusyStatus>`));
  if ("location" in event) changes.push(event.location ? set("calendar:Location", `<t:Location>${xmlEscape(event.location)}</t:Location>`) : remove("calendar:Location"));
  if ("attendees" in event) {
    const people = ewsAttendees(event.attendees);
    changes.push(people ? set("calendar:RequiredAttendees", `<t:RequiredAttendees>${people}</t:RequiredAttendees>`) : remove("calendar:RequiredAttendees"));
  }
  if ("recurrence" in event) {
    const recurrence = ewsRecurrence(event.recurrence);
    changes.push(recurrence ? set("calendar:Recurrence", recurrence) : remove("calendar:Recurrence"));
  }
  if (event.timeZone && ("start" in event || "recurrence" in event)) {
    changes.push(set("calendar:StartTimeZone", `<t:StartTimeZone Id="${xmlEscape(event.timeZone)}"/>`), set("calendar:EndTimeZone", `<t:EndTimeZone Id="${xmlEscape(event.timeZone)}"/>`));
  }
  if (!changes.length) throw new Error("Nothing to change.");
  return ewsEnvelope(`<m:UpdateItem MessageDisposition="SaveOnly" ConflictResolution="AlwaysOverwrite" SendMeetingInvitationsOrCancellations="${send ? "SendToAllAndSaveCopy" : "SendToNone"}">` +
    `<m:ItemChanges><t:ItemChange>${ewsTarget(itemId, { series, changeKey })}<t:Updates>${changes.join("")}</t:Updates></t:ItemChange></m:ItemChanges></m:UpdateItem>`);
}
/** Delete an event (to Deleted Items). `cancel` also sends the attendees a cancellation (a series). */
function ewsDeleteEventRequest(itemId, { series = false, cancel = false } = {}) {
  return ewsEnvelope(`<m:DeleteItem DeleteType="MoveToDeletedItems" SendMeetingCancellations="${cancel ? "SendToAllAndSaveCopy" : "SendToNone"}">` +
    `<m:ItemIds>${ewsTarget(itemId, { series })}</m:ItemIds></m:DeleteItem>`);
}
/** Outlook's "Cancel meeting" for one meeting (or occurrence) the user organized, with an optional note. */
function ewsCancelMeetingRequest(itemId, changeKey = "", note = "") {
  return ewsEnvelope('<m:CreateItem MessageDisposition="SendAndSaveCopy"><m:Items><t:CancelCalendarItem>' +
    referenceItem(itemId, changeKey) + (note ? `<t:NewBodyContent BodyType="Text">${xmlEscape(note)}</t:NewBodyContent>` : "") +
    "</t:CancelCalendarItem></m:Items></m:CreateItem>");
}

// ---- Free/busy (Find a time) ----
/** GetUserAvailability for some people between two instants, in UTC (Exchange answers in the zone it's asked in). */
function ewsAvailabilityRequest(emails, start, end, view = "FreeBusy") {
  const utc = "<t:Bias>0</t:Bias><t:Time>00:00:00</t:Time><t:DayOrder>1</t:DayOrder><t:Month>1</t:Month><t:DayOfWeek>Sunday</t:DayOfWeek>";
  const local = (iso) => new Date(Date.parse(iso)).toISOString().slice(0, 19);
  return ewsEnvelope('<m:GetUserAvailabilityRequest>' +
    `<t:TimeZone><t:Bias>0</t:Bias><t:StandardTime>${utc}</t:StandardTime><t:DaylightTime>${utc}</t:DaylightTime></t:TimeZone>` +
    `<m:MailboxDataArray>${emails.map((email) => `<t:MailboxData><t:Email><t:Address>${xmlEscape(email)}</t:Address></t:Email><t:AttendeeType>Required</t:AttendeeType><t:ExcludeConflicts>false</t:ExcludeConflicts></t:MailboxData>`).join("")}</m:MailboxDataArray>` +
    `<t:FreeBusyViewOptions><t:TimeWindow><t:StartTime>${local(start)}</t:StartTime><t:EndTime>${local(end)}</t:EndTime></t:TimeWindow>` +
    `<t:MergedFreeBusyIntervalInMinutes>30</t:MergedFreeBusyIntervalInMinutes><t:RequestedView>${view === "Detailed" ? "Detailed" : "FreeBusy"}</t:RequestedView></t:FreeBusyViewOptions>` +
    "</m:GetUserAvailabilityRequest>");
}
/** Each person's busy times ({ start, end, type } in ISO UTC), in the order asked; `error` when Exchange can't see
 *  their calendar (outside the organisation, or hidden). Free time isn't listed. */
function ewsAvailability(xml, emails) {
  const answers = ewsElements(xml, "FreeBusyResponse");
  return emails.map((email, i) => {
    const inner = answers[i] ? answers[i].inner : "";
    const message = ewsElements(inner, "ResponseMessage")[0];
    const failed = !message || !/ResponseClass="Success"/.test(message.attributes);
    if (failed) return { email, busy: [], error: xmlUnescape((/<(?:\w+:)?MessageText>([^<]*)</.exec(inner) || [])[1] || "") || "Exchange couldn't see this calendar." };
    const busy = ewsElements(inner, "CalendarEvent").map(({ inner: event }) => {
      const block = {
        start: new Date(`${ewsValue(event, "StartTime")}Z`).toISOString(),
        end: new Date(`${ewsValue(event, "EndTime")}Z`).toISOString(),
        type: ewsValue(event, "BusyType") || "Busy",
      };
      // What they share beyond the time (the Detailed view, when their calendar allows it).
      const [details] = ewsElements(event, "CalendarEventDetails");
      if (details) Object.assign(block, { subject: ewsValue(details.inner, "Subject"), location: ewsValue(details.inner, "Location"), private: ewsValue(details.inner, "IsPrivate") === "true" });
      return block;
    }).filter((b) => b.type !== "Free" && b.type !== "NoData");
    return { email, busy };
  });
}

/** Events read from another calendar, marked as that calendar's (read-only on the page). */
function sharedItems(items, calendar) {
  return items.map((item) => ({ ...item, accountId: calendar.accountId, calendarId: calendar.key, shared: true, response: "shared" }));
}
/** Busy times of a calendar the user can't read, as events: "Busy" (or the subject and place it shares). */
function busyItems(busy, calendar) {
  const seen = new Set();
  return busy.filter((b) => !seen.has(`${b.start}|${b.end}|${b.subject || ""}`) && seen.add(`${b.start}|${b.end}|${b.subject || ""}`)).map((b) => ({
    id: `busy:${b.start}:${b.end}:${b.subject || ""}`, uid: "", subject: b.private ? "" : b.subject || "", start: b.start, end: b.end, allDay: false,
    location: b.private ? "" : b.location || "", freeBusy: b.type === "Tentative" || b.type === "OOF" || b.type === "WorkingElsewhere" ? b.type : "Busy",
    response: "shared", cancelled: false, accountId: calendar.accountId, calendarId: calendar.key, shared: true, busyOnly: true,
  }));
}
/** [from, to) in pieces of at most `days` (Exchange answers free/busy for up to 42 days at a time). */
function timeChunks(start, end, days = 31) {
  const out = [];
  for (let from = Date.parse(start), to = Date.parse(end); from < to; from += days * 86400000) out.push([new Date(from).toISOString(), new Date(Math.min(to, from + days * 86400000)).toISOString()]);
  return out;
}

// ---- Thunderbird's own calendars (Google and other CalDAV calendars, subscriptions, local ones) ----
// Ember's id for one: "cal:" and Thunderbird's calendar id (Exchange accounts are their account key).
const TB_PREFIX = "cal:";
const ICAL_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
/** The editor's repeat choice for an RRULE: "" for none, "custom" for a pattern it can't show (kept as it is). */
function repeatOfRule(rule) {
  const text = String(rule || "").replace(/^RRULE:/i, "").trim().toUpperCase();
  if (!text) return "";
  const p = Object.fromEntries(text.split(";").map((part) => part.split("=")));
  const interval = Number(p.INTERVAL || 1);
  const days = (p.BYDAY || "").split(",").filter(Boolean);
  if (p.BYSETPOS || p.BYWEEKNO || p.BYYEARDAY || p.BYHOUR || p.BYMINUTE || days.some((d) => /\d/.test(d))) return "custom";
  if (p.FREQ === "DAILY") return interval === 1 && !days.length ? "daily" : "custom";
  if (p.FREQ === "WEEKLY") {
    if (interval === 1 && days.join(",") === "MO,TU,WE,TH,FR") return "weekdays";
    if (days.length <= 1) return interval === 1 ? "weekly" : interval === 2 ? "biweekly" : "custom";
    return "custom";
  }
  if (p.FREQ === "MONTHLY") return interval === 1 && !days.length ? "monthly" : "custom";
  if (p.FREQ === "YEARLY") return interval === 1 && !days.length ? "yearly" : "custom";
  return "custom";
}
/** The same for an Exchange item's Recurrence element. */
function repeatOfEws(xml) {
  const found = /<t:Recurrence>([\s\S]*?)<\/t:Recurrence>/.exec(xml || "");
  if (!found) return "";
  const r = found[1];
  const interval = Number((/<t:Interval>(\d+)<\/t:Interval>/.exec(r) || [])[1] || 1);
  if (/<t:DailyRecurrence>/.test(r)) return interval === 1 ? "daily" : "custom";
  const weekly = /<t:WeeklyRecurrence>[\s\S]*?<t:DaysOfWeek>([^<]*)<\/t:DaysOfWeek>/.exec(r);
  if (weekly) {
    const days = weekly[1].trim().split(/\s+/);
    if (interval === 1 && (days.join(" ") === "Monday Tuesday Wednesday Thursday Friday" || days.join(" ") === "Weekday")) return "weekdays";
    if (days.length === 1 && EWS_WEEKDAYS.includes(days[0])) return interval === 1 ? "weekly" : interval === 2 ? "biweekly" : "custom";
    return "custom";
  }
  if (/<t:AbsoluteMonthlyRecurrence>/.test(r)) return interval === 1 ? "monthly" : "custom";
  if (/<t:AbsoluteYearlyRecurrence>/.test(r)) return "yearly";
  return "custom";
}
/** The RRULE value for the editor's repeat choice ("" for none). */
function icalRule(recurrence) {
  if (!recurrence || !/^\d{4}-\d{2}-\d{2}$/.test(recurrence.start || "")) return "";
  const [y, m, d] = recurrence.start.split("-").map(Number);
  const day = ICAL_DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return {
    daily: "FREQ=DAILY", weekdays: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", weekly: `FREQ=WEEKLY;BYDAY=${day}`, biweekly: `FREQ=WEEKLY;INTERVAL=2;BYDAY=${day}`,
    monthly: `FREQ=MONTHLY;BYMONTHDAY=${d}`, yearly: `FREQ=YEARLY;BYMONTH=${m};BYMONTHDAY=${d}`,
  }[recurrence.kind] || "";
}
const ICAL_BUSY = { FREE: "Free", TENTATIVE: "Tentative", BUSY: "Busy", OOF: "OOF", WORKINGELSEWHERE: "WorkingElsewhere" };
/** Show-as from an event's TRANSP and Outlook's busy status (X-MICROSOFT-CDO-BUSYSTATUS, which Outlook and Google keep). */
function icalFreeBusy(transp, busyStatus) {
  return ICAL_BUSY[String(busyStatus || "").toUpperCase()] || (String(transp || "").toUpperCase() === "TRANSPARENT" ? "Free" : "Busy");
}
/** TRANSP and Outlook's busy status for a show-as choice. */
function icalShowAs(freeBusy) {
  const status = Object.keys(ICAL_BUSY).find((k) => ICAL_BUSY[k] === freeBusy) || "BUSY";
  return { transp: status === "FREE" ? "TRANSPARENT" : "OPAQUE", busyStatus: status };
}
const ICAL_RESPONSE = { ACCEPTED: "accept", TENTATIVE: "tentative", DECLINED: "decline", "NEEDS-ACTION": "none", DELEGATED: "accept" };
const ICAL_PARTSTAT = { accept: "ACCEPTED", tentative: "TENTATIVE", decline: "DECLINED" };
/** An event's id on a Thunderbird calendar: its UID, and for one occurrence of a series its recurrence id
 *  ("D20261117" for a day, "T20261117T150000Z" for a time). */
function tbItemId(uid, recurrence) { return recurrence ? `${uid}#${recurrence}` : uid; }
function tbParseId(id) {
  const match = /^(.*)#([DT]\d{8}(?:T\d{6}Z)?)$/.exec(String(id || ""));
  return match ? { uid: match[1], recurrence: match[2] } : { uid: String(id || ""), recurrence: "" };
}
/** Whether a mail account's calendars are Google's (Gmail, or Google Workspace through Gmail's servers). */
function isGoogleMail(email, incomingHost) {
  return /@(gmail|googlemail)\.com$/i.test(email || "") || /(^|\.)(gmail|googlemail)\.com$/i.test(incomingHost || "");
}

if (typeof module === "object") module.exports = { repeatOfRule, repeatOfEws, icalRule, icalFreeBusy, icalShowAs, tbItemId, tbParseId, isGoogleMail, allDayDates, ewsCalendarFolder, ewsDefaultFoldersRequest, ewsDefaultFolders, ewsCalendarFoldersRequest, ewsCalendarFolders, ewsCommonViewsRequest, ewsLinksRequest, ewsAddressBookDn, ewsCalendarLinks, ewsResolveRequest, ewsResolved, ewsConvertIdRequest, ewsConvertedId, sharedItems, busyItems, timeChunks, ewsAvailabilityRequest, ewsAvailability,ewsRecurrence, ewsCreateEventRequest, ewsUpdateEventRequest, ewsDeleteEventRequest, ewsCancelMeetingRequest, ewsResponseRequest, ewsRemoveRequest, ewsGetItemRequest, ewsDeleteRequest, ewsCalendarViewRequest, ewsCalendarItems, ewsMeetingMessage, ewsPeople, ewsElements, ewsResult, imipBody };

var sparkCalendar = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    const { ExtensionError } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs").ExtensionUtils;
    const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
    const { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
    const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    Cu.importGlobalProperties(["fetch", "btoa", "TextEncoder", "AbortController"]); // not in the Experiment sandbox by default
    /** Errors reach the extension as text only when they are ExtensionErrors. */
    const readable = (work) => async (...args) => {
      try { return await work(...args); } catch (error) { throw error instanceof ExtensionError ? error : new ExtensionError(error && error.message || String(error)); }
    };

    function header(messageId) {
      const hdr = context.extension.messageManager.get(messageId);
      if (!hdr) throw new ExtensionError(`Message not found: ${messageId}.`);
      return hdr;
    }
    /** Endpoint and sign-in for an Exchange (EWS) server, or null when Ember can't reach it. */
    function serverTarget(server) {
      if (!server || server.type !== "ews") return null;
      const url = server.getStringValue("ews_url");
      if (!/^https:\/\//i.test(url)) return null;
      if (server.authMethod === Ci.nsMsgAuthMethod.OAuth2) return { server, url, oauth: true };
      if (server.authMethod === Ci.nsMsgAuthMethod.passwordCleartext && server.password) return { server, url, oauth: false };
      return null;
    }
    /** Exchange item, endpoint and sign-in for a message, or null when it isn't on Exchange. */
    function exchangeTarget(hdr) {
      const target = serverTarget(hdr.folder && hdr.folder.server);
      const itemId = target && hdr.getStringProperty("ewsId");
      return itemId ? { ...target, itemId } : null;
    }
    // One sign-in module per server: it keeps the access token until it expires (the agenda asks every few minutes).
    const oauthModules = new Map();
    async function authorization(target) {
      if (!target.oauth) return `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${target.server.username}:${target.server.password}`)))}`;
      let oauth = oauthModules.get(target.server.key);
      if (!oauth) {
        oauth = Cc["@mozilla.org/mail/oauth2-module;1"].createInstance(Ci.msgIOAuth2Module);
        if (!oauth.initFromMail(target.server)) throw new ExtensionError("Thunderbird has no sign-in details for this Exchange account.");
        oauthModules.set(target.server.key, oauth);
      }
      const token = await new Promise((resolve, reject) => oauth.getAccessToken({
        onSuccess: resolve,
        onFailure: (error) => {
          // Start again next time rather than keep asking a sign-in that failed.
          oauthModules.delete(target.server.key);
          const detail = error && (error.message || (typeof error === "number" ? `0x${(error >>> 0).toString(16)}` : String(error)));
          reject(new ExtensionError(`Thunderbird couldn't sign in to Exchange${detail ? ` (${detail})` : ""}.`));
        },
      }));
      return `Bearer ${token}`;
    }
    /** POST one EWS request; returns the answer text, or throws a readable error. */
    async function ews(target, body, { check = true } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      try {
        const reply = await fetch(target.url, {
          method: "POST",
          credentials: "omit",
          signal: controller.signal,
          headers: { "Content-Type": "text/xml; charset=utf-8", Authorization: await authorization(target) },
          body,
        });
        const text = await reply.text();
        if (check) {
          const result = ewsResult(reply.status, text);
          if (!result.ok) throw new ExtensionError(result.message);
        } else if (!reply.ok && !/ResponseClass=/.test(text)) throw new ExtensionError(ewsResult(reply.status, text).message);
        return text;
      } catch (error) {
        if (error && error.name === "AbortError") throw new ExtensionError("Exchange didn't answer in time.");
        throw error;
      } finally { clearTimeout(timer); }
    }
    const MEETING_FIELDS = ["item:ItemClass", "meeting:AssociatedCalendarItemId", "meeting:IsOutOfDate", "meeting:ResponseType"];
    async function meetingMessage(target) {
      return ewsMeetingMessage(await ews(target, ewsGetItemRequest([target.itemId], MEETING_FIELDS)));
    }
    /** The meeting's entry on the user's calendar, or null when it isn't there. */
    async function calendarEntry(target, calendarItemId) {
      if (!calendarItemId) return null;
      const answer = await ews(target, ewsGetItemRequest([calendarItemId], ["calendar:MyResponseType", "calendar:IsCancelled"]), { check: false });
      const [item] = ewsResult(200, answer).ok ? ewsCalendarItems(answer) : [];
      return item || null;
    }
    function accountOf(server) {
      const account = MailServices.accounts.findAccountForServer(server);
      return account ? account.key : "";
    }
    /** Every Exchange account whose calendar Ember can reach. */
    function calendarTargets() {
      return MailServices.accounts.accounts.map((account) => {
        const target = serverTarget(account.incomingServer);
        return target && { ...target, accountId: account.key, account };
      }).filter(Boolean);
    }
    /** The calendar of every Exchange account Ember can reach, between two instants. */
    async function calendarView(start, end, details) {
      const targets = MailServices.accounts.accounts.map((account) => serverTarget(account.incomingServer)).filter(Boolean);
      const events = [], errors = [];
      await Promise.all(targets.map(async (target) => {
        const accountId = accountOf(target.server);
        try {
          let text = await ews(target, ewsCalendarViewRequest(start, end), { check: false });
          // Some servers refuse UID or reminder fields in FindItem; the view still works without them.
          if (/ErrorInvalidPropertyRequest/.test(text)) text = await ews(target, ewsCalendarViewRequest(start, end, false), { check: false });
          const result = ewsResult(200, text);
          if (!result.ok) throw new ExtensionError(result.message);
          const items = ewsCalendarItems(text).map((item) => ({ ...item, accountId }));
          if (details) {
            const wanted = items.filter((item) => !item.cancelled && item.id).slice(0, 40);
            if (wanted.length) {
              const ids = wanted.map((item) => item.id);
              // Body for join links; organizer and attendees for "Before your meeting". A server that
              // refuses the attendee fields still gives the bodies.
              let details = await ews(target, ewsGetItemRequest(ids, ["item:Body", ...PEOPLE_FIELDS], "Text"), { check: false }).catch(() => "");
              if (!ewsResult(200, details).ok) details = await ews(target, ewsGetItemRequest(ids, ["item:Body"], "Text"), { check: false }).catch(() => "");
              const byId = new Map(ewsElements(details, "CalendarItem").map(({ inner }) => [ewsId(inner, "ItemId"), inner]));
              for (const item of items) {
                const inner = byId.get(item.id);
                if (inner === undefined) continue;
                item.body = ewsValue(inner, "Body").slice(0, 30000);
                item.attendees = ewsPeople(inner);
              }
            }
          }
          events.push(...items);
        } catch (error) {
          errors.push({ accountId, name: target.server.prettyName, message: error && error.message || String(error) });
        }
      }));
      // Thunderbird's own calendars (Google and other CalDAV ones, subscriptions) alongside.
      const tb = await tbView(start, end, details).catch((error) => ({ calendars: 1, events: [], errors: [{ accountId: TB_PREFIX, name: "Thunderbird's calendars", message: errorText(error) }] }));
      return { accounts: targets.length + tb.calendars, events: [...events, ...tb.events], errors: [...errors, ...tb.errors] };
    }

    /** One account's other calendars: its own extra calendars, and the people's (and groups') calendars in its
     *  Outlook calendar list. Each part is skipped when Exchange won't give it. */
    async function otherCalendarsOf(target) {
      const { accountId } = target;
      const found = [], errors = [];
      try {
        const defaults = ewsDefaultFolders(await ews(target, ewsDefaultFoldersRequest(), { check: false }));
        const text = await ews(target, ewsCalendarFoldersRequest());
        for (const folder of ewsCalendarFolders(text, defaults)) found.push({ key: `${accountId}|${folder.id}`, accountId, kind: "folder", name: folder.name, folderId: folder.id, group: "" });
      } catch (error) { errors.push(`calendar folders: ${error && error.message || error}`); }
      try {
        const views = ewsId(await ews(target, ewsCommonViewsRequest()), "FolderId");
        const links = views ? ewsCalendarLinks(await ews(target, ewsLinksRequest(views))).slice(0, 40) : [];
        for (const link of links) {
          const person = ewsResolved(await ews(target, ewsResolveRequest(link.dn), { check: false }).catch(() => ""));
          if (!person) continue;
          // The linked folder (a person can share a calendar other than their main one); else their main calendar.
          const folderId = link.entryId ? ewsConvertedId(await ews(target, ewsConvertIdRequest(link.entryId, person.email), { check: false }).catch(() => "")) : "";
          found.push({ key: `${accountId}|${person.email}${folderId ? `|${folderId}` : ""}`, accountId, kind: "person", name: link.name || person.name || person.email, email: person.email, folderId, group: link.group });
        }
      } catch (error) { errors.push(`calendar list: ${error && error.message || error}`); }
      return { found, errors };
    }
    // How each other calendar could be read last time ("folder", "mailbox" or "busy"), so failing ways aren't asked again.
    const sharedWays = new Map();
    /** Another calendar's events between two instants: read in full when the user may, else their busy times. */
    async function readShared(target, calendar, start, end) {
      const ways = [];
      if (calendar.folderId) ways.push(["folder", ewsCalendarFolder({ folderId: calendar.folderId })]);
      if (calendar.email) ways.push(["mailbox", ewsCalendarFolder({ email: calendar.email })]);
      const known = sharedWays.get(calendar.key);
      let reason = "";
      for (const [way, folder] of ways) {
        if (known === "busy" || (known === "mailbox" && way === "folder")) continue;
        let text = await ews(target, ewsCalendarViewRequest(start, end, true, folder), { check: false });
        if (/ErrorInvalidPropertyRequest/.test(text)) text = await ews(target, ewsCalendarViewRequest(start, end, false, folder), { check: false });
        const result = ewsResult(200, text);
        if (result.ok) { sharedWays.set(calendar.key, way); return { access: "full", events: sharedItems(ewsCalendarItems(text), calendar) }; }
        reason = result.message;
      }
      if (!calendar.email) throw new ExtensionError(reason || "Exchange didn't open this calendar.");
      // Not allowed to read it: when they're busy, with the subject and place if they share that much.
      const busy = [];
      for (const [from, to] of timeChunks(start, end)) {
        const [person] = ewsAvailability(await ews(target, ewsAvailabilityRequest([calendar.email], from, to, "Detailed"), { check: false }), [calendar.email]);
        if (person.error) throw new ExtensionError(person.error);
        busy.push(...person.busy);
      }
      sharedWays.set(calendar.key, "busy");
      return { access: "busy", events: busyItems(busy, calendar) };
    }

    // ---- Thunderbird's own calendars: Google (CalDAV, which Thunderbird signs in to), iCloud and other CalDAV
    // calendars, subscriptions and local ones. Ember reads and changes them through Thunderbird, which syncs them and
    // sends invitations and answers as its own calendar does. Exchange calendars stay with EWS above.
    let tbModulesLoaded = null;
    const tbModules = () => tbModulesLoaded ||= {
      ...ChromeUtils.importESModule("resource:///modules/CalEvent.sys.mjs"),
      ...ChromeUtils.importESModule("resource:///modules/CalAttendee.sys.mjs"),
      ...ChromeUtils.importESModule("resource:///modules/CalAlarm.sys.mjs"),
      ...ChromeUtils.importESModule("resource:///modules/CalRecurrenceInfo.sys.mjs"),
      ...ChromeUtils.importESModule("resource:///modules/CalTransactionManager.sys.mjs"),
    };
    const errorText = (error) => (error && error.message) || String(error);
    function hostOf(calendar) { try { return calendar.uri.host || ""; } catch { return ""; } }
    /** The address a Thunderbird calendar belongs to: its sign-in (Google's is the Gmail address), else its identity. */
    function tbOwner(calendar) {
      const username = String(calendar.getProperty("username") || "").toLowerCase();
      if (/^[^@\s]+@[^@\s]+$/.test(username)) return username;
      const key = calendar.getProperty("imip.identity.key");
      const identity = key && MailServices.accounts.allIdentities.find((i) => i.key === key);
      return identity && identity.email ? identity.email.toLowerCase() : "";
    }
    function tbIdentity(calendar) {
      try { return cal.provider.getEmailIdentityOfCalendar(calendar); } catch { return null; }
    }
    /** Thunderbird's calendars Ember shows: not turned off, and not an Exchange calendar Ember already reads itself. */
    function tbCalendarList() {
      const exchangeHosts = new Set(calendarTargets().map((t) => { try { return new URL(t.url).host; } catch { return ""; } }).filter(Boolean));
      return cal.manager.getCalendars().filter((c) => !c.getProperty("disabled") && !/ews|owl|exchange/i.test(c.type || "") && !exchangeHosts.has(hostOf(c)));
    }
    /** Those with something to show: a local calendar (Thunderbird's empty "Home") only once it has events. */
    async function tbCalendars() {
      const out = [];
      for (const c of tbCalendarList()) {
        if (c.type === "storage" || c.type === "memory") {
          const any = await c.getItemsAsArray(Ci.calICalendar.ITEM_FILTER_TYPE_EVENT, 1, null, null).catch(() => []);
          if (!any.length) continue;
        }
        out.push(c);
      }
      return out;
    }
    function tbWritable(c) {
      try { return !c.readOnly && cal.acl.isCalendarWritable(c) && cal.acl.userCanAddItemsToCalendar(c); } catch { return false; }
    }
    /** How the sidebar lists one: under its mail account (or address), with Thunderbird's colour for it. */
    function tbInfo(c) {
      const owner = tbOwner(c);
      const account = owner && MailServices.accounts.accounts.find((a) => a.identities.some((i) => (i.email || "").toLowerCase() === owner));
      const identity = tbIdentity(c);
      const group = account ? account.incomingServer.prettyName : owner || (c.type === "storage" ? "On this Mac" : hostOf(c) || "Other calendars");
      return {
        accountId: TB_PREFIX + c.id, name: c.name || "Calendar", email: owner || (identity && identity.email ? identity.email.toLowerCase() : ""),
        kind: "thunderbird", group, color: c.getProperty("color") || "", readOnly: !tbWritable(c), google: /googleusercontent\.com$|google\.com$/i.test(hostOf(c)),
      };
    }
    function tbCalendar(accountId) {
      const c = String(accountId || "").startsWith(TB_PREFIX) && cal.manager.getCalendarById(String(accountId).slice(TB_PREFIX.length));
      if (!c) throw new ExtensionError("This calendar isn't in Thunderbird any more.");
      return c;
    }
    /** An instant as ISO text; an all-day date as its local midnight (a time with no zone is local too). */
    function tbDate(dt) {
      if (!dt) return "";
      if (dt.isDate || (dt.timezone && dt.timezone.isFloating)) return new Date(dt.year, dt.month, dt.day, dt.isDate ? 0 : dt.hour, dt.isDate ? 0 : dt.minute, dt.isDate ? 0 : dt.second).toISOString();
      return new Date(dt.nativeTime / 1000).toISOString();
    }
    function tbRecurrence(item) {
      const rid = item.recurrenceId;
      if (!rid) return "";
      return rid.isDate ? `D${rid.icalString.slice(0, 8)}` : `T${rid.getInTimezone(cal.dtz.UTC).icalString}`;
    }
    function tbPeople(item) {
      const people = [], seen = new Set();
      const add = (attendee, role) => {
        const email = cal.email.removeMailTo(attendee.id || "").toLowerCase();
        if (!/^[^@\s]+@[^@\s]+$/.test(email) || seen.has(email)) return;
        seen.add(email);
        const person = { name: attendee.commonName || "", email, role };
        if (role !== "organizer") person.response = ICAL_RESPONSE[attendee.participationStatus] || "none";
        people.push(person);
      };
      if (item.organizer) add(item.organizer, "organizer");
      for (const attendee of item.getAttendees()) add(attendee, attendee.role === "OPT-PARTICIPANT" ? "optional" : "required");
      return people;
    }
    /** The user's answer when this is someone else's meeting on their calendar; "organizer" for their own events. */
    function tbResponse(item, c) {
      try {
        if (c.supportsScheduling && c.getSchedulingSupport().isInvitation(item)) {
          const me = cal.itip.getInvitedAttendee(item, c);
          return ICAL_RESPONSE[me && me.participationStatus] || "none";
        }
      } catch {}
      return "organizer";
    }
    function tbEvent(item, c, details) {
      const alarm = item.getAlarms().find((a) => a.related !== Ci.calIAlarm.ALARM_RELATED_ABSOLUTE && a.offset);
      const event = {
        id: tbItemId(item.id, tbRecurrence(item)), uid: item.id, subject: item.title || "",
        start: tbDate(item.startDate), end: tbDate(item.endDate || item.startDate), allDay: !!(item.startDate && item.startDate.isDate),
        location: item.getProperty("LOCATION") || "",
        freeBusy: icalFreeBusy(item.getProperty("TRANSP"), item.getProperty("X-MICROSOFT-CDO-BUSYSTATUS")),
        response: tbResponse(item, c), cancelled: item.getProperty("STATUS") === "CANCELLED",
        reminder: alarm ? Math.max(0, Math.round(-alarm.offset.inSeconds / 60)) : -1,
        accountId: TB_PREFIX + c.id,
      };
      if (!tbWritable(c)) event.readOnly = true;
      if (details) Object.assign(event, { body: String(item.getProperty("DESCRIPTION") || "").slice(0, 30000), attendees: tbPeople(item) });
      return event;
    }
    /** Every shown Thunderbird calendar's events between two instants (each occurrence of a series on its own). */
    /** The instant (ms or an ISO string) as a calIDateTime in `timezone`. (cal.dtz.jsDateToDateTime(date, zone)
     *  keeps the JS date's local clock reading and labels it with the zone: local midnight became midnight UTC, so
     *  every range was off by the UTC offset and an evening's events fell outside it.) */
    function tbInstant(value, timezone = cal.dtz.UTC) {
      const dt = cal.createDateTime();
      dt.nativeTime = new Date(value).getTime() * 1000;
      return dt.getInTimezone(timezone);
    }
    async function tbView(start, end, details) {
      const from = tbInstant(start), to = tbInstant(end);
      const calendars = await tbCalendars();
      const events = [], errors = [];
      await Promise.all(calendars.map(async (c) => {
        try {
          const items = await c.getItemsAsArray(Ci.calICalendar.ITEM_FILTER_TYPE_EVENT | Ci.calICalendar.ITEM_FILTER_CLASS_OCCURRENCES, 0, from, to);
          for (const item of items) events.push(tbEvent(item, c, details));
        } catch (error) {
          errors.push({ accountId: TB_PREFIX + c.id, name: c.name, message: errorText(error) });
        }
      }));
      return { calendars: calendars.length, events, errors };
    }
    /** An event (one occurrence, or a whole series) and the series it belongs to. */
    async function tbItem(c, itemId) {
      const { uid, recurrence } = tbParseId(itemId);
      const parent = await c.getItem(uid);
      if (!parent) throw new ExtensionError("This event isn't on the calendar any more.");
      if (!recurrence || !parent.recurrenceInfo) return { parent, item: parent };
      const item = parent.recurrenceInfo.getOccurrenceFor(cal.createDateTime(recurrence.slice(1)));
      if (!item) throw new ExtensionError("This occurrence isn't on the calendar any more.");
      return { parent, item };
    }
    /** Thunderbird sends invitations, updates and cancellations itself (or leaves them to a server that schedules,
     *  like Google). `send` false: nobody is told. */
    const tbResponseMode = (send) => ({ responseMode: send ? Ci.calIItipItem.AUTO : Ci.calIItipItem.NONE });
    function tbWhen(iso, allDay) {
      const at = new Date(iso);
      if (!Number.isFinite(at.getTime())) throw new ExtensionError("The event needs a start and an end.");
      if (allDay) {
        const day = cal.createDateTime();
        day.resetTo(at.getFullYear(), at.getMonth(), at.getDate(), 0, 0, 0, cal.dtz.floating);
        day.isDate = true;
        return day;
      }
      return tbInstant(at.getTime(), cal.dtz.defaultTimezone);
    }
    /** Write the editor's fields (only those given) onto a Thunderbird event. */
    function tbApply(item, event, c, isNew) {
      const { CalAttendee, CalAlarm, CalRecurrenceInfo } = tbModules();
      if ("subject" in event) item.title = event.subject || "New event";
      if ("body" in event) { if (event.body) item.setProperty("DESCRIPTION", event.body); else item.deleteProperty("DESCRIPTION"); }
      if ("location" in event) { if (event.location) item.setProperty("LOCATION", event.location); else item.deleteProperty("LOCATION"); }
      if ("start" in event || "end" in event || "allDay" in event) {
        const allDay = "allDay" in event ? !!event.allDay : !!(item.startDate && item.startDate.isDate);
        if (!(Date.parse(event.end) >= Date.parse(event.start))) throw new ExtensionError("The event ends before it starts.");
        item.startDate = tbWhen(event.start, allDay);
        item.endDate = tbWhen(event.end, allDay);
      }
      if ("freeBusy" in event) {
        const { transp, busyStatus } = icalShowAs(event.freeBusy);
        item.setProperty("TRANSP", transp);
        item.setProperty("X-MICROSOFT-CDO-BUSYSTATUS", busyStatus);
      }
      if ("reminder" in event) {
        item.clearAlarms();
        if (Number.isFinite(event.reminder) && event.reminder >= 0) {
          const alarm = new CalAlarm();
          const offset = cal.createDuration();
          offset.inSeconds = -Math.round(event.reminder) * 60;
          alarm.related = Ci.calIAlarm.ALARM_RELATED_START;
          alarm.offset = offset;
          alarm.action = "DISPLAY";
          item.addAlarm(alarm);
        }
      }
      if ("attendees" in event) {
        const wanted = (event.attendees || []).filter((a) => a && /^[^@\s]+@[^@\s]+$/.test(a.email || ""));
        const kept = new Map(item.getAttendees().map((a) => [cal.email.removeMailTo(a.id).toLowerCase(), a]));
        const identity = tbIdentity(c);
        const me = String(tbOwner(c) || (identity && identity.email) || "").toLowerCase();
        item.removeAllAttendees();
        for (const person of wanted) {
          const email = person.email.trim().toLowerCase();
          if (email === me) continue;
          const before = kept.get(email);
          if (before) { item.addAttendee(before.clone()); continue; }
          const attendee = new CalAttendee();
          attendee.id = cal.email.prependMailTo(email);
          if (person.name) attendee.commonName = person.name;
          attendee.role = "REQ-PARTICIPANT";
          attendee.participationStatus = "NEEDS-ACTION";
          attendee.rsvp = "TRUE";
          attendee.userType = "INDIVIDUAL";
          item.addAttendee(attendee);
        }
        if (wanted.length && !item.organizer && me) {
          const organizer = new CalAttendee();
          organizer.id = cal.email.prependMailTo(me);
          if (identity && identity.fullName) organizer.commonName = identity.fullName;
          organizer.isOrganizer = true;
          item.organizer = organizer;
        }
      }
      if ("recurrence" in event && (isNew || !item.recurrenceId)) {
        const rule = icalRule(event.recurrence);
        if (!rule) item.recurrenceInfo = null;
        else {
          const info = new CalRecurrenceInfo(item);
          info.appendRecurrenceItem(cal.createRecurrenceRule(`RRULE:${rule}`));
          item.recurrenceInfo = info;
        }
      }
    }
    /** Mail accounts Thunderbird could look up calendars for (Exchange ones Ember reads itself), with whether one is
     *  connected already. */
    function connectable() {
      const owners = new Set(cal.manager.getCalendars().map((c) => tbOwner(c)).filter(Boolean));
      return MailServices.accounts.accounts.flatMap((account) => {
        const server = account.incomingServer;
        if (!server || !["imap", "pop3"].includes(server.type) || serverTarget(server)) return [];
        const identity = account.defaultIdentity || account.identities[0];
        const email = String(identity && identity.email || "").toLowerCase();
        if (!/^[^@\s]+@[^@\s]+$/.test(email)) return [];
        return [{ accountId: account.key, name: server.prettyName, email, google: isGoogleMail(email, server.hostName), connected: owners.has(email) }];
      });
    }
    /** Find an account's calendars as Thunderbird's account setup does (Google's through its sign-in, others by
     *  the address's domain), and add the new ones to Thunderbird. */
    async function connectCalendars(accountId) {
      const account = MailServices.accounts.getAccount(accountId);
      const server = account && account.incomingServer;
      if (!server) throw new ExtensionError("That mail account isn't in Thunderbird any more.");
      const identity = account.defaultIdentity || account.identities[0];
      const email = String(identity && identity.email || "");
      const domain = email.split("@")[1] || "";
      // Live tests point this at a local calendar server instead of the address's domain.
      const testLocation = Services.prefs.getStringPref("extensions.spark.testCalendarLocation", "");
      const locations = testLocation ? [testLocation] : [`https://${domain}`];
      try {
        if (!testLocation && server.hostName && server.hostName !== domain &&
            Services.eTLD.getSchemelessSiteFromHost(server.hostName) === Services.eTLD.getSchemelessSiteFromHost(domain)) locations.push(`https://${server.hostName}`);
      } catch {}
      const password = server.authMethod === Ci.nsMsgAuthMethod.OAuth2 ? "" : (server.password || "");
      let found = null, failure = null;
      for (const location of locations) {
        try {
          const result = await cal.provider.detection.detect(email, password, location, !!password, [], {});
          if (result && result.size) { found = result; break; }
        } catch (error) { failure = error; }
      }
      if (!found) {
        const why = failure && failure.name === "CanceledError" ? "the sign-in was cancelled" : failure && failure.name === "AuthFailedError" ? "the sign-in didn't work" : "none were found";
        throw new ExtensionError(`Thunderbird couldn't find calendars for ${email}: ${why}.`);
      }
      // CalDAV's list when there is one (other ways of finding them can list the same calendars).
      const lists = [...found.entries()].sort(([a], [b]) => (b.type === "caldav") - (a.type === "caldav"));
      const [, calendars] = lists[0];
      const existing = new Set(cal.manager.getCalendars().map((c) => c.uri.spec));
      const added = [], loading = new Set();
      // Wait (up to 20 s) for Thunderbird's first sync of the new calendars, so their events show at once.
      let done = () => {};
      const synced = new Promise((resolve) => { done = resolve; });
      const observer = {
        QueryInterface: ChromeUtils.generateQI(["calIObserver"]),
        onStartBatch() {}, onEndBatch() {}, onAddItem() {}, onModifyItem() {}, onDeleteItem() {}, onPropertyChanged() {}, onPropertyDeleting() {},
        onLoad(calendar) { loading.delete(calendar && calendar.id); if (!loading.size) done(); },
        onError(calendar) { loading.delete(calendar && calendar.id); if (!loading.size) done(); },
      };
      cal.manager.addCalendarObserver(observer);
      try {
        for (const c of calendars) {
          if (existing.has(c.uri.spec)) continue;
          existing.add(c.uri.spec);
          if (identity) c.setProperty("imip.identity.key", identity.key);
          loading.add(c.id);
          cal.manager.registerCalendar(c);
          added.push(c.name);
        }
        if (loading.size) await Promise.race([synced, new Promise((resolve) => setTimeout(resolve, 20000))]);
      } finally { cal.manager.removeCalendarObserver(observer); }
      return { added, found: calendars.length };
    }
    /** The user's busy times on their Thunderbird calendars (Find a time; what they mark Free is left out). */
    async function tbBusy(start, end) {
      const view = await tbView(start, end, false);
      return view.events.filter((e) => e.freeBusy !== "Free" && !e.cancelled && e.response !== "decline").map((e) => ({ start: e.start, end: e.end, type: e.freeBusy }));
    }
    /** Other people's busy times through Thunderbird's free/busy lookup (CalDAV servers that offer it). */
    function tbFreeBusy(email, start, end) {
      return new Promise((resolve) => {
        const intervals = [];
        const timer = setTimeout(() => resolve(null), 15000);
        try {
          cal.freeBusyService.getFreeBusyIntervals(cal.email.prependMailTo(email), tbInstant(start), tbInstant(end), Ci.calIFreeBusyInterval.BUSY_ALL, {
            // Called once per calendar server that answers (others give nothing), the last time no longer pending.
            onResult(request, result) {
              if (result && result.length) intervals.push(...result);
              if (request && request.isPending) return;
              clearTimeout(timer);
              const busy = intervals.filter((i) => i.freeBusyType !== Ci.calIFreeBusyInterval.FREE && i.freeBusyType !== Ci.calIFreeBusyInterval.UNKNOWN)
                .map((i) => ({ start: tbDate(i.interval.start), end: tbDate(i.interval.end), type: i.freeBusyType === Ci.calIFreeBusyInterval.BUSY_TENTATIVE ? "Tentative" : "Busy" }));
              resolve(intervals.length ? busy : null);
            },
          });
        } catch { clearTimeout(timer); resolve(null); }
      });
    }

    function sendFile(identity, accountKey, fields, file) {
      return new Promise((resolve, reject) => {
        const listener = {
          QueryInterface: ChromeUtils.generateQI(["nsIMsgSendListener"]),
          onStartSending() {}, onSendProgress() {}, onStatus() {}, onGetDraftFolderURI() {}, onTransportSecurityError() {},
          onStopSending(msgId, status, message) {
            if (Components.isSuccessCode(status)) resolve();
            else reject(new ExtensionError(message || `Thunderbird couldn't send the response (0x${(status >>> 0).toString(16)}).`));
          },
          onSendNotPerformed() { reject(new ExtensionError("Thunderbird didn't send the response.")); },
        };
        Cc["@mozilla.org/messengercompose/send;1"].createInstance(Ci.nsIMsgSend).sendMessageFile(
          identity, accountKey, fields, file, true, false,
          Services.io.offline ? Ci.nsIMsgSend.nsMsgQueueForLater : Ci.nsIMsgSend.nsMsgDeliverNow,
          null, listener, "");
      });
    }

    return {
      sparkCalendar: {
        async serverResponse(messageId) {
          return !!exchangeTarget(header(messageId));
        },
        /** What the user's Exchange mailbox knows about a meeting request or cancellation:
         *  their current answer, whether a newer version exists, whether it's on their calendar. */
        meetingStatus: readable(async (messageId) => {
          const target = exchangeTarget(header(messageId));
          if (!target) return null;
          const message = await meetingMessage(target);
          const status = { response: message.response, outOfDate: message.outOfDate, onCalendar: false, cancelled: false, itemClass: message.itemClass };
          const item = await calendarEntry(target, message.calendarItemId);
          if (item) Object.assign(status, { onCalendar: true, response: item.response, cancelled: item.cancelled });
          return status;
        }),
        respond: readable(async (messageId, response, options) => {
          options = options || {}; // an omitted optional argument arrives as null
          const target = exchangeTarget(header(messageId));
          if (!target) throw new ExtensionError("This invitation isn't in an Exchange mailbox.");
          const send = options.send !== false;
          // The request's current version and calendar entry, to answer that version and check the result.
          const before = await meetingMessage(target).catch(() => null);
          const text = await ews(target, ewsResponseRequest(response, target.itemId, { note: options.note || "", send, changeKey: before ? before.changeKey : "" }));
          // Not sending saves the response as a draft; remove that draft (never a calendar item).
          if (!send) {
            for (const name of ["MeetingResponse", "Message"]) {
              for (const { inner } of ewsElements(ewsElements(text, "Items").map((e) => e.inner).join(""), name)) {
                const id = ewsId(inner, "ItemId");
                if (id) await ews(target, ewsDeleteRequest(id)).catch(() => {});
              }
            }
          }
          // Exchange's "success" isn't proof: read the calendar entry it should have updated.
          let verified = "unknown";
          if (before && before.calendarItemId) {
            const item = await calendarEntry(target, before.calendarItemId).catch(() => null);
            verified = item ? item.response : "missing";
          }
          return { via: "exchange", sent: send, code: ewsResult(200, text).code, verified };
        }),
        removeFromCalendar: readable(async (messageId) => {
          const target = exchangeTarget(header(messageId));
          if (!target) throw new ExtensionError("This cancellation isn't in an Exchange mailbox.");
          const before = await meetingMessage(target).catch(() => null);
          await ews(target, ewsRemoveRequest(target.itemId, before ? before.changeKey : ""));
          return { removed: true };
        }),
        /** Answer a meeting from its calendar entry (an Agenda clash), as Outlook's calendar does. */
        /** The Exchange calendars Ember can reach: one per account (its default Calendar folder). */
        calendars: readable(async () => [
          ...calendarTargets().map(({ accountId, account, server }) => {
            const identity = account.defaultIdentity || account.identities[0];
            return { accountId, name: server.prettyName, email: identity ? identity.email : server.username, kind: "exchange", group: server.prettyName };
          }),
          ...(await tbCalendars()).map(tbInfo),
        ]),
        /** Mail accounts (not Exchange) whose calendars Thunderbird could connect, and whether it has. */
        connectable: readable(async () => connectable()),
        /** Find an account's calendars (Google's through its sign-in) and add them to Thunderbird. */
        connectCalendars: readable(async (accountId) => connectCalendars(accountId)),
        /** The user's copy of an invitation on a Thunderbird calendar they can answer from (Google puts invitations
         *  there itself), by its UID; null when there's none. */
        findInvitation: readable(async (uid) => {
          if (!uid) return null;
          for (const c of await tbCalendars()) {
            if (!tbWritable(c)) continue;
            const item = await c.getItem(uid).catch(() => null);
            if (item && tbResponse(item, c) !== "organizer") return { accountId: TB_PREFIX + c.id, id: item.id, response: tbResponse(item, c) };
          }
          return null;
        }),
        /** One event's notes (plain text), organizer and attendees with their answers, for the Calendar page. */
        // With options.series: the series an occurrence belongs to (its first time, and how it repeats).
        eventDetails: readable(async (accountId, itemId, options) => {
          const series = !!(options && options.series);
          if (String(accountId).startsWith(TB_PREFIX)) {
            const c = tbCalendar(accountId);
            const { parent, item: occurrence } = await tbItem(c, itemId);
            const item = series ? parent : occurrence;
            const rules = parent.recurrenceInfo ? parent.recurrenceInfo.getRecurrenceItems() : [];
            const repeat = !rules.length ? "" : rules.length > 1 || rules[0].isNegative || !(rules[0] instanceof Ci.calIRecurrenceRule) ? "custom" : repeatOfRule(rules[0].icalString);
            return {
              ...tbEvent(item, c, true), changeKey: "", isMeeting: item.getAttendees().length > 0,
              type: item.recurrenceId ? "Occurrence" : parent.recurrenceInfo ? "RecurringMaster" : "Single", repeat,
            };
          }
          const target = calendarTargets().find((t) => t.accountId === accountId);
          if (!target) throw new ExtensionError("This event isn't on an Exchange calendar Ember can reach.");
          const extra = ["calendar:CalendarItemType", "calendar:IsMeeting", "item:ReminderIsSet", "item:ReminderMinutesBeforeStart", ...(series ? ["calendar:Recurrence"] : [])];
          let text = await ews(target, ewsGetItemRequest([itemId], [...CALENDAR_FIELDS, ...extra, "item:Body", ...PEOPLE_FIELDS], "Text", { master: series }), { check: false });
          // A server that refuses the attendee fields still gives the notes.
          if (!ewsResult(200, text).ok) text = await ews(target, ewsGetItemRequest([itemId], [...CALENDAR_FIELDS, "item:Body", ...(series ? ["calendar:Recurrence"] : [])], "Text", { master: series }));
          const [element] = ewsElements(text, "CalendarItem");
          if (!element) throw new ExtensionError("Exchange didn't return this event.");
          const [item] = ewsCalendarItems(text);
          return {
            ...item, accountId, body: ewsValue(element.inner, "Body").slice(0, 30000), attendees: ewsPeople(element.inner),
            changeKey: ewsId(element.inner, "ItemId", "ChangeKey"), type: ewsValue(element.inner, "CalendarItemType") || "Single",
            isMeeting: ewsValue(element.inner, "IsMeeting") === "true", repeat: repeatOfEws(element.inner),
          };
        }),
        /** Make an event on an account's calendar (with attendees, Exchange invites them). Returns its id. */
        createEvent: readable(async (accountId, event) => {
          if (String(accountId).startsWith(TB_PREFIX)) {
            const c = tbCalendar(accountId);
            if (!tbWritable(c)) throw new ExtensionError(`Thunderbird can't add events to “${c.name}”.`);
            const { CalEvent, CalAddTransaction } = tbModules();
            const item = new CalEvent();
            item.id = cal.getUUID();
            item.calendar = c.superCalendar || c;
            tbApply(item, { reminder: -1, ...(event || {}) }, c, true);
            const invited = item.getAttendees().length > 0;
            const transaction = new CalAddTransaction(item, c, null, tbResponseMode(invited));
            await transaction.doTransaction();
            return { id: item.id, changeKey: "", invited };
          }
          const target = calendarTargets().find((t) => t.accountId === accountId);
          if (!target) throw new ExtensionError("Choose an Exchange calendar Ember can reach.");
          const text = await ews(target, ewsCreateEventRequest(event || {}));
          return { id: ewsId(text, "ItemId"), changeKey: ewsId(text, "ItemId", "ChangeKey"), invited: !!ewsAttendees(event && event.attendees) };
        }),
        /** Change an event the user owns: this occurrence, or the whole series. `send` tells its attendees. */
        updateEvent: readable(async (accountId, itemId, event, options) => {
          options = options || {};
          if (String(accountId).startsWith(TB_PREFIX)) {
            const c = tbCalendar(accountId);
            const { parent, item } = await tbItem(c, itemId);
            const before = options.series ? parent : item;
            const after = before.clone();
            tbApply(after, event || {}, c, false);
            const { CalModifyTransaction } = tbModules();
            await new CalModifyTransaction(after, c, before, tbResponseMode(!!options.send)).doTransaction();
            return { updated: true };
          }
          const target = calendarTargets().find((t) => t.accountId === accountId);
          if (!target) throw new ExtensionError("This event isn't on an Exchange calendar Ember can reach.");
          await ews(target, ewsUpdateEventRequest(itemId, event || {}, { series: !!options.series, changeKey: options.changeKey || "", send: !!options.send }));
          return { updated: true };
        }),
        /** Delete an event (Deleted Items keeps it). `cancel` sends the attendees a cancellation, with `note`. */
        deleteEvent: readable(async (accountId, itemId, options) => {
          options = options || {};
          if (String(accountId).startsWith(TB_PREFIX)) {
            const c = tbCalendar(accountId);
            const { parent, item } = await tbItem(c, itemId);
            const { CalDeleteTransaction, CalModifyTransaction } = tbModules();
            const mode = tbResponseMode(!!options.cancel);
            if (item === parent || options.series) {
              await new CalDeleteTransaction(parent, c, null, mode).doTransaction();
            } else {
              // One occurrence: the series without it (Thunderbird tells the invitees that one is cancelled).
              const after = parent.clone();
              after.recurrenceInfo.removeOccurrenceAt(item.recurrenceId);
              await new CalModifyTransaction(after, c, parent, mode).doTransaction();
            }
            return { deleted: true };
          }
          const target = calendarTargets().find((t) => t.accountId === accountId);
          if (!target) throw new ExtensionError("This event isn't on an Exchange calendar Ember can reach.");
          if (options.cancel && !options.series) await ews(target, ewsCancelMeetingRequest(itemId, options.changeKey || "", options.note || ""));
          else await ews(target, ewsDeleteEventRequest(itemId, { series: !!options.series, cancel: !!options.cancel }));
          return { deleted: true };
        }),
        /** Busy times of some people (and the user, by their address) from Exchange, between two instants (a week at most). */
        availability: readable(async (accountId, emails, start, end) => {
          const from = Date.parse(start), to = Date.parse(end);
          if (!(from < to) || to - from > 8 * 86400000) throw new ExtensionError("Ask for up to a week of availability.");
          const people = [...new Set((emails || []).map((e) => String(e).trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+$/.test(e)))].slice(0, 20);
          if (!people.length) return [];
          const target = String(accountId).startsWith(TB_PREFIX) ? null : calendarTargets().find((t) => t.accountId === accountId) || calendarTargets()[0];
          if (!target) {
            // A Thunderbird calendar: the user's busy times from their calendars there; other people's from
            // Thunderbird's free/busy lookup, when their server offers it.
            const fromIso = new Date(from).toISOString(), toIso = new Date(to).toISOString();
            const c = String(accountId).startsWith(TB_PREFIX) ? cal.manager.getCalendarById(String(accountId).slice(TB_PREFIX.length)) : null;
            const me = new Set([c && tbOwner(c), ...MailServices.accounts.allIdentities.map((i) => String(i.email || "").toLowerCase())].filter(Boolean));
            return Promise.all(people.map(async (email) => {
              if (me.has(email)) return { email, busy: await tbBusy(fromIso, toIso) };
              const busy = await tbFreeBusy(email, fromIso, toIso);
              return busy ? { email, busy } : { email, busy: [], error: "Their calendar server doesn't share when they're busy." };
            }));
          }
          return ewsAvailability(await ews(target, ewsAvailabilityRequest(people, new Date(from).toISOString(), new Date(to).toISOString()), { check: false }), people);
        }),
        /** The calendars besides each account's main one: its extra calendars, and the shared calendars in its
         *  Outlook calendar list. */
        otherCalendars: readable(async () => {
          const results = await Promise.all(calendarTargets().map((target) => otherCalendarsOf(target)));
          return { calendars: results.flatMap((r) => r.found), errors: results.flatMap((r) => r.errors) };
        }),
        /** Events of other calendars ({ key, accountId, folderId?, email? }) between two instants (two months at most). */
        sharedView: readable(async (calendars, start, end) => {
          const from = Date.parse(start), to = Date.parse(end);
          if (!(from < to) || to - from > 62 * 86400000) throw new ExtensionError("Choose a calendar range of up to two months.");
          const targets = calendarTargets();
          const events = [], errors = [], access = {};
          await Promise.all((calendars || []).slice(0, 30).map(async (calendar) => {
            const target = targets.find((t) => t.accountId === calendar.accountId);
            try {
              if (!target) throw new ExtensionError("Its Exchange account isn't in Thunderbird any more.");
              const read = await readShared(target, calendar, new Date(from).toISOString(), new Date(to).toISOString());
              events.push(...read.events);
              access[calendar.key] = read.access;
            } catch (error) {
              errors.push({ key: calendar.key, message: error && error.message || String(error) });
            }
          }));
          return { events, errors, access };
        }),
        respondEvent: readable(async (accountId, itemId, response) => {
          if (String(accountId).startsWith(TB_PREFIX)) {
            const c = tbCalendar(accountId);
            const { parent, item } = await tbItem(c, itemId);
            const me = cal.itip.getInvitedAttendee(item, c);
            if (!me) throw new ExtensionError("You aren't invited to this meeting on this calendar.");
            const after = item.clone();
            const answer = after.getAttendeeById(me.id) || me.clone();
            after.removeAttendee(answer);
            const changed = answer.clone();
            changed.participationStatus = ICAL_PARTSTAT[response];
            after.addAttendee(changed);
            const { CalModifyTransaction } = tbModules();
            // The answer goes to the organizer as Thunderbird's own calendar sends it (Google's server tells them itself).
            await new CalModifyTransaction(after, c, item, tbResponseMode(true)).doTransaction();
            const reread = await tbItem(c, itemId).catch(() => null);
            const verified = reread ? tbResponse(reread.item, c) : "missing";
            return { via: "calendar", sent: true, code: "", verified: verified === "organizer" ? "unknown" : verified };
          }
          const account = MailServices.accounts.getAccount(accountId);
          const target = account && serverTarget(account.incomingServer);
          if (!target) throw new ExtensionError("This meeting isn't on an Exchange calendar Ember can reach.");
          const text = await ews(target, ewsResponseRequest(response, itemId));
          const item = await calendarEntry(target, itemId).catch(() => null);
          return { via: "exchange", sent: true, code: ewsResult(200, text).code, verified: item ? item.response : "missing" };
        }),
        calendarView: readable(async (start, end, options) => {
          options = options || {};
          const from = Date.parse(start), to = Date.parse(end);
          if (!(from < to) || to - from > 62 * 86400000) throw new ExtensionError("Choose a calendar range of up to two months.");
          return calendarView(new Date(from).toISOString(), new Date(to).toISOString(), !!options.details);
        }),
        sendReply: readable(async ({ identityId, to, subject, text, calendar }) => {
          const identity = MailServices.accounts.allIdentities.find((i) => i.key === identityId);
          if (!identity) throw new ExtensionError(`Unknown identity: ${identityId}.`);
          const account = MailServices.accounts.accounts.find((a) => a.identities.some((i) => i.key === identity.key));
          const recipients = cal.email.validateRecipientList(to);
          if (!recipients) throw new ExtensionError("The organizer's address isn't valid.");
          const messageId = Cc["@mozilla.org/messengercompose/computils;1"].createInstance(Ci.nsIMsgCompUtils).msgGenerateMessageId(identity, null);
          const mail = cal.invitation.getHeaderSection(messageId, identity, recipients, subject) + imipBody(text, calendar);
          const path = await IOUtils.createUniqueFile(PathUtils.tempDir, "spark-imip.eml", 0o600);
          await IOUtils.writeUTF8(path, mail);
          const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
          file.initWithPath(path);
          const fields = Cc["@mozilla.org/messengercompose/composefields;1"].createInstance(Ci.nsIMsgCompFields);
          fields.to = recipients;
          const from = identity.fullName ? `${identity.fullName} <${identity.email}>` : identity.email;
          fields.from = cal.email.validateRecipientList(from) === from ? from : identity.email;
          fields.replyTo = identity.replyTo;
          fields.organization = identity.organization;
          fields.messageId = messageId;
          if (identity.doCc) fields.cc = cal.email.validateRecipientList(identity.doCcList);
          if (identity.doBcc) fields.bcc = cal.email.validateRecipientList(identity.doBccList);
          await sendFile(identity, account ? account.key : "", fields, file);
          return { via: "imip", queued: Services.io.offline };
        }),
      },
    };
  }
};
this.sparkCalendar = sparkCalendar;
