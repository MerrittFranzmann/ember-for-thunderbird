// Ember's side of its MCP server (mcp/spark-mcp.mjs): an agent's requests arrive through the sparkAgent
// Experiment's local socket and are answered here, from what this Ember window has (saved mail, sections,
// Clef's signals, marks). Agents can find and read mail, set Ember's marks (needs reply, important, top) and save
// reply drafts to the Drafts folder, and show an email in Ember; nothing here sends mail, and nothing moves or
// deletes the user's mail (a replaced draft of the agent's own goes to Trash). Every email comes with its link
// (mail-links.ts) for the agent to give the user: a click opens it in Ember. On while Settings → AI agents is on.
import { api, mailCache } from "./api";
import { store } from "./store.svelte";
import { extractBodies, htmlToText } from "./body";
import { isFileAttachment } from "./attachments";
import { aiKey } from "./ai-sort";
import { markOf, type MarkChange } from "./agent-marks";
import { emailOf, splitAddrs } from "./format";
import { composer } from "./compose.svelte";
import { errorLog } from "./error-log";
import { INBOX_IDS, groupsOf } from "./inboxes";
import { agentLook, entryFor, type EmailRef, type MarkBefore } from "./agent-activity";
import type { Category, MessageHeader } from "./types";
import { calendar, nameFromMail } from "./calendar.svelte";
import { freeSlots, slotLabel } from "./find-time";
import { localTime, windowsZone } from "./calendar-edit";

const SECTION_IN: Record<string, Category> = { people: "people", calendar: "calendar", updates: "notification", newsletters: "newsletter", receipts: "receipt" };
const SECTION_OUT: Record<Category, string> = { people: "people", calendar: "calendar", notification: "updates", newsletter: "newsletters", receipt: "receipts" };
const SIGNALS = { needs_reply: "reply", important: "important", receipt: "receipt", promotion: "promotion" } as const;
const DAY = 86400000;
const clamp = (value: unknown, fallback: number, min: number, max: number) => { const n = Math.round(Number(value)); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; };

function summary(m: MessageHeader) {
  const mark = markOf(store.agentMarks, m);
  const mine = store.me.has(emailOf(m.author));
  const link = store.emailLink(m);
  return {
    id: aiKey(m),
    from: m.author,
    to: [...(m.recipients || []), ...(m.ccList || [])].slice(0, 12),
    subject: m.subject,
    date: new Date(m.date).toISOString(),
    unread: m.read === false,
    account: store.accountName(m.folder?.accountId),
    folder: m.folder?.name || "",
    section: SECTION_OUT[store.categoryOf(m)],
    // Work and Personal inboxes: which one, and its group there (an id from ember_status's inboxes).
    ...(store.inboxOfAccount(m.folder?.accountId) ? { inbox: store.inboxOfAccount(m.folder?.accountId), group: store.groupOf(m) } : {}),
    needs_reply: !mine && store.messageSignal(m, "reply"),
    important: store.messageSignal(m, "important"),
    receipt: store.messageSignal(m, "receipt"),
    promotion: store.messageSignal(m, "promotion"),
    top: !!mark?.top,
    ...(mark?.note ? { note: mark.note } : {}),
    ...(mark?.draft ? { draft_id: mark.draft } : {}),
    snippet: (store.meta.get(m)?.snippet || "").slice(0, 240),
    // A link the user can click (in the agent's answer) to open this email in Ember.
    ...(link ? { link } : {}),
  };
}

/** Saved emails, one per Message-ID (the Inbox copy first), newest first. */
function distinct(messages: MessageHeader[], inboxOnly: boolean): MessageHeader[] {
  const best = new Map<string, MessageHeader>();
  for (const m of messages) {
    const key = aiKey(m);
    const role = store.roleOfFolder(m.folder?.id);
    if (!key || m.junk || role === "junk" || role === "trash" || (inboxOnly && role !== "inbox")) continue;
    const seen = best.get(key);
    if (!seen || (role === "inbox" && store.roleOfFolder(seen.folder?.id) !== "inbox")) best.set(key, m);
  }
  return [...best.values()].sort((a, b) => +new Date(b.date) - +new Date(a.date));
}

