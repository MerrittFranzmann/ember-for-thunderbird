import { describe, expect, it } from "vitest";
import source from "../public/experiments/calendar/implementation.js?raw";

type Part = { type: string; params: Record<string, string>; disposition: string; body: string };
/** Leaf parts of a MIME message (enough for the iMIP layout). */
function leaves(raw: string): Part[] {
  const split = raw.indexOf("\r\n\r\n");
  const head = raw.slice(0, split).replace(/\r\n[ \t]+/g, " "), body = raw.slice(split + 4);
  const field = (name: string) => new RegExp(`^${name}:\\s*(.*)$`, "im").exec(head)?.[1] || "";
  const [type, ...rest] = field("content-type").split(";").map((s) => s.trim());
  const params = Object.fromEntries(rest.map((p) => { const [k, ...v] = p.split("="); return [k.toLowerCase(), v.join("=").replace(/^"|"$/g, "")]; }));
  if (!type.toLowerCase().startsWith("multipart/")) return [{ type: type.toLowerCase(), params, disposition: field("content-disposition").split(";")[0], body }];
  const parts = body.split(`--${params.boundary}`).slice(1, -1);
  return parts.flatMap((part) => leaves(part.replace(/^\r\n/, "")));
}

// The Experiment is a plain script Thunderbird loads; evaluate it with a stub ExtensionAPI base.
const module = { exports: {} as any };
new Function("module", "ExtensionCommon", source).call({}, module, { ExtensionAPI: class {} });
const { ewsResponseRequest, ewsRemoveRequest, ewsGetItemRequest, ewsCalendarViewRequest, ewsCalendarItems, ewsMeetingMessage, ewsResult, imipBody } = module.exports;

