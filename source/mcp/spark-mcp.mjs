#!/usr/bin/env node
// Ember for Thunderbird's MCP server (stdio). An agent (Claude Code, Claude Desktop, …) runs this; it forwards
// tool calls to the open Ember window through Ember's local socket (Settings → Let AI agents use Ember).
// Tools: find_emails, read_email, open_email, mark_emails, draft_reply (saved to Drafts, never sent), list_marked,
// ember_status, and the calendar: calendar_events, find_free_times, hold_time (invites nobody: the user decides). Every email comes with a link that opens it in Ember when the user clicks it.
// No dependencies: MCP's stdio transport is newline-delimited JSON-RPC 2.0.
//
//   claude mcp add --scope user ember -- node "$HOME/Library/Application Support/Ember/ember-mcp.mjs"
//
// SPARK_AGENT_SOCKET overrides the socket path (tests).
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const VERSION = "1.3.0";
const SOCKET = process.env.SPARK_AGENT_SOCKET || path.join(os.homedir(), "Library", "Application Support", "Ember", "agent.sock");
const SECTION = { type: "string", enum: ["people", "calendar", "updates", "newsletters", "receipts"] };
const ID_HELP = "an email's id from find_emails (its Message-ID)";
const LINK_HELP = "Each email also has a link (http://127.0.0.1:…/email/…): when the user clicks it, the email opens in Ember on their Mac. Whenever you mention an email to the user, link it, e.g. [subject](link), so they can open it in one click. Give the link exactly as returned.";

