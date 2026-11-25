// Agent Activity (2026-11-16): what AI agents did in Ember through its MCP server, kept on this Mac (storage
// `agentActivity`, newest first, for Settings → Keep activity for). The bridge (agent-bridge.ts) records one entry
// per request; the page groups them into sessions (an agent's back-to-back work), folds a run of reads into one row,
// and lists what needs the user (To review). Agents name themselves when they connect (MCP clientInfo); the
// registry (storage `agentRegistry`) remembers each one, when it was first and last seen, and whether the user
// blocked it. Pure; unit-tested in test/agent-activity.test.ts.

export interface EmailRef { id: string; from: string; subject: string }
export type ActivityKind = "search" | "browse" | "read" | "open" | "mark" | "draft" | "check" | "calendar" | "hold";
/** Time an agent held on the user's calendar (nobody invited until the user says so). */
export interface Hold { accountId: string; itemId: string; subject: string; start: number; end: number; invite: { name: string; email: string }[] }
export type HoldState = "held" | "invited" | "kept" | "removed";
/** A mark as it was before an agent changed it (for Undo); null: the email had none. */
export type MarkBefore = { reply?: boolean; important?: boolean; top?: boolean; note?: string } | null;

export interface ActivityEntry {
  id: string;
  at: number;
  /** The agent's own name for itself (MCP clientInfo.name), e.g. "claude-code". */
  agent: string;
  kind: ActivityKind;
  /** Why, in the agent's words (every tool takes an optional reason). */
  reason?: string;
  /** search: the words; browse: the filters, as text. */
  query?: string;
  /** browse/search: how many emails matched. */
  found?: number;
  emails?: EmailRef[];
  /** mark: what changed; before: each email's mark before (for Undo). */
  change?: { reply?: boolean; important?: boolean; top?: boolean; note?: string };
  before?: Record<string, MarkBefore>;
  /** draft: the draft's Message-ID and its first lines. */
  draft?: string;
  preview?: string;
  /** check: what it looked at ("status" | "marked"); calendar: "events" or "free". */
  what?: string;
  /** hold: the time held. */
  hold?: Hold;
  error?: string;
  undone?: boolean;
}

export interface AgentInfo { first: number; last: number; count: number; title?: string; blocked?: boolean; alert?: boolean }
export interface AgentRegistry { since: number; agents: Record<string, AgentInfo> }

export const ACTIVITY_MAX = 1500;
export const SESSION_GAP_MS = 10 * 60000;
/** New agents aren't announced in the registry's first day: the agents already in use are learned quietly. */
export const NEW_AGENT_GRACE_MS = 86400000;
const PREVIEW_CHARS = 240;
const REASON_CHARS = 200;

// ---- who ----

const KNOWN: Record<string, { name: string; initials: string; color: string }> = {
  "claude-code": { name: "Claude Code", initials: "CC", color: "#c2410c" },
  "codex-mcp-client": { name: "Codex", initials: "Cx", color: "#2b2d33" },
  codex: { name: "Codex", initials: "Cx", color: "#2b2d33" },
  "claude-ai": { name: "Claude", initials: "C", color: "#7c3aed" },
  "cursor-vscode": { name: "Cursor", initials: "Cu", color: "#0f766e" },
  cursor: { name: "Cursor", initials: "Cu", color: "#0f766e" },
};
const PALETTE = ["#2563eb", "#15803d", "#be185d", "#a16207", "#0f766e", "#7c3aed", "#b91c1c", "#475569"];

/** How Ember shows an agent: its name, initials and badge colour. */
export function agentLook(id: string, title?: string): { name: string; initials: string; color: string } {
  const known = KNOWN[String(id || "").toLowerCase()];
  if (known) return known;
  if (!id || id === "unknown") return { name: "An agent", initials: "AI", color: "#5f6168" };
  const name = (title || id).replace(/[-_]+/g, " ").replace(/\b(mcp|client)\b/gi, "").replace(/\s+/g, " ").trim() || id;
  const pretty = name.charAt(0).toUpperCase() + name.slice(1);
  const words = pretty.split(" ").filter(Boolean);
  const initials = (words.length > 1 ? words[0][0] + words[1][0] : pretty.slice(0, 2)).toUpperCase();
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { name: pretty, initials, color: PALETTE[h % PALETTE.length] };
}