describe("calendar experiment", () => {
  it("asks Exchange for Outlook's meeting response on the referenced invitation", () => {
    const xml = ewsResponseRequest("tentative", 'AAMk<id>&"x"');
    expect(xml).toContain('<m:CreateItem MessageDisposition="SendAndSaveCopy">');
    expect(xml).toContain('<t:TentativelyAcceptItem><t:ReferenceItemId Id="AAMk&lt;id&gt;&amp;&quot;x&quot;"/></t:TentativelyAcceptItem>');
    expect(ewsResponseRequest("accept", "1")).toContain("<t:AcceptItem>");
    expect(ewsResponseRequest("decline", "1")).toContain("<t:DeclineItem>");
    expect(() => ewsResponseRequest("maybe", "1")).toThrow();
  });

  it("adds a note, or saves without telling the organizer (Outlook's Don't send a response)", () => {
    const xml = ewsResponseRequest("accept", "1", { note: "See you <there> & then", send: false });
    expect(xml).toContain('<m:CreateItem MessageDisposition="SaveOnly">');
    expect(xml).toContain('<t:AcceptItem><t:Body BodyType="Text">See you &lt;there&gt; &amp; then</t:Body><t:ReferenceItemId Id="1"/></t:AcceptItem>');
    expect(ewsRemoveRequest("C&1")).toContain('<m:CreateItem><m:Items><t:RemoveItem><t:ReferenceItemId Id="C&amp;1"/></t:RemoveItem>');
    // Outlook answers a specific version of the request: its ChangeKey.
    expect(ewsResponseRequest("accept", "1", { changeKey: "CK/2" })).toContain('<t:ReferenceItemId Id="1" ChangeKey="CK/2"/>');
    expect(ewsRemoveRequest("1", "CK3")).toContain('<t:ReferenceItemId Id="1" ChangeKey="CK3"/>');
  });
  it("asks for the calendar view and meeting fields Outlook uses", () => {
    const view = ewsCalendarViewRequest("2026-10-28T04:00:00.000Z", "2026-10-29T04:00:00.000Z");
    expect(view).toContain('<m:CalendarView MaxEntriesReturned="1000" StartDate="2026-10-28T04:00:00.000Z" EndDate="2026-10-29T04:00:00.000Z"/>');
    expect(view).toContain('<t:DistinguishedFolderId Id="calendar"/>');
    expect(view).toContain('calendar:UID');
    expect(view).toContain("item:ReminderMinutesBeforeStart");
    expect(ewsCalendarViewRequest("a", "b", false)).not.toContain("calendar:UID");
    expect(ewsCalendarViewRequest("a", "b", false)).not.toContain("item:ReminderIsSet");
    const get = ewsGetItemRequest(["A", "B"], ["item:Body"], "Text");
    expect(get).toContain("<t:BaseShape>IdOnly</t:BaseShape><t:BodyType>Text</t:BodyType>");
    expect(get).toContain('<m:ItemIds><t:ItemId Id="A"/><t:ItemId Id="B"/></m:ItemIds>');
  });
  it("reads calendar items and meeting messages from Exchange's answers", () => {
    const answer = '<m:FindItemResponseMessage ResponseClass="Success"><m:RootFolder><t:Items>' +
      '<t:CalendarItem><t:ItemId Id="AAA=" ChangeKey="x"/><t:Subject>Weekly sync &amp; plan&#xD;</t:Subject><t:Start>2026-10-28T17:30:00Z</t:Start><t:End>2026-10-28T18:00:00Z</t:End>' +
      '<t:IsAllDayEvent>false</t:IsAllDayEvent><t:LegacyFreeBusyStatus>Busy</t:LegacyFreeBusyStatus><t:Location>Room 2</t:Location><t:MyResponseType>Accept</t:MyResponseType><t:IsCancelled>false</t:IsCancelled><t:UID>040000</t:UID>' +
      '<t:ReminderIsSet>true</t:ReminderIsSet><t:ReminderMinutesBeforeStart>15</t:ReminderMinutesBeforeStart></t:CalendarItem>' +
      '<t:CalendarItem><t:ItemId Id="BBB"/><t:Subject>Day off</t:Subject><t:IsAllDayEvent>true</t:IsAllDayEvent><t:MyResponseType>Organizer</t:MyResponseType><t:ReminderIsSet>false</t:ReminderIsSet></t:CalendarItem>' +
      '</t:Items></m:RootFolder></m:FindItemResponseMessage>';
    const [first, second] = ewsCalendarItems(answer);
    expect(first).toEqual({ id: "AAA=", uid: "040000", subject: "Weekly sync & plan", start: "2026-10-28T17:30:00Z", end: "2026-10-28T18:00:00Z", allDay: false, location: "Room 2", freeBusy: "Busy", response: "accept", cancelled: false, reminder: 15 });
    expect(second).toMatchObject({ id: "BBB", allDay: true, response: "organizer", start: "", reminder: -1 });
    const request = '<t:MeetingRequest><t:ItemId Id="M" ChangeKey="CK&amp;1"/><t:ItemClass>IPM.Schedule.Meeting.Request</t:ItemClass><t:ResponseType>NoResponseReceived</t:ResponseType><t:AssociatedCalendarItemId Id="CAL=" ChangeKey="k"/><t:IsOutOfDate>true</t:IsOutOfDate></t:MeetingRequest>';
    expect(ewsMeetingMessage(request)).toEqual({ calendarItemId: "CAL=", changeKey: "CK&1", outOfDate: true, response: "none", itemClass: "IPM.Schedule.Meeting.Request" });
  });
  it("reads Exchange's answer", () => {
    expect(ewsResult(200, '<m:CreateItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>')).toEqual({ ok: true, code: "NoError" });
    // A Warning with a real error code is not a success.
    expect(ewsResult(200, '<m:CreateItemResponseMessage ResponseClass="Warning"><m:MessageText>Partly done</m:MessageText><m:ResponseCode>ErrorBatchProcessingStopped</m:ResponseCode>')).toMatchObject({ ok: false, code: "ErrorBatchProcessingStopped" });
    expect(ewsResult(200, '<m:CreateItemResponseMessage ResponseClass="Warning"><m:ResponseCode>NoError</m:ResponseCode>')).toEqual({ ok: true, code: "NoError" });
    expect(ewsResult(200, '<m:CreateItemResponseMessage ResponseClass="Error"><m:MessageText>The specified object was not found in the store.</m:MessageText><m:ResponseCode>ErrorItemNotFound</m:ResponseCode>'))
      .toMatchObject({ ok: false, code: "ErrorItemNotFound", message: expect.stringContaining("no longer in your Exchange mailbox") });
    expect(ewsResult(200, '<m:CreateItemResponseMessage ResponseClass="Error"><m:MessageText>Something &amp; else</m:MessageText><m:ResponseCode>ErrorOther</m:ResponseCode>')).toMatchObject({ ok: false, message: "Something & else" });
    expect(ewsResult(500, "<s:Fault><faultstring xml:lang=\"en-US\">The request failed schema validation</faultstring></s:Fault>")).toMatchObject({ ok: false, message: "The request failed schema validation" });
    expect(ewsResult(401, "")).toMatchObject({ ok: false, code: "401" });
  });

  it("builds Thunderbird's iMIP layout: text and an inline method=REPLY calendar, plus invite.ics", () => {
    const calendar = "BEGIN:VCALENDAR\r\nMETHOD:REPLY\r\nEND:VCALENDAR\r\n";
    const parts = leaves("From: a@b.test\r\nTo: c@d.test\r\nSubject: Accepted: x\r\nMIME-version: 1.0\r\n" + imipBody("Ada has accepted this invitation.", calendar));
    expect(parts.map((p) => p.type)).toEqual(["text/plain", "text/calendar", "application/ics"]);
    expect(parts[1].params.method).toBe("REPLY");
    expect(parts[1].body).toContain("METHOD:REPLY");
    expect(parts[2].disposition).toBe("attachment");
    expect(parts[0].body.trim()).toBe("Ada has accepted this invitation.");
  });
});