const TOOLS = [
  {
    name: "find_emails",
    title: "Find emails",
    description: "Find emails in the user's Ember inbox (Thunderbird mail saved for the last 90 days; the Inbox unless folder is \"all\"). Each result has an id, sender, recipients, subject, date, unread, its Ember section (people, calendar, updates, newsletters, receipts — receipts, invoices and bills, with AI sorting on), with Work and Personal inboxes its inbox (work or personal) and group there (ids from ember_status's inboxes), signals (needs_reply, important, receipt, promotion — from Ember's AI sorting or earlier marks), whether it's at the top, a short snippet, and a link that opens it in Ember. Use signal \"needs_reply\" or \"important\" to find what may need attention, then read_email to check, and mark_emails to set marks or bring emails to the top. " + LINK_HELP,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to search for (subject, people, body). Leave out to list by the filters only." },
        section: { ...SECTION, description: "Only emails in this Ember section." },
        inbox: { type: "string", enum: ["work", "personal"], description: "Only emails of the Work or Personal inbox (when Ember splits them; see ember_status)." },
        group: { type: "string", description: "Only emails in this group of the inbox given (a group id from ember_status's inboxes, e.g. team, purchases)." },
        signal: { type: "string", enum: ["needs_reply", "important", "receipt", "promotion"], description: "Only emails Ember marks this way (AI sorting or earlier marks)." },
        unread_only: { type: "boolean", description: "Only unread emails." },
        top_only: { type: "boolean", description: "Only emails currently at the top of the inbox." },
        days: { type: "integer", minimum: 1, maximum: 90, description: "How far back to look (default 14)." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Most results to return (default 25), newest first." },
        folder: { type: "string", enum: ["inbox", "all"], description: "The Inbox (default) or all saved folders except Spam and Trash." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    method: "find",
  },
  {
    name: "read_email",
    title: "Read an email",
    description: "Read one email's text (and its attachment names), to decide whether it needs a reply or is important. " + LINK_HELP,
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: `The email: ${ID_HELP}.` }, max_chars: { type: "integer", minimum: 500, maximum: 50000, description: "Longest text to return (default 20000)." } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    method: "read",
  },
  {
    name: "open_email",
    title: "Open an email in Ember",
    description: "Show an email to the user in Ember, brought to the front of their screen (as when they click its link). Use it when the user asks to see or open an email now; to point them at emails, give their links instead.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: `The email: ${ID_HELP}.` } },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    method: "open",
  },
  {
    name: "mark_emails",
    title: "Mark emails in Ember",
    description: "Set Ember's marks on emails. top: true brings them to the top of the user's inbox (a \"Top\" group above the date groups) until set to false, the user removes them, or (for emails marked needs_reply) the user replies. needs_reply and important show Ember's badges and filters (true or false overrides Ember's AI guess). note adds a short reason the user can see. Marks live only in Ember: the email itself isn't changed, sent, moved or deleted.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 200, description: `The emails: ${ID_HELP}s.` },
        needs_reply: { type: "boolean", description: "The user needs to reply (true) or doesn't (false)." },
        important: { type: "boolean", description: "Important or time-sensitive (true) or not (false)." },
        top: { type: "boolean", description: "Bring to the top of the inbox (true) or take off it (false)." },
        note: { type: "string", maxLength: 300, description: "Why, in a few words (shown to the user). Empty to clear." },
      },
      required: ["ids"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    method: "mark",
  },
  {
    name: "draft_reply",
    title: "Draft a reply",
    description: "Write a reply to an email and save it as a draft in the user's Drafts folder. Nothing is sent: the user reviews, edits and sends it from Ember (the email gets a \"Draft\" badge that opens it). The draft is a proper reply (addressed and threaded by Thunderbird, from the right account, with the user's signature and the original quoted below). Write only the new text, in plain text, in the user's voice; no greeting or signature unless they'd write one. Calling it again for the same email replaces the agent's earlier draft (moved to Trash) unless replace_previous is false.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: `The email to reply to: ${ID_HELP}.` },
        text: { type: "string", minLength: 1, maxLength: 20000, description: "The reply's text (plain text; blank lines separate paragraphs)." },
        reply_all: { type: "boolean", description: "Reply to everyone (default: just the sender)." },
        top: { type: "boolean", description: "Also bring the email to the top of the inbox." },
        replace_previous: { type: "boolean", description: "Replace the agent's earlier draft for this email (default true)." },
      },
      required: ["id", "text"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    method: "draft",
  },
  {
    name: "list_marked",
    title: "List marked emails",
    description: "Every email with an Ember mark (needs reply, important, top, note), with who set it (agent or user) and when.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    method: "marked",
  },
  {
    name: "ember_status",
    title: "Ember status",
    description: "Whether Ember is reachable, its version, its accounts, the address emails' links open at (links; null while the user has them off), whether AI sorting (the source of needs_reply/important signals) is on, the Work and Personal inboxes with their accounts and groups (null when Ember has one inbox), and the recent failures Ember logged (errors: text, where, count, first and last seen).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    method: "status",
  },
  {
    name: "calendar_events",
    title: "Calendar events",
    description: "The user's calendar (their Exchange and Thunderbird calendars, such as Google's, in Ember) for some days: each event's title, start and end (ISO, UTC), all-day, location, calendar, the user's answer (accepted, maybe, not answered, organizer) and how it shows (Busy, Free, Tentative…).",
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "string", description: "First day, YYYY-MM-DD in the user's time zone (default today)." },
        days: { type: "integer", minimum: 1, maximum: 31, description: "How many days (default 7)." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    method: "calendar",
  },
  {
    name: "find_free_times",
    title: "Find free times",
    description: "Times the user and the given people are all free for a meeting, from Exchange's free/busy, within working hours on weekdays. People outside the user's organisation can't be seen (their calendar_visible is false) and aren't taken into account. Returns up to `limit` times, the first of each free stretch, with labels like \"Thu 1:00 PM\".",
    inputSchema: {
      type: "object",
      properties: {
        attendees: { type: "array", items: { type: "string" }, maxItems: 15, description: "Email addresses of the other people (the user is always included)." },
        duration_minutes: { type: "integer", minimum: 15, maximum: 480, description: "How long the meeting is (default 30)." },
        start: { type: "string", description: "First day to look, YYYY-MM-DD (default today; never before now)." },
        days: { type: "integer", minimum: 1, maximum: 7, description: "How many days to look (default 5)." },
        earliest: { type: "string", description: "Earliest start in the day, HH:MM in the user's time zone (default 09:00)." },
        latest: { type: "string", description: "Latest end in the day, HH:MM (default 17:00)." },
        limit: { type: "integer", minimum: 1, maximum: 10, description: "Most times to return (default 5)." },
        calendar: { type: "string", description: "Whose free/busy service to ask: a calendar name from calendar_events (default the user's first calendar)." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    method: "free",
  },
  {
    name: "hold_time",
    title: "Hold time on the calendar",
    description: "Put a hold on the user's calendar (an event that invites nobody). If people should be invited, list them in `invite`: Ember asks the user in Agent Activity (To review) and sends the invitation only when they confirm. Use find_free_times first to pick a time everyone's free.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 200, description: "The event's title." },
        start: { type: "string", description: "Start, ISO 8601 with the time zone (e.g. 2026-11-19T13:00:00-05:00, or a free time's start)." },
        end: { type: "string", description: "End, ISO 8601 with the time zone." },
        invite: { type: "array", items: { type: "string" }, maxItems: 20, description: "Email addresses to invite if the user confirms (nobody is invited by this call)." },
        location: { type: "string", maxLength: 200, description: "Where (optional)." },
        notes: { type: "string", maxLength: 4000, description: "Notes for the event (optional)." },
        calendar: { type: "string", description: "Which calendar: a name from calendar_events (default the user's first)." },
      },
      required: ["title", "start", "end"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    method: "hold",
  },
];

// Every tool also takes a reason, shown to the user in Ember's Agent Activity next to what the agent did.
const REASON = { type: "string", maxLength: 200, description: "Why you're doing this, in a few words the user would recognize (e.g. \"find what Dana still needs for Friday\"). Shown in Ember's Agent Activity." };
for (const tool of TOOLS) tool.inputSchema.properties.reason = REASON;
/** The agent, as its MCP client named itself (initialize's clientInfo): Ember's Agent Activity shows it. */
let client = { name: "unknown", title: "" };

// ---- Ember's socket: one JSON request per line, answers matched by id ----
let socket = null;
let buffer = "";
let seq = 0;
const waiting = new Map();
function connect() {
  if (socket && !socket.destroyed) return Promise.resolve(socket);
  return new Promise((resolve, reject) => {
    const next = net.createConnection(SOCKET);
    next.setEncoding("utf8");
    next.once("connect", () => { socket = next; resolve(next); });
    next.once("error", (error) => {
      if (socket !== next) reject(new Error(error.code === "ENOENT" || error.code === "ECONNREFUSED"
        ? "Ember isn't accepting agents. In Ember: Settings → Let AI agents use Ember, and keep Ember open (minimized is fine)."
        : `Couldn't reach Ember: ${error.message}`));
    });
    next.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let answer;
        try { answer = JSON.parse(line); } catch { continue; }
        const entry = waiting.get(answer.id);
        if (!entry) continue;
        waiting.delete(answer.id);
        clearTimeout(entry.timer);
        if (answer.error) entry.reject(new Error(answer.error)); else entry.resolve(answer.result);
      }
    });
    next.on("close", () => {
      if (socket === next) socket = null;
      buffer = "";
      for (const [id, entry] of waiting) { clearTimeout(entry.timer); entry.reject(new Error("Ember closed the connection (Thunderbird quit or Ember restarted). Try again.")); waiting.delete(id); }
    });
  });
}
async function spark(method, params) {
  const conn = await connect();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error("Ember didn't answer in time.")); }, 65000);
    waiting.set(id, { resolve, reject, timer });
    conn.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

