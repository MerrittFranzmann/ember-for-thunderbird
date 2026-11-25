// Senders you ignore: bulk senders (newsletters, notifications) with several emails in the last 90 days
// that you've hardly opened, so you can unsubscribe and archive them in one step. Pure; unit-tested
// (test/ignored-senders.test.ts). The store adds what each sender's newest email says about unsubscribing.
import { displayName, emailOf } from "./format";
import type { MessageHeader } from "./types";

/** At least this many emails, of which at most this share opened. */
export const IGNORE_RULE = { minEmails: 5, maxOpenedShare: 0.1, days: 90 };
const NOT_RECEIVED = new Set(["sent", "drafts", "templates", "outbox", "trash", "junk"]);

export interface SenderSummary {
  address: string;
  name: string;
  total: number;
  opened: number;
  /** Of those, still in an Inbox. */
  inInbox: number;
  latest: MessageHeader;
  /** Recent distinct subjects, newest first (up to 3). */
  subjects: string[];
  /** Emails since the unsubscribe was done (unsubscribed senders only). */
  since?: number;
}

/** Everyone you've written to (To, Cc, Bcc of your sent mail): never "ignored". */
export function writtenTo(headers: MessageHeader[], roleOf: (folderId?: string) => string | null): Set<string> {
  const out = new Set<string>();
  for (const m of headers) if (roleOf(m.folder?.id) === "sent") for (const a of [...(m.recipients || []), ...(m.ccList || []), ...(m.bccList || [])]) { const e = emailOf(a).toLowerCase(); if (e) out.add(e); }
  return out;
}

/** Senders whose received mail you mostly leave unopened, most ignored first. */
export function ignoredSenders(headers: MessageHeader[], o: {
  me: Set<string>; written: Set<string>; roleOf: (folderId?: string) => string | null; kept?: string[]; now?: number;
}): SenderSummary[] {
  const now = o.now ?? Date.now();
  const since = now - IGNORE_RULE.days * 86400000;
  const kept = new Set((o.kept || []).map((a) => a.toLowerCase()));
  const groups = new Map<string, MessageHeader[]>();
  for (const m of headers) {
    const date = +new Date(m.date);
    if (m.junk || !(date >= since && date <= now + 60000)) continue;
    const role = o.roleOf(m.folder?.id);
    if (role && NOT_RECEIVED.has(role)) continue;
    const address = emailOf(m.author).toLowerCase();
    if (!address || o.me.has(address)) continue;
    const list = groups.get(address);
    if (list) list.push(m); else groups.set(address, [m]);
  }
  const out: SenderSummary[] = [];
  for (const [address, list] of groups) {
    if (list.length < IGNORE_RULE.minEmails || o.written.has(address) || kept.has(address)) continue;
    if (list.some((m) => m.flagged)) continue; // something of theirs was worth pinning
    const opened = list.filter((m) => m.read).length;
    if (opened > list.length * IGNORE_RULE.maxOpenedShare) continue;
    list.sort((a, b) => +new Date(b.date) - +new Date(a.date));
    const subjects: string[] = [];
    for (const m of list) { const s = (m.subject || "").trim(); if (s && !subjects.includes(s)) subjects.push(s); if (subjects.length === 3) break; }
    out.push({ address, name: displayName(list[0].author) || address, total: list.length, opened, inInbox: list.filter((m) => o.roleOf(m.folder?.id) === "inbox").length, latest: list[0], subjects });
  }
  return out.sort((a, b) => (b.total - b.opened) - (a.total - a.opened) || b.total - a.total || a.address.localeCompare(b.address));
}

export interface Unsubscribe {
  /** RFC 8058: one POST, nothing else to do. */
  oneClick?: string;
  /** A page to finish on. */
  web?: string;
  /** An email to send. */
  mailto?: { to: string; subject: string; body: string };
}

/** What the List-Unsubscribe headers offer, or null when nothing usable. */
export function parseUnsubscribe(listUnsubscribe: string | undefined, listUnsubscribePost?: string): Unsubscribe | null {
  if (!listUnsubscribe) return null;
  const entries = [...listUnsubscribe.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  if (!entries.length) entries.push(...listUnsubscribe.split(",").map((s) => s.trim()).filter(Boolean));
  const out: Unsubscribe = {};
  for (const entry of entries) {
    const value = entry.replace(/\s+/g, "");
    // https only (loopback http: the live test's local list server).
    if ((/^https:\/\//i.test(value) || /^http:\/\/(?:127\.0\.0\.1|localhost)[:/]/i.test(value)) && !out.web) { try { out.web = new URL(value).href; } catch { /* not an address */ } }
    else if (/^mailto:/i.test(value) && !out.mailto) {
      const [to, query = ""] = value.slice(7).split("?");
      const params = new URLSearchParams(query);
      const address = decodeURIComponent(to);
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) out.mailto = { to: address, subject: params.get("subject") || "Unsubscribe", body: params.get("body") || "Please unsubscribe me." };
    }
  }
  if (out.web && /List-Unsubscribe\s*=\s*One-Click/i.test(listUnsubscribePost || "")) out.oneClick = out.web;
  return out.web || out.mailto ? out : null;
}

/** Whether a sender is bulk mail (a list, newsletter or notification), from its newest email. */
export function isBulk(headers: Record<string, string[] | string | undefined> | undefined, category: string): boolean {
  const has = (name: string) => { const v = headers?.[name]; return Array.isArray(v) ? v.length > 0 : !!v; };
  const precedence = String((headers?.precedence as any)?.[0] ?? headers?.precedence ?? "").toLowerCase();
  return has("list-unsubscribe") || has("list-id") || /bulk|list/.test(precedence) || category === "newsletter" || category === "notification";
}