describe("meeting attendees (Before your meeting)", () => {
  const { ewsPeople } = module.exports;
  it("reads the organizer and attendees, SMTP addresses only, each once", () => {
    const item = '<t:ItemId Id="EV1"/><t:Body BodyType="Text">Agenda &lt;t:Mailbox&gt;</t:Body>' +
      '<t:Organizer><t:Mailbox><t:Name>Ada Lovelace</t:Name><t:EmailAddress>Ada@Example.org</t:EmailAddress><t:RoutingType>SMTP</t:RoutingType></t:Mailbox></t:Organizer>' +
      '<t:RequiredAttendees><t:Attendee><t:Mailbox><t:Name>Me</t:Name><t:EmailAddress>me@example.org</t:EmailAddress></t:Mailbox><t:ResponseType>Accept</t:ResponseType></t:Attendee>' +
      '<t:Attendee><t:Mailbox><t:Name>Ada Lovelace</t:Name><t:EmailAddress>ada@example.org</t:EmailAddress></t:Mailbox></t:Attendee>' +
      '<t:Attendee><t:Mailbox><t:Name>Room 2</t:Name><t:EmailAddress>/O=EXCHANGELABS/OU=EXCHANGE/CN=RECIPIENTS/CN=ROOM2</t:EmailAddress><t:RoutingType>EX</t:RoutingType></t:Mailbox></t:Attendee></t:RequiredAttendees>' +
      '<t:OptionalAttendees><t:Attendee><t:Mailbox><t:Name>Grace &amp; Co</t:Name><t:EmailAddress>grace@navy.test</t:EmailAddress></t:Mailbox></t:Attendee></t:OptionalAttendees>';
    expect(ewsPeople(item)).toEqual([
      { name: "Ada Lovelace", email: "ada@example.org", role: "organizer" },
      { name: "Me", email: "me@example.org", role: "required", response: "accept" },
      { name: "Grace & Co", email: "grace@navy.test", role: "optional" },
    ]);
    expect(ewsPeople('<t:ItemId Id="EV2"/><t:Body BodyType="Text"></t:Body>')).toEqual([]);
  });
  it("reads each attendee's answer on the organizer's copy", () => {
    const item = '<t:RequiredAttendees><t:Attendee><t:Mailbox><t:Name>Ann</t:Name><t:EmailAddress>ann@x.test</t:EmailAddress></t:Mailbox><t:ResponseType>Tentative</t:ResponseType></t:Attendee>' +
      '<t:Attendee><t:Mailbox><t:Name>Bo</t:Name><t:EmailAddress>bo@x.test</t:EmailAddress></t:Mailbox><t:ResponseType>NoResponseReceived</t:ResponseType></t:Attendee>' +
      '<t:Attendee><t:Mailbox><t:Name>Cy</t:Name><t:EmailAddress>cy@x.test</t:EmailAddress></t:Mailbox><t:ResponseType>Decline</t:ResponseType></t:Attendee></t:RequiredAttendees>';
    expect(ewsPeople(item).map((p: any) => p.response)).toEqual(["tentative", "none", "decline"]);
  });
});