async function find(params: any) {
  const days = clamp(params.days, 14, 1, 90), limit = clamp(params.limit, 25, 1, 100);
  const since = Date.now() - days * DAY;
  const query = String(params.query || "").trim();
  const section = params.section ? SECTION_IN[String(params.section)] : undefined;
  if (params.section && !section) throw new Error(`Unknown section "${params.section}". Use people, calendar, updates, newsletters or receipts.`);
  const inbox = params.inbox ? String(params.inbox) : undefined;
  if (inbox && !store.split) throw new Error("Ember has one inbox: no work accounts are set (Settings → Inboxes).");
  if (inbox && !INBOX_IDS.includes(inbox as any)) throw new Error(`Unknown inbox "${inbox}". Use work or personal.`);
  const group = params.group ? String(params.group) : undefined;
  if (group && !inbox) throw new Error("Give the inbox (work or personal) with a group.");
  if (group && inbox && !groupsOf(inbox as any, store.settings).some((g) => g.id === group)) throw new Error(`Unknown ${inbox} group "${group}". Use ${groupsOf(inbox as any, store.settings).map((g) => g.id).join(", ")}.`);
  const signal = params.signal ? SIGNALS[String(params.signal) as keyof typeof SIGNALS] : undefined;
  if (params.signal && !signal) throw new Error(`Unknown signal "${params.signal}". Use needs_reply, important, receipt or promotion.`);
  const source = query ? (await mailCache.search(query)).messages : mailCache.all();
  const matches = distinct(source, params.folder !== "all").filter((m) => {
    if (+new Date(m.date) < since) return false;
    if (params.unread_only && m.read !== false) return false;
    if (section && store.categoryOf(m) !== section) return false;
    if (inbox && store.inboxOfAccount(m.folder?.accountId) !== inbox) return false;
    if (group && store.groupOf(m) !== group) return false;
    if (signal && !(store.messageSignal(m, signal) && !(signal === "reply" && store.me.has(emailOf(m.author))))) return false;
    if (params.top_only && !markOf(store.agentMarks, m)?.top) return false;
    return true;
  });
  return { total: matches.length, emails: matches.slice(0, limit).map(summary), ai_sorting: store.settings.aiSort };
}

async function headerFor(id: string): Promise<MessageHeader> {
  const key = aiKey({ headerMessageId: String(id || "") });
  if (!key) throw new Error("Give the email's id (from find_emails).");
  const saved = distinct(mailCache.all().filter((m) => aiKey(m) === key), false)[0];
  if (saved) return saved;
  const found = await api.messages.query({ headerMessageId: key }).catch(() => null);
  const live = found?.messages?.find((m: MessageHeader) => !m.junk);
  if (!live) throw new Error(`No email with id ${key} in Thunderbird.`);
  return live;
}

async function read(params: any) {
  const m = await headerFor(params.id);
  const [full, files] = await Promise.all([api.messages.getFull(m.id), api.messages.listAttachments(m.id).catch(() => [])]);
  const bodies = extractBodies(full);
  const text = (bodies.text ?? (bodies.html ? htmlToText(bodies.html) : "")).replace(/\n{3,}/g, "\n\n").trim();
  const limit = clamp(params.max_chars, 20000, 500, 50000);
  return { ...summary(m), cc: m.ccList || [], text: text.slice(0, limit), truncated: text.length > limit, attachments: (files || []).filter(isFileAttachment).map((f: any) => f.name) };
}

async function mark(params: any) {
  const ids = Array.isArray(params.ids) ? params.ids.map(String).slice(0, 200) : params.id ? [String(params.id)] : [];
  if (!ids.length) throw new Error("Give ids: the emails to mark (from find_emails).");
  const change: MarkChange = {};
  if (typeof params.needs_reply === "boolean") change.reply = params.needs_reply;
  if (typeof params.important === "boolean") change.important = params.important;
  if (typeof params.top === "boolean") change.top = params.top;
  if (typeof params.note === "string") change.note = params.note;
  if (!Object.keys(change).length) throw new Error("Say what to mark: needs_reply, important, top (true or false) or a note.");
  const marks = await store.setMarks(ids, change, "agent");
  const keys = ids.map((id: string) => aiKey({ headerMessageId: id }));
  return { updated: keys.length, marks: Object.fromEntries(keys.map((key: string) => [key, marks[key] || null])) };
}