// ---- MCP over stdio ----
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
async function handle(request) {
  const { id, method, params } = request;
  if (method === "initialize") {
    const info = params?.clientInfo || {};
    if (info.name) client = { name: String(info.name).slice(0, 80), title: String(info.title || "").slice(0, 80) };
    return send({ id, result: {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "ember", title: "Ember for Thunderbird", version: VERSION },
      instructions: "Ember is the user's email app (inside Thunderbird). To surface what needs attention: find_emails with signal needs_reply or important (or a query), read_email to check, then mark_emails with top: true (and needs_reply/important, plus a short note) to bring those emails to the top of the inbox. To help answer, draft_reply saves a reply draft for the user to review; nothing is ever sent. Marks and drafts never send, move or delete the user's mail. Every email has a link: whenever you mention an email to the user, link it as [subject](link) so one click opens it in Ember; open_email shows one right away. Every tool takes an optional reason: say in a few words why, and the user sees it in Ember's Agent Activity next to what you did. For scheduling: calendar_events shows the user's calendar, find_free_times finds when everyone's free, and hold_time holds a time; it never invites anyone: list the people in invite and the user confirms the invitation in Ember.",
    } });
  }
  if (method === "ping") return send({ id, result: {} });
  if (method === "tools/list") return send({ id, result: { tools: TOOLS.map(({ method: _, ...tool }) => tool) } });
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
    try {
      const result = await spark(tool.method, { ...(params.arguments || {}), _agent: client.name, ...(client.title ? { _agent_title: client.title } : {}) });
      return send({ id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result } });
    } catch (error) {
      return send({ id, result: { content: [{ type: "text", text: error.message }], isError: true } });
    }
  }
  if (id !== undefined && id !== null && !String(method || "").startsWith("notifications/")) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let request;
  try { request = JSON.parse(line); } catch { return send({ id: null, error: { code: -32700, message: "Parse error" } }); }
  void handle(request).catch((error) => request.id !== undefined && send({ id: request.id, error: { code: -32603, message: error.message } }));
});
process.stdin.on("end", () => { socket?.end(); process.exit(0); });