describe("making and changing events", () => {
  const { ewsRecurrence, ewsCreateEventRequest, ewsUpdateEventRequest, ewsDeleteEventRequest, ewsCancelMeetingRequest } = module.exports;
  const base = { subject: "Venue walkthrough", start: "2026-11-19T18:00:00.000Z", end: "2026-11-19T19:30:00.000Z", allDay: false, freeBusy: "Busy", reminder: 15, timeZone: "Eastern Standard Time" };
  it("makes an event with the fields in the schema's order, inviting nobody without attendees", () => {
    const xml = ewsCreateEventRequest({ ...base, location: "Lakeside Lodge", body: "Bring the contract & keys" });
    expect(xml).toContain('<m:CreateItem SendMeetingInvitations="SendToNone"><m:SavedItemFolderId><t:DistinguishedFolderId Id="calendar"/>');
    const order = ["<t:Subject>", "<t:Body", "<t:ReminderIsSet>", "<t:ReminderMinutesBeforeStart>", "<t:Start>", "<t:End>", "<t:IsAllDayEvent>", "<t:LegacyFreeBusyStatus>", "<t:Location>", "<t:StartTimeZone", "<t:EndTimeZone"];
    const positions = order.map((tag) => xml.indexOf(tag));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(xml).toContain("<t:Start>2026-11-19T18:00:00Z</t:Start>");
    expect(xml).toContain("Bring the contract &amp; keys");
    expect(xml).not.toContain("RequiredAttendees");
  });
  it("invites attendees, and leaves out bad addresses and the reminder when off", () => {
    const xml = ewsCreateEventRequest({ ...base, reminder: -1, attendees: [{ name: "Priya Nair", email: "priya@x.test" }, { name: "Nobody", email: "not-an-address" }] });
    expect(xml).toContain('SendMeetingInvitations="SendToAllAndSaveCopy"');
    expect(xml).toContain("<t:RequiredAttendees><t:Attendee><t:Mailbox><t:Name>Priya Nair</t:Name><t:EmailAddress>priya@x.test</t:EmailAddress></t:Mailbox></t:Attendee></t:RequiredAttendees>");
    expect(xml).not.toContain("not-an-address");
    expect(xml).toContain("<t:ReminderIsSet>false</t:ReminderIsSet>");
    expect(xml).not.toContain("ReminderMinutesBeforeStart");
    expect(() => ewsCreateEventRequest({ ...base, end: "2026-11-19T17:00:00.000Z" })).toThrow(/ends before/);
  });
  it("repeats from the first day", () => {
    expect(ewsRecurrence({ kind: "weekly", start: "2026-11-19" })).toBe("<t:Recurrence><t:WeeklyRecurrence><t:Interval>1</t:Interval><t:DaysOfWeek>Thursday</t:DaysOfWeek></t:WeeklyRecurrence><t:NoEndRecurrence><t:StartDate>2026-11-19</t:StartDate></t:NoEndRecurrence></t:Recurrence>");
    expect(ewsRecurrence({ kind: "monthly", start: "2026-11-19" })).toContain("<t:AbsoluteMonthlyRecurrence><t:Interval>1</t:Interval><t:DayOfMonth>19</t:DayOfMonth>");
    expect(ewsRecurrence({ kind: "yearly", start: "2026-11-19" })).toContain("<t:DayOfMonth>19</t:DayOfMonth><t:Month>November</t:Month>");
    expect(ewsRecurrence({ kind: "weekdays", start: "2026-11-19", until: "2026-12-31" })).toContain("<t:DaysOfWeek>Monday Tuesday Wednesday Thursday Friday</t:DaysOfWeek></t:WeeklyRecurrence><t:EndDateRecurrence><t:StartDate>2026-11-19</t:StartDate><t:EndDate>2026-12-31</t:EndDate>");
    expect(ewsRecurrence({ kind: "biweekly", start: "2026-11-19" })).toContain("<t:Interval>2</t:Interval>");
    expect(ewsRecurrence(null)).toBe("");
    // Recurrence comes after the attendees and before the time zones.
    const xml = ewsCreateEventRequest({ ...base, attendees: [{ email: "a@x.test" }], recurrence: { kind: "daily", start: "2026-11-19" } });
    expect(xml.indexOf("</t:RequiredAttendees>")).toBeLessThan(xml.indexOf("<t:Recurrence>"));
    expect(xml.indexOf("</t:Recurrence>")).toBeLessThan(xml.indexOf("<t:StartTimeZone"));
  });
  it("changes only the fields given, removing emptied ones, telling attendees when asked", () => {
    const xml = ewsUpdateEventRequest("EV1", { subject: "Walkthrough", location: "", start: base.start, end: base.end, timeZone: base.timeZone }, { send: true, changeKey: "CK" });
    expect(xml).toContain('SendMeetingInvitationsOrCancellations="SendToAllAndSaveCopy"');
    expect(xml).toContain('<t:ItemId Id="EV1" ChangeKey="CK"/>');
    expect(xml).toContain('<t:SetItemField><t:FieldURI FieldURI="item:Subject"/><t:CalendarItem><t:Subject>Walkthrough</t:Subject></t:CalendarItem></t:SetItemField>');
    expect(xml).toContain('<t:DeleteItemField><t:FieldURI FieldURI="calendar:Location"/></t:DeleteItemField>');
    expect(xml).toContain('FieldURI="calendar:StartTimeZone"');
    expect(xml).not.toContain("item:Body");
    expect(ewsUpdateEventRequest("EV1", { recurrence: null }, { series: true })).toContain('<t:RecurringMasterItemId OccurrenceId="EV1"/>');
    expect(ewsUpdateEventRequest("EV1", { reminder: 30 })).toContain('SendMeetingInvitationsOrCancellations="SendToNone"');
    expect(() => ewsUpdateEventRequest("EV1", {})).toThrow(/Nothing/);
  });
  it("deletes quietly, or cancels with a note", () => {
    expect(ewsDeleteEventRequest("EV1")).toContain('<m:DeleteItem DeleteType="MoveToDeletedItems" SendMeetingCancellations="SendToNone"><m:ItemIds><t:ItemId Id="EV1"/></m:ItemIds>');
    expect(ewsDeleteEventRequest("EV1", { series: true, cancel: true })).toContain('SendMeetingCancellations="SendToAllAndSaveCopy"><m:ItemIds><t:RecurringMasterItemId OccurrenceId="EV1"/>');
    expect(ewsCancelMeetingRequest("EV1", "CK", "Sorry & thanks")).toContain('<t:CancelCalendarItem><t:ReferenceItemId Id="EV1" ChangeKey="CK"/><t:NewBodyContent BodyType="Text">Sorry &amp; thanks</t:NewBodyContent></t:CancelCalendarItem>');
  });
});