async function draft(params: any) {
  const m = await headerFor(params.id);
  const text = String(params.text ?? "").trim();
  if (!text) throw new Error("Give the reply's text.");
  if (text.length > 20000) throw new Error("That reply is too long (20,000 characters at most).");
  const key = aiKey(m);
  // The agent's earlier draft for this email, if it's still in Drafts: replaced (moved to Trash), unless asked not to.
  const earlier = markOf(store.agentMarks, m)?.draft;
  let replaced = false;
  if (earlier && params.replace_previous !== false) {
    const found = await api.messages.query({ headerMessageId: earlier }).catch(() => null);
    const old = found?.messages?.find((x: MessageHeader) => store.roleOfFolder(x.folder?.id) === "drafts");
    if (old) { await api.messages.delete([old.id]).catch(() => {}); replaced = true; }
  }
  const saved = await composer.saveReplyDraft(m.id, text, !!params.reply_all);
  if (!saved) {
    if (params.top === true) await store.setMarks([key], { top: true }, "agent");
    return { draft_id: null, replied_to: key, replaced_previous: replaced, note: "Thunderbird saved the reply to the account's Drafts folder, but Ember couldn't find the saved copy yet, so the email has no Draft badge. Nothing was sent. The user can open it from Drafts." };
  }
  await store.setMarks([key], { draft: saved.headerMessageId, ...(params.top === true ? { top: true } : {}) }, "agent");
  return {
    draft_id: aiKey(saved), replied_to: key, subject: saved.subject, to: saved.recipients || [], cc: saved.ccList || [],
    account: store.accountName(saved.folder?.accountId), folder: saved.folder?.name || "Drafts", replaced_previous: replaced,
    note: "Saved as a draft; nothing was sent. The user reviews and sends it from Ember.",
  };
}

async function marked() {
  const marks = store.agentMarks;
  const byKey = new Map(distinct(mailCache.all(), false).map((m) => [aiKey(m), m]));
  return { emails: Object.entries(marks).map(([id, mark]) => ({ id, ...mark, email: byKey.has(id) ? summary(byKey.get(id)!) : null })) };
}

/** Show an email in Ember, in front of the user (the background finds the best copy, as for a link). */
async function open(params: any) {
  const m = await headerFor(params.id);
  const answer = await api.runtime.sendMessage({ type: "spark:open-email", id: aiKey(m) });
  if (!answer?.opened) throw new Error(`Ember couldn't show the email ${aiKey(m)}.`);
  return { opened: true, id: aiKey(m), subject: m.subject, note: "Shown in Ember, in front of the user." };
}

async function status() {
  const errors = await errorLog.read();
  return {
    ember: api.runtime.getManifest?.().version,
    ai_sorting: store.settings.aiSort,
    accounts: store.accounts.map((node) => store.accountName(node.account.id)),
    sections: ["people", "calendar", "updates", "newsletters", "receipts"],
    // Work and Personal inboxes (null: one inbox): each one's accounts and groups (find_emails' inbox/group).
    inboxes: store.split ? Object.fromEntries(INBOX_IDS.map((inbox) => [inbox, {
      accounts: store.accounts.filter((node) => store.inboxOfAccount(node.account.id) === inbox && node.primary.some((f) => f.role === "inbox")).map((node) => store.accountName(node.account.id)),
      groups: groupsOf(inbox, store.settings).map((g) => ({ id: g.id, name: g.label, about: g.description, ...(g.hidden ? { hidden: true } : {}) })),
    }])) : null,
    marks: Object.keys(store.agentMarks).length,
    // Links to emails (each email's `link`): the address they open at, or null while they're off.
    links: store.mailLinkStatus?.url || null,
    // Failures Ember kept (see error-log.ts): text, where, how often, first/last seen.
    errors: errors.slice(0, 20).map(({ stack, ...entry }) => ({ ...entry, first: new Date(entry.first).toISOString(), last: new Date(entry.last).toISOString() })),
  };
}

// ---- Calendar: look at it, find free times, hold time (the user decides about invitations) ----