/** The registry after a request from this agent; isNew when the user should hear about it. */
export function seenAgent(registry: AgentRegistry | null | undefined, id: string, now: number, title?: string): { registry: AgentRegistry; isNew: boolean } {
  const base: AgentRegistry = registry && typeof registry.since === "number" ? { since: registry.since, agents: { ...registry.agents } } : { since: now, agents: {} };
  const had = base.agents[id];
  const isNew = !had && now - base.since > NEW_AGENT_GRACE_MS;
  base.agents[id] = { ...(had || { first: now, count: 0 }), last: now, count: (had?.count || 0) + 1, ...(title ? { title } : {}), ...(isNew ? { alert: true } : {}) };
  return { registry: base, isNew };
}

// ---- what ----

const clean = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** find's filters in words: "Needs reply, unread, last 7 days". */
export function filtersText(params: any): string {
  const parts: string[] = [];
  const signal: Record<string, string> = { needs_reply: "Needs reply", important: "Important", receipt: "Receipts", promotion: "Promotions" };
  const section: Record<string, string> = { people: "People", calendar: "Calendar", updates: "Updates", newsletters: "Newsletters", receipts: "Receipts" };
  if (params?.signal && signal[params.signal]) parts.push(signal[params.signal]);
  if (params?.section && section[params.section]) parts.push(section[params.section]);
  if (params?.inbox) parts.push(params.inbox === "work" ? "Work inbox" : "Personal inbox");
  if (params?.top_only) parts.push("at the top");
  if (params?.unread_only) parts.push("unread");
  if (params?.folder === "all") parts.push("all folders");
  const days = Number(params?.days) || 14;
  parts.push(`last ${days} ${days === 1 ? "day" : "days"}`);
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The entry for one answered request (null for requests that aren't worth showing). */
export function entryFor(method: string, params: any, outcome: { result?: any; error?: string }, ctx: {
  agent: string; now: number; seq?: number;
  /** The email (as the agent named it) as a ref, when Ember has it. */
  ref?: (id: string) => EmailRef | null;
  before?: Record<string, MarkBefore>;
}): ActivityEntry | null {
  const base = { id: `${ctx.now.toString(36)}-${(ctx.seq ?? 0).toString(36)}`, at: ctx.now, agent: ctx.agent || "unknown", ...(params?.reason ? { reason: clean(params.reason, REASON_CHARS) } : {}), ...(outcome.error ? { error: clean(outcome.error, 300) } : {}) };
  const r = outcome.result || {};
  const ref = (id: string) => (id && ctx.ref?.(id)) || (id ? { id, from: "", subject: "" } : null);
  const one = (summary: any, id: string) => summary?.id ? [{ id: summary.id, from: summary.from || "", subject: summary.subject || "" }] : [ref(String(id || ""))].filter(Boolean) as EmailRef[];
  switch (method) {
    case "find": {
      const query = clean(params?.query, 120);
      return query ? { ...base, kind: "search", query, found: r.total } : { ...base, kind: "browse", query: filtersText(params), found: r.total };
    }
    case "read": return { ...base, kind: "read", emails: one(r, params?.id) };
    case "open": return { ...base, kind: "open", emails: one(r.subject !== undefined ? { ...r, from: ref(r.id || params?.id)?.from || "" } : null, params?.id) };
    case "mark": {
      const ids: string[] = Array.isArray(params?.ids) ? params.ids.map(String) : params?.id ? [String(params.id)] : [];
      const change: ActivityEntry["change"] = {};
      for (const key of ["reply", "important", "top"] as const) {
        const value = params?.[key === "reply" ? "needs_reply" : key];
        if (typeof value === "boolean") change[key] = value;
      }
      if (typeof params?.note === "string") change.note = clean(params.note, 300);
      return { ...base, kind: "mark", emails: ids.slice(0, 50).map((id) => ref(id)!).filter(Boolean), change, ...(ctx.before && !outcome.error ? { before: ctx.before } : {}) };
    }
    case "draft": return { ...base, kind: "draft", emails: one(null, r.replied_to || params?.id), ...(r.draft_id ? { draft: String(r.draft_id) } : {}), preview: clean(params?.text, PREVIEW_CHARS) };
    case "marked": return { ...base, kind: "check", what: "marked" };
    case "calendar": return { ...base, kind: "calendar", what: "events", query: clean(r.range || "", 120), found: Array.isArray(r.events) ? r.events.length : undefined };
    case "free": {
      const who = Array.isArray(r.people) ? r.people.filter((p: any) => !p.you).map((p: any) => p.name || p.email).join(", ") : "";
      const slots = Array.isArray(r.free) ? r.free.map((f: any) => f.label).join(", ") : "";
      return { ...base, kind: "calendar", what: "free", query: clean(`${who ? `with ${who}` : ""}${slots ? `: ${slots}` : outcome.error ? "" : ": none"}`, 200), found: Array.isArray(r.free) ? r.free.length : undefined };
    }
    case "hold": {
      const hold: Hold | undefined = r.event_id ? { accountId: String(r.account_id || ""), itemId: String(r.item_id || ""), subject: clean(r.title, 200), start: Date.parse(r.start), end: Date.parse(r.end),
        invite: Array.isArray(r.to_invite) ? r.to_invite.map((p: any) => ({ name: clean(p.name, 80), email: clean(p.email, 200) })) : [] } : undefined;
      return { ...base, kind: "hold", ...(hold ? { hold } : {}), query: clean(params?.title, 200) };
    }
    case "status": return { ...base, kind: "check", what: "status" };
    default: return null;
  }
}

/** The log with a new entry, newest first, without what's older than the days kept. */
export function addEntry(log: ActivityEntry[], entry: ActivityEntry, now: number, days = 30, max = ACTIVITY_MAX): ActivityEntry[] {
  const cutoff = now - days * 86400000;
  return [entry, ...log.filter((e) => e.at >= cutoff)].slice(0, max);
}

/** A stored value as a log (damaged entries dropped). */
export function readLog(value: any): ActivityEntry[] {
  return Array.isArray(value) ? value.filter((e) => e && typeof e.id === "string" && typeof e.at === "number" && typeof e.kind === "string") : [];
}

// ---- how it's shown ----

export type Filter = "all" | "drafts" | "marks" | "reads" | "everything" | `agent:${string}`;
export const isWrite = (e: ActivityEntry) => e.kind === "mark" || e.kind === "draft" || e.kind === "hold";

export function matches(e: ActivityEntry, filter: Filter): boolean {
  if (filter === "everything") return true;
  if (e.kind === "check") return false;
  if (filter === "all") return true;
  if (filter.startsWith("agent:")) return e.agent === filter.slice(6);
  if (filter === "drafts") return e.kind === "draft";
  if (filter === "marks") return e.kind === "mark";
  return !isWrite(e);
}

export interface Session { key: string; agent: string; day: number; start: number; end: number; entries: ActivityEntry[]; reason: string }

/** Local midnight of a time. */
export const dayOf = (at: number) => { const d = new Date(at); d.setHours(0, 0, 0, 0); return +d; };

/** Entries (newest first) as sessions: one agent's requests with no gap over SESSION_GAP_MS, within one day. */
export function sessionsOf(entries: ActivityEntry[], gap = SESSION_GAP_MS): Session[] {
  const out: Session[] = [];
  for (const e of entries) {
    const last = out[out.length - 1];
    if (last && last.agent === e.agent && last.day === dayOf(e.at) && last.start - e.at <= gap) { last.entries.push(e); last.start = e.at; if (!last.reason && e.reason) last.reason = e.reason; continue; }
    out.push({ key: `${e.agent}:${e.id}`, agent: e.agent, day: dayOf(e.at), start: e.at, end: e.at, entries: [e], reason: e.reason || "" });
  }
  // The reason the agent gave first in the session says what it set out to do.
  for (const s of out) s.reason = [...s.entries].reverse().find((e) => e.reason)?.reason || "";
  return out;
}

export type Row = { kind: "entry"; entry: ActivityEntry } | { kind: "reads"; entries: ActivityEntry[]; emails: EmailRef[]; at: number };

/** A session's rows: back-to-back successful reads become one row with their emails. */
export function rowsOf(entries: ActivityEntry[], fold = true): Row[] {
  const rows: Row[] = [];
  for (const e of entries) {
    const last = rows[rows.length - 1];
    if (fold && e.kind === "read" && !e.error && last) {
      if (last.kind === "reads") { last.entries.push(e); for (const m of e.emails || []) if (!last.emails.some((x) => x.id === m.id)) last.emails.push(m); continue; }
      if (last.entry.kind === "read" && !last.entry.error) {
        const emails = [...(last.entry.emails || [])];
        for (const m of e.emails || []) if (!emails.some((x) => x.id === m.id)) emails.push(m);
        rows[rows.length - 1] = { kind: "reads", entries: [last.entry, e], emails, at: last.entry.at };
        continue;
      }
    }
    rows.push({ kind: "entry", entry: e });
  }
  return rows;
}

/** "Searched once, read 6 emails, marked 1, drafted 1 reply, 1 failed". */
export function summaryOf(entries: ActivityEntry[]): string {
  const ok = entries.filter((e) => !e.error);
  const n = (k: ActivityKind) => ok.filter((e) => e.kind === k).length;
  const times = (x: number) => (x === 1 ? "once" : `${x} times`);
  const reads = new Set(ok.filter((e) => e.kind === "read").flatMap((e) => (e.emails || []).map((m) => m.id))).size;
  const parts: string[] = [];
  if (n("search")) parts.push(`searched ${times(n("search"))}`);
  if (n("browse")) parts.push(`browsed ${times(n("browse"))}`);
  if (reads) parts.push(`read ${reads} ${reads === 1 ? "email" : "emails"}`);
  if (n("open")) parts.push(`showed you ${n("open")}`);
  if (n("mark")) parts.push(`marked ${ok.filter((e) => e.kind === "mark").reduce((t, e) => t + (e.emails?.length || 0), 0)}`);
  if (n("draft")) parts.push(`drafted ${n("draft")} ${n("draft") === 1 ? "reply" : "replies"}`);
  const looks = ok.filter((e) => e.kind === "calendar" && e.what === "events").length;
  const free = ok.filter((e) => e.kind === "calendar" && e.what === "free").length;
  if (looks) parts.push(`checked your calendar${looks > 1 ? ` ${times(looks)}` : ""}`);
  if (free) parts.push(`found free times${free > 1 ? ` ${times(free)}` : ""}`);
  if (n("hold")) parts.push(`held ${n("hold")} ${n("hold") === 1 ? "time" : "times"}`);
  if (n("check")) parts.push(`checked Ember ${times(n("check"))}`);
  const failed = entries.length - ok.length;
  if (failed) parts.push(`${failed} failed`);
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What a mark did, in words: "moved to the top, needs reply". */
export function markWords(change: ActivityEntry["change"] = {}): string {
  const parts: string[] = [];
  if (change.top === true) parts.push("to the top");
  if (change.top === false) parts.push("off the top");
  if (change.reply === true) parts.push("needs reply");
  if (change.reply === false) parts.push("no reply needed");
  if (change.important === true) parts.push("important");
  if (change.important === false) parts.push("not important");
  if (!parts.length && change.note) parts.push("with a note");
  return parts.join(", ");
}

export type DraftState = "waiting" | "sent" | "discarded" | "replaced";
/** Drafts an agent replaced with a newer one for the same email (known from the log alone). */
export function replacedDrafts(entries: ActivityEntry[]): Set<string> {
  const newest = new Map<string, string>();
  const out = new Set<string>();
  for (const e of entries) { // newest first
    if (e.kind !== "draft" || e.error || !e.emails?.[0]) continue;
    const key = `${e.agent}\n${e.emails[0].id}`;
    if (newest.has(key)) out.add(e.id); else newest.set(key, e.id);
  }
  return out;
}

export type ReviewItem = { entry: ActivityEntry; email: EmailRef; what: "draft" | "top" } | { entry: ActivityEntry; email?: undefined; what: "hold"; hold: Hold };
/** What agents left for the user: drafts still waiting, emails put on top (still on top), and calendar holds not
 *  yet decided, not dismissed. */
export function reviewItems(entries: ActivityEntry[], o: { dismissed: Set<string>; draftState: (e: ActivityEntry) => DraftState | undefined; onTop: (emailId: string) => boolean; holdState?: (e: ActivityEntry) => HoldState | undefined }): ReviewItem[] {
  const out: ReviewItem[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.kind === "hold" && e.hold && !e.error && !o.dismissed.has(e.id) && (o.holdState?.(e) || "held") === "held") { out.push({ entry: e, what: "hold", hold: e.hold }); continue; }
    if (e.error || e.undone || o.dismissed.has(e.id) || !e.emails?.length) continue;
    if (e.kind === "draft" && e.draft && o.draftState(e) === "waiting") out.push({ entry: e, email: e.emails[0], what: "draft" });
    if (e.kind === "mark" && e.change?.top === true) for (const m of e.emails) {
      if (seen.has(m.id) || !o.onTop(m.id)) continue;
      seen.add(m.id);
      out.push({ entry: e, email: m, what: "top" });
    }
  }
  return out;
}

/** The agents' marks and drafts on these emails (by Message-ID), newest first: what the reader says. */
export function touchesOf(entries: ActivityEntry[], ids: Set<string>): ActivityEntry[] {
  return entries.filter((e) => isWrite(e) && !e.error && !e.undone && (e.emails || []).some((m) => ids.has(m.id)));
}