describe("availability (Find a time)", () => {
  const { ewsAvailabilityRequest, ewsAvailability } = module.exports;
  it("asks in UTC for each person", () => {
    const xml = ewsAvailabilityRequest(["priya@x.test", "dana@x.test"], "2026-11-19T05:00:00.000Z", "2026-11-20T05:00:00.000Z");
    expect(xml).toContain("<t:TimeZone><t:Bias>0</t:Bias>");
    expect(xml).toContain("<t:MailboxData><t:Email><t:Address>priya@x.test</t:Address></t:Email><t:AttendeeType>Required</t:AttendeeType>");
    expect(xml).toContain("<t:TimeWindow><t:StartTime>2026-11-19T05:00:00</t:StartTime><t:EndTime>2026-11-20T05:00:00</t:EndTime></t:TimeWindow>");
    expect(xml.indexOf("<t:TimeZone>")).toBeLessThan(xml.indexOf("<m:MailboxDataArray>"));
    expect(xml.indexOf("</m:MailboxDataArray>")).toBeLessThan(xml.indexOf("<t:FreeBusyViewOptions>"));
  });
  it("reads busy times per person, and says whose calendar it couldn't see", () => {
    const ok = (events: string) => `<m:FreeBusyResponse><m:ResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode></m:ResponseMessage><m:FreeBusyView><t:CalendarEventArray>${events}</t:CalendarEventArray></m:FreeBusyView></m:FreeBusyResponse>`;
    const event = (a: string, b: string, type = "Busy") => `<t:CalendarEvent><t:StartTime>${a}</t:StartTime><t:EndTime>${b}</t:EndTime><t:BusyType>${type}</t:BusyType></t:CalendarEvent>`;
    const xml = `<m:FreeBusyResponseArray>${ok(event("2026-11-19T14:00:00", "2026-11-19T15:00:00") + event("2026-11-19T16:00:00", "2026-11-19T16:30:00", "Tentative") + event("2026-11-19T17:00:00", "2026-11-19T18:00:00", "Free"))}` +
      `<m:FreeBusyResponse><m:ResponseMessage ResponseClass="Error"><m:MessageText>Mailbox not found</m:MessageText><m:ResponseCode>ErrorMailRecipientNotFound</m:ResponseCode></m:ResponseMessage></m:FreeBusyResponse></m:FreeBusyResponseArray>`;
    expect(ewsAvailability(xml, ["priya@x.test", "pal@gmail.test"])).toEqual([
      { email: "priya@x.test", busy: [{ start: "2026-11-19T14:00:00.000Z", end: "2026-11-19T15:00:00.000Z", type: "Busy" }, { start: "2026-11-19T16:00:00.000Z", end: "2026-11-19T16:30:00.000Z", type: "Tentative" }] },
      { email: "pal@gmail.test", busy: [], error: "Mailbox not found" },
    ]);
  });
});