/** "2026-11-19" or an ISO time → local midnight of that day (today when not given). */
function dayParam(value: unknown): number {
  const text = String(value || "").trim();
  if (!text) { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  const at = /^\d{4}-\d{2}-\d{2}$/.test(text) ? localTime(text) : Date.parse(text);
  if (!Number.isFinite(at)) throw new Error(`"${text}" isn't a date (use YYYY-MM-DD).`);
  const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime();
}
async function calendarFor(name: unknown): Promise<string> {
  if (!calendar.available) throw new Error("This Ember has no calendar support.");
  if (!calendar.calendarsLoaded || !calendar.calendars.length) await calendar.loadCalendars();
  if (!calendar.writable.length) throw new Error("Ember has no calendar to add events to (connect one on the Calendar page).");
  const wanted = String(name || "").trim().toLowerCase();
  if (!wanted) return calendar.defaultCalendar(new Set(store.settings.calendarHidden));
  const found = calendar.writable.find((c) => calendar.pickName(c.accountId).toLowerCase() === wanted || c.email.toLowerCase() === wanted || c.name.toLowerCase() === wanted);
  if (!found) throw new Error(`No calendar "${name}". Use one of: ${calendar.writable.map((c) => calendar.pickName(c.accountId)).join(", ")}.`);
  return found.accountId;
}
const dayText = (at: number) => new Date(at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
const zoneName = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

async function calendarEvents(params: any) {
  const from = dayParam(params.start), days = clamp(params.days, 7, 1, 31);
  const to = new Date(from); to.setDate(to.getDate() + days);
  if (!calendar.available) throw new Error("This Ember has no calendar support.");
  const view = await api.sparkCalendar.calendarView(new Date(from).toISOString(), to.toISOString(), { details: false });
  const events = (view.events || []).filter((e: any) => e.response !== "decline").sort((a: any, b: any) => Date.parse(a.start) - Date.parse(b.start));
  return {
    range: days === 1 ? dayText(from) : `${dayText(from)} – ${dayText(to.getTime() - 1)}`, time_zone: zoneName(),
    events: events.slice(0, 300).map((e: any) => ({
      title: e.subject, start: e.start, end: e.end, all_day: e.allDay, ...(e.location ? { location: e.location } : {}), calendar: calendar.pickName(e.accountId),
      my_response: { accept: "accepted", tentative: "maybe", none: "not answered", organizer: "organizer" }[e.response as string] || e.response, show_as: e.freeBusy, ...(e.cancelled ? { cancelled: true } : {}),
    })),
    ...(view.errors?.length ? { unreadable: view.errors.map((x: any) => x.name || x.accountId) } : {}),
  };
}

async function free(params: any) {
  const people = (Array.isArray(params.attendees) ? params.attendees : []).map((x: any) => String(x?.email ?? x).trim()).filter(Boolean).slice(0, 15);
  const minutes = clamp(params.duration_minutes, 30, 15, 480), days = clamp(params.days, 5, 1, 7);
  const accountId = await calendarFor(params.calendar);
  const from = Math.max(dayParam(params.start), dayParam(""));
  const time = (value: unknown, fallback: number) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : fallback; };
  const busy = await calendar.availability(accountId, people, from, from + days * 86400000);
  const slots = freeSlots(busy, { from, to: from + days * 86400000, now: Date.now(), minutes, dayStart: time(params.earliest, 9 * 60), dayEnd: time(params.latest, 17 * 60), limit: clamp(params.limit, 5, 1, 10) });
  const me = calendar.emailOf(accountId).toLowerCase();
  return {
    calendar: calendar.pickName(accountId), time_zone: zoneName(), duration_minutes: minutes,
    people: busy.map((p) => ({ email: p.email, ...(p.email === me ? { you: true } : {}), ...(p.unknown ? { calendar_visible: false } : {}) })),
    free: slots.map((slot) => ({ start: new Date(slot.start).toISOString(), end: new Date(slot.end).toISOString(), label: slotLabel(slot) })),
    ...(busy.some((p) => p.unknown) ? { note: "Some people's calendars couldn't be seen (outside the organisation, or their server doesn't share busy times): their times aren't taken into account." } : {}),
  };
}

/** A person's name from saved mail (an agent often gives only the address). */
const nameFor = nameFromMail;

async function hold(params: any) {
  const title = String(params.title || "").trim().slice(0, 200);
  if (!title) throw new Error("Give the hold a title.");
  const start = Date.parse(String(params.start || "")), end = Date.parse(String(params.end || ""));
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("Give start and end as ISO times (with the time zone), e.g. 2026-11-19T13:00:00-05:00.");
  if (!(end > start) || end - start > 12 * 3600000) throw new Error("A hold lasts more than nothing and at most 12 hours.");
  if (start < Date.now() - 3600000 || start > Date.now() + 366 * 86400000) throw new Error("Hold time from now to a year ahead.");
  const invite = (Array.isArray(params.invite) ? params.invite : []).map((x: any) => typeof x === "string" ? { name: "", email: x.trim() } : { name: String(x?.name || "").trim(), email: String(x?.email || "").trim() })
    .filter((x: { email: string }) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x.email)).slice(0, 20)
    .map((x: { name: string; email: string }) => ({ ...x, name: x.name || nameFor(x.email) }));
  const accountId = await calendarFor(params.calendar);
  const notes = String(params.notes || "").trim().slice(0, 4000);
  const created = await api.sparkCalendar.createEvent(accountId, {
    subject: title, location: String(params.location || "").trim().slice(0, 200), body: [notes, "Held by an AI agent through Ember. Nobody has been invited."].filter(Boolean).join("\n\n"),
    start: new Date(start).toISOString(), end: new Date(end).toISOString(), allDay: false, freeBusy: "Busy", reminder: 15, attendees: [], recurrence: null, timeZone: windowsZone(),
  });
  window.dispatchEvent(new Event("spark:calendar-changed"));
  return {
    event_id: `${accountId}:${created.id}`, account_id: accountId, item_id: created.id, title, start: new Date(start).toISOString(), end: new Date(end).toISOString(), calendar: calendar.pickName(accountId), to_invite: invite,
    note: invite.length ? `Held on the user's calendar; nobody was invited. The user decides in Ember (Agent Activity → To review) whether to invite ${invite.map((x: { name: string; email: string }) => x.name || x.email).join(", ")}.` : "Held on the user's calendar; nobody was invited.",
  };
}