describe("other calendars (shared and extra ones)", () => {
  const {
    ewsCalendarFolder, ewsCalendarViewRequest, ewsDefaultFolders, ewsCalendarFoldersRequest, ewsCalendarFolders, ewsLinksRequest, ewsAddressBookDn,
    ewsCalendarLinks, ewsResolved, ewsConvertIdRequest, ewsConvertedId, ewsAvailabilityRequest, ewsAvailability, sharedItems, busyItems, timeChunks,
  } = module.exports;
  const DN = "/o=ExchangeLabs/ou=Exchange Administrative Group (FYDIBOHF23SPDLT)/cn=Recipients/cn=4f2a-priya";
  const hex = (h: string) => (h.match(/../g) || []).map((b) => parseInt(b, 16));
  const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));
  const abEid = (dn: string, provider = "dca740c8c042101ab4b908002b2fe182") => b64([0, 0, 0, 0, ...hex(provider), 1, 0, 0, 0, 0, 0, 0, 0, ...[...dn].map((c) => c.charCodeAt(0)), 0]);
  const CALENDAR_TYPE = b64(hex("0278060000000000c000000000000046"));
  const MAIL_TYPE = b64(hex("0278060000000000c000000000000047"));
  const prop = (tag: string, type: string, value: string) => `<t:ExtendedProperty><t:ExtendedFieldURI PropertyTag="${tag}" PropertyType="${type}"/><t:Value>${value}</t:Value></t:ExtendedProperty>`;

  it("reads a person's main calendar by address, or a folder by id", () => {
    expect(ewsCalendarFolder({ email: "priya@x.test" })).toBe('<t:DistinguishedFolderId Id="calendar"><t:Mailbox><t:EmailAddress>priya@x.test</t:EmailAddress></t:Mailbox></t:DistinguishedFolderId>');
    expect(ewsCalendarFolder({ folderId: "AAMk<1>", email: "priya@x.test" })).toBe('<t:FolderId Id="AAMk&lt;1&gt;"/>');
    const xml = ewsCalendarViewRequest("2026-11-16T05:00:00Z", "2026-11-23T05:00:00Z", true, ewsCalendarFolder({ email: "priya@x.test" }));
    expect(xml).toContain('<m:ParentFolderIds><t:DistinguishedFolderId Id="calendar"><t:Mailbox><t:EmailAddress>priya@x.test</t:EmailAddress></t:Mailbox></t:DistinguishedFolderId></m:ParentFolderIds>');
    expect(ewsCalendarViewRequest("a", "b")).toContain('<m:ParentFolderIds><t:DistinguishedFolderId Id="calendar"/></m:ParentFolderIds>');
  });
  it("finds the user's extra calendars, leaving out the main one and deleted ones", () => {
    expect(ewsCalendarFoldersRequest()).toContain('<m:FindFolder Traversal="Deep">');
    expect(ewsCalendarFoldersRequest()).toContain('<t:Contains ContainmentMode="Prefixed" ContainmentComparison="IgnoreCase"><t:FieldURI FieldURI="folder:FolderClass"/><t:Constant Value="IPF.Appointment"/>');
    const defaults = ewsDefaultFolders('<m:GetFolderResponseMessage ResponseClass="Success"><m:Folders><t:CalendarFolder><t:FolderId Id="CAL" ChangeKey="a"/></t:CalendarFolder></m:Folders></m:GetFolderResponseMessage>' +
      '<m:GetFolderResponseMessage ResponseClass="Success"><m:Folders><t:Folder><t:FolderId Id="DEL" ChangeKey="b"/></t:Folder></m:Folders></m:GetFolderResponseMessage>');
    expect(defaults).toEqual({ calendar: "CAL", deleted: "DEL" });
    const folder = (id: string, parent: string, name: string) => `<t:CalendarFolder><t:FolderId Id="${id}" ChangeKey="x"/><t:ParentFolderId Id="${parent}" ChangeKey="y"/><t:FolderClass>IPF.Appointment</t:FolderClass><t:DisplayName>${name}</t:DisplayName></t:CalendarFolder>`;
    const xml = `<m:RootFolder><t:Folders>${folder("CAL", "ROOT", "Calendar")}${folder("F1", "CAL", "Birthdays")}${folder("F2", "DEL", "Old project")}${folder("F3", "ROOT", "Team &amp; vacations")}</t:Folders></m:RootFolder>`;
    expect(ewsCalendarFolders(xml, defaults)).toEqual([{ id: "F1", name: "Birthdays" }, { id: "F3", name: "Team & vacations" }]);
  });
  it("reads people's calendars from Outlook's calendar list", () => {
    expect(ewsLinksRequest("CV")).toContain('<m:FindItem Traversal="Associated">');
    expect(ewsLinksRequest("CV")).toContain('<t:ExtendedFieldURI PropertyTag="0x6854" PropertyType="Binary"/>');
    expect(ewsLinksRequest("CV")).toContain('<t:Constant Value="IPM.Microsoft.WunderBar.Link"/>');
    expect(ewsAddressBookDn(abEid(DN))).toBe(DN);
    expect(ewsAddressBookDn(abEid(DN, "00".repeat(16)))).toBe("");
    expect(ewsAddressBookDn("")).toBe("");
    const link = (subject: string, type: string, ab: string, group = "People's calendars", entry = "AQID") =>
      `<t:Message><t:ItemId Id="L"/><t:Subject>${subject}</t:Subject>${prop("0x684c", "Binary", entry)}${prop("0x684f", "Binary", type)}${prop("0x6851", "String", group)}${ab ? prop("0x6854", "Binary", ab) : ""}</t:Message>`;
    const xml = `<m:RootFolder><t:Items>${link("Priya Shah", CALENDAR_TYPE, abEid(DN))}${link("Calendar", CALENDAR_TYPE, "")}${link("Priya's inbox", MAIL_TYPE, abEid(DN))}${link("Priya Shah", CALENDAR_TYPE, abEid(DN))}</t:Items></m:RootFolder>`;
    expect(ewsCalendarLinks(xml)).toEqual([{ name: "Priya Shah", group: "People's calendars", dn: DN, entryId: "010203" }]);
  });
  it("turns the link's address and folder into an email and a folder id", () => {
    expect(ewsResolved('<m:ResolutionSet><t:Resolution><t:Mailbox><t:Name>Priya Shah</t:Name><t:EmailAddress>Priya@X.test</t:EmailAddress><t:RoutingType>SMTP</t:RoutingType></t:Mailbox></t:Resolution></m:ResolutionSet>'))
      .toEqual({ name: "Priya Shah", email: "priya@x.test" });
    expect(ewsResolved('<m:ResolveNamesResponseMessage ResponseClass="Error"></m:ResolveNamesResponseMessage>')).toBeNull();
    expect(ewsConvertIdRequest("0102", "priya@x.test")).toContain('<t:AlternateId Format="HexEntryId" Id="0102" Mailbox="priya@x.test"/>');
    expect(ewsConvertedId('<m:ConvertIdResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:AlternateId Format="EwsId" Id="AAMkF" Mailbox="priya@x.test"/></m:ConvertIdResponseMessage>')).toBe("AAMkF");
    expect(ewsConvertedId('<m:ConvertIdResponseMessage ResponseClass="Error"><m:ResponseCode>ErrorInvalidIdMalformed</m:ResponseCode></m:ConvertIdResponseMessage>')).toBe("");
  });
  it("asks for details with busy times, and keeps what's shared", () => {
    expect(ewsAvailabilityRequest(["p@x.test"], "2026-11-19T05:00:00Z", "2026-11-20T05:00:00Z", "Detailed")).toContain("<t:RequestedView>Detailed</t:RequestedView>");
    const xml = '<m:FreeBusyResponse><m:ResponseMessage ResponseClass="Success"/><m:FreeBusyView><t:CalendarEventArray>' +
      '<t:CalendarEvent><t:StartTime>2026-11-19T14:00:00</t:StartTime><t:EndTime>2026-11-19T15:00:00</t:EndTime><t:BusyType>Busy</t:BusyType><t:CalendarEventDetails><t:ID>x</t:ID><t:Subject>Board prep</t:Subject><t:Location>Room 4</t:Location><t:IsPrivate>false</t:IsPrivate></t:CalendarEventDetails></t:CalendarEvent>' +
      '<t:CalendarEvent><t:StartTime>2026-11-19T16:00:00</t:StartTime><t:EndTime>2026-11-19T17:00:00</t:EndTime><t:BusyType>OOF</t:BusyType></t:CalendarEvent>' +
      '</t:CalendarEventArray></m:FreeBusyView></m:FreeBusyResponse>';
    const [person] = ewsAvailability(xml, ["p@x.test"]);
    expect(person.busy[0]).toEqual({ start: "2026-11-19T14:00:00.000Z", end: "2026-11-19T15:00:00.000Z", type: "Busy", subject: "Board prep", location: "Room 4", private: false });
    const cal = { key: "A|p@x.test", accountId: "A" };
    const events = busyItems([...person.busy, person.busy[1], { ...person.busy[0], start: "2026-11-20T14:00:00.000Z", end: "2026-11-20T15:00:00.000Z", private: true }], cal);
    expect(events.map((e: any) => [e.subject, e.location, e.freeBusy, e.busyOnly, e.calendarId, e.response])).toEqual([
      ["Board prep", "Room 4", "Busy", true, "A|p@x.test", "shared"],
      ["", "", "OOF", true, "A|p@x.test", "shared"],
      ["", "", "Busy", true, "A|p@x.test", "shared"],
    ]);
    expect(new Set(events.map((e: any) => e.id)).size).toBe(3);
  });
  it("marks events read from another calendar as that calendar's", () => {
    const [e] = sharedItems([{ id: "E1", subject: "Edit", response: "accept" }], { key: "A|F1", accountId: "A" });
    expect(e).toMatchObject({ id: "E1", accountId: "A", calendarId: "A|F1", shared: true, response: "shared" });
  });
  it("splits long ranges for free/busy", () => {
    expect(timeChunks("2026-11-01T00:00:00.000Z", "2026-12-13T00:00:00.000Z")).toEqual([
      ["2026-11-01T00:00:00.000Z", "2026-12-02T00:00:00.000Z"], ["2026-12-02T00:00:00.000Z", "2026-12-13T00:00:00.000Z"],
    ]);
  });
});

describe("all-day events", () => {
  const { allDayDates, ewsCalendarItems } = module.exports;
  const local = (y: number, m: number, d: number) => new Date(y, m - 1, d).toISOString();
  it("shows an all-day event on its dates, whatever zone Exchange stored it in", () => {
    // Midnight UTC (7 PM the day before in New York), midnight in New York, and midnight in Los Angeles all mean Nov 18.
    for (const offset of [0, 5, 8, -5, -9]) {
      const start = new Date(Date.UTC(2026, 10, 18, offset)).toISOString(), end = new Date(Date.UTC(2026, 10, 19, offset)).toISOString();
      const near = (iso: string) => { const at = Date.parse(iso), a = new Date(at); a.setHours(0, 0, 0, 0); const b = new Date(a); b.setDate(b.getDate() + 1); return (at - a.getTime() <= b.getTime() - at ? a : b).toISOString(); };
      expect(allDayDates(start, end)).toEqual({ start: near(start), end: near(end) });
    }
    expect(allDayDates(local(2026, 11, 18), local(2026, 11, 19))).toEqual({ start: local(2026, 11, 18), end: local(2026, 11, 19) });
    expect(allDayDates("", "")).toEqual({ start: "", end: "" });
  });
  it("never ends an all-day event before it starts", () => {
    const at = local(2026, 11, 18);
    expect(allDayDates(at, at)).toEqual({ start: at, end: local(2026, 11, 19) });
  });
  it("reads all-day items as dates, and timed ones unchanged", () => {
    const item = (allDay: boolean, start: string, end: string) => `<t:CalendarItem><t:ItemId Id="X"/><t:Subject>S</t:Subject><t:Start>${start}</t:Start><t:End>${end}</t:End><t:IsAllDayEvent>${allDay}</t:IsAllDayEvent></t:CalendarItem>`;
    const [day, timed] = ewsCalendarItems(item(true, local(2026, 11, 18), local(2026, 11, 20)) + item(false, "2026-11-18T00:00:00Z", "2026-11-19T00:00:00Z"));
    expect([day.start, day.end]).toEqual([local(2026, 11, 18), local(2026, 11, 20)]);
    expect([timed.start, timed.end]).toEqual(["2026-11-18T00:00:00Z", "2026-11-19T00:00:00Z"]);
  });
});