const METHODS: Record<string, (params: any) => unknown> = { find, read, mark, draft, marked, status, open, calendar: calendarEvents, free, hold };

/** An email an agent named, as Agent Activity shows it (sender and subject from Ember's saved mail). */
function emailRef(id: string): EmailRef | null {
  const key = aiKey({ headerMessageId: id });
  if (!key) return null;
  const m = mailCache.all().find((x) => aiKey(x) === key);
  return { id: key, from: m?.author || "", subject: m?.subject || "" };
}
/** Each email's mark before an agent's change, for Undo. */
function marksBefore(params: any): Record<string, MarkBefore> {
  const ids: string[] = Array.isArray(params?.ids) ? params.ids.map(String).slice(0, 200) : params?.id ? [String(params.id)] : [];
  const out: Record<string, MarkBefore> = {};
  for (const id of ids) {
    const key = aiKey({ headerMessageId: id });
    if (!key) continue;
    const mark = store.agentMarks[key];
    out[key] = mark ? { reply: mark.reply, important: mark.important, top: mark.top, note: mark.note } : null;
  }
  return out;
}

let listening = false;
/** Answer agents' requests (registered once per Ember page), and open or close the socket to match Settings. */
export async function syncAgentBridge() {
  const agent = api?.sparkAgent;
  if (!agent) return null;
  if (!listening) {
    listening = true;
    agent.onRequest.addListener(async (key: string, method: string, params: string) => {
      let answer: any;
      let request: any = {};
      let who = "unknown";
      let log = false;
      let before: Record<string, MarkBefore> | undefined;
      const now = Date.now();
      try {
        request = JSON.parse(params || "{}") || {};
        // Which agent (its MCP client's own name, passed on by spark-mcp.mjs), kept apart from the tool's arguments.
        who = String(request._agent || "unknown").slice(0, 80);
        const title = request._agent_title ? String(request._agent_title).slice(0, 80) : undefined;
        delete request._agent; delete request._agent_title;
        const handler = METHODS[method];
        if (!handler) throw new Error(`Unknown request "${method}".`);
        if (!store.settings.agentAccess) throw new Error("AI agents are turned off in Ember's Settings.");
        if (store.agentBlocked(who)) throw new Error(`The user blocked ${agentLook(who, title).name} in Ember's Settings (AI agents).`);
        log = true;
        store.agentSeen(who, title);
        if (method === "mark") before = marksBefore(request);
        answer = { result: await handler(request) };
      } catch (error: any) { answer = { error: error?.message || String(error) }; }
      await agent.reply(key, JSON.stringify(answer)).catch(() => {});
      if (log) try { store.logAgent(entryFor(method, request, answer, { agent: who, now, ref: emailRef, before })); } catch { /* the log is best effort */ }
    });
  }
  if (store.settings.agentAccess) {
    // The MCP server agents run ships inside Ember; put (or refresh) it where Settings says it is.
    if (typeof agent.installServer === "function") {
      try { await agent.installServer(await (await fetch(api.runtime.getURL("mcp/ember-mcp.mjs"))).text()); }
      catch (error: any) { errorLog.add(`agents: couldn't install the MCP server: ${error?.message || error}`); }
    }
    return agent.start().catch((error: any) => ({ error: error?.message || String(error) }));
  }
  await agent.stop().catch(() => {});
  return null;
}