describe("Thunderbird's own calendars (Google and other CalDAV)", () => {
  const { icalRule, icalFreeBusy, icalShowAs, tbItemId, tbParseId, isGoogleMail } = module.exports;
  it("writes the editor's repeat choices as RRULEs", () => {
    // 2026-11-19 is a Thursday.
    expect(icalRule({ kind: "weekly", start: "2026-11-19" })).toBe("FREQ=WEEKLY;BYDAY=TH");
    expect(icalRule({ kind: "biweekly", start: "2026-11-19" })).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=TH");
    expect(icalRule({ kind: "weekdays", start: "2026-11-19" })).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
    expect(icalRule({ kind: "monthly", start: "2026-11-19" })).toBe("FREQ=MONTHLY;BYMONTHDAY=19");
    expect(icalRule({ kind: "yearly", start: "2026-11-19" })).toBe("FREQ=YEARLY;BYMONTH=11;BYMONTHDAY=19");
    expect(icalRule({ kind: "daily", start: "2026-11-19" })).toBe("FREQ=DAILY");
    expect(icalRule(null)).toBe("");
    expect(icalRule({ kind: "hourly", start: "2026-11-19" })).toBe("");
  });
  it("reads and writes show-as through TRANSP and Outlook's busy status", () => {
    expect(icalFreeBusy("TRANSPARENT", "")).toBe("Free");
    expect(icalFreeBusy("OPAQUE", "")).toBe("Busy");
    expect(icalFreeBusy("", "")).toBe("Busy");
    expect(icalFreeBusy("OPAQUE", "OOF")).toBe("OOF");
    expect(icalFreeBusy("OPAQUE", "tentative")).toBe("Tentative");
    expect(icalShowAs("Free")).toEqual({ transp: "TRANSPARENT", busyStatus: "FREE" });
    expect(icalShowAs("WorkingElsewhere")).toEqual({ transp: "OPAQUE", busyStatus: "WORKINGELSEWHERE" });
    expect(icalShowAs("nonsense")).toEqual({ transp: "OPAQUE", busyStatus: "BUSY" });
    for (const v of ["Free", "Tentative", "Busy", "OOF", "WorkingElsewhere"]) { const w = icalShowAs(v); expect(icalFreeBusy(w.transp, w.busyStatus)).toBe(v); }
  });
  it("keeps an occurrence's recurrence id in its event id, even when the UID has a #", () => {
    expect(tbParseId(tbItemId("abc@google.com", "T20261117T150000Z"))).toEqual({ uid: "abc@google.com", recurrence: "T20261117T150000Z" });
    expect(tbParseId(tbItemId("a#b", "D20261117"))).toEqual({ uid: "a#b", recurrence: "D20261117" });
    expect(tbParseId("a#b")).toEqual({ uid: "a#b", recurrence: "" });
    expect(tbParseId(tbItemId("plain", ""))).toEqual({ uid: "plain", recurrence: "" });
  });
  it("knows Gmail and Google Workspace mail accounts", () => {
    expect(isGoogleMail("me@gmail.com", "imap.gmail.com")).toBe(true);
    expect(isGoogleMail("me@company.org", "imap.gmail.com")).toBe(true);
    expect(isGoogleMail("me@googlemail.com", "")).toBe(true);
    expect(isGoogleMail("me@icloud.com", "imap.mail.me.com")).toBe(false);
    expect(isGoogleMail("me@notgmail.com", "mail.notgmail.com")).toBe(false);
  });
});

describe("reading a series' repeat for the editor", () => {
  const { repeatOfRule, repeatOfEws } = module.exports;
  it("maps RRULEs to the editor's choices and anything else to custom", () => {
    expect(repeatOfRule("RRULE:FREQ=DAILY;COUNT=30")).toBe("daily");
    expect(repeatOfRule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR")).toBe("weekdays");
    expect(repeatOfRule("FREQ=WEEKLY;BYDAY=TH")).toBe("weekly");
    expect(repeatOfRule("FREQ=WEEKLY;INTERVAL=2;BYDAY=TH;UNTIL=20270101T000000Z")).toBe("biweekly");
    expect(repeatOfRule("FREQ=MONTHLY;BYMONTHDAY=12")).toBe("monthly");
    expect(repeatOfRule("FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=4")).toBe("yearly");
    expect(repeatOfRule("FREQ=MONTHLY;BYDAY=2TU")).toBe("custom");
    expect(repeatOfRule("FREQ=WEEKLY;BYDAY=MO,WE")).toBe("custom");
    expect(repeatOfRule("FREQ=DAILY;INTERVAL=3")).toBe("custom");
    expect(repeatOfRule("")).toBe("");
  });
  it("reads Exchange's Recurrence element the same way", () => {
    const wrap = (p: string) => `<t:Subject>x</t:Subject><t:Recurrence>${p}<t:NoEndRecurrence><t:StartDate>2026-11-02</t:StartDate></t:NoEndRecurrence></t:Recurrence>`;
    expect(repeatOfEws(wrap("<t:WeeklyRecurrence><t:Interval>1</t:Interval><t:DaysOfWeek>Monday</t:DaysOfWeek></t:WeeklyRecurrence>"))).toBe("weekly");
    expect(repeatOfEws(wrap("<t:WeeklyRecurrence><t:Interval>2</t:Interval><t:DaysOfWeek>Monday</t:DaysOfWeek></t:WeeklyRecurrence>"))).toBe("biweekly");
    expect(repeatOfEws(wrap("<t:WeeklyRecurrence><t:Interval>1</t:Interval><t:DaysOfWeek>Monday Tuesday Wednesday Thursday Friday</t:DaysOfWeek></t:WeeklyRecurrence>"))).toBe("weekdays");
    expect(repeatOfEws(wrap("<t:DailyRecurrence><t:Interval>1</t:Interval></t:DailyRecurrence>"))).toBe("daily");
    expect(repeatOfEws(wrap("<t:RelativeMonthlyRecurrence><t:Interval>1</t:Interval><t:DaysOfWeek>Tuesday</t:DaysOfWeek><t:DayOfWeekIndex>Second</t:DayOfWeekIndex></t:RelativeMonthlyRecurrence>"))).toBe("custom");
    expect(repeatOfEws("<t:Subject>x</t:Subject>")).toBe("");
  });
  it("asks Exchange for an occurrence's series by its occurrence id", () => {
    expect(ewsGetItemRequest(["OCC1"], ["calendar:Recurrence"], "Text", { master: true })).toContain('<t:RecurringMasterItemId OccurrenceId="OCC1"/>');
  });
});
