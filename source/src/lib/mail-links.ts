// Links that open an email in Ember (2026-11-16): http://127.0.0.1:47391/email/<code>. An AI agent hands them out
// with every email it mentions (MCP: agent-bridge.ts), and right-click → Copy link makes one; clicking it anywhere
// on this Mac (a chat, a note, the terminal) opens that email in Ember. Thunderbird answers on the loopback address
// only (the sparkMailLinks Experiment); the background finds the email (mail-link-service.ts).
// The code is a hash of the email's Message-ID: short enough to copy whole, stable across folders and moves, and it
// says nothing about the email. Codes handed out are also kept (storage `mailLinks`) so links to emails Ember
// doesn't save (older than its 90 days) still open. Pure; unit-tested in test/mail-links.test.ts.

/** Thunderbird listens here (the test-only pref extensions.spark.mailLinkPort moves it). */
export const MAIL_LINK_PORT = 47391;
export const MAIL_LINK_CODE = /^[0-9a-z]{11}$/;
/** Codes kept for emails Ember may not have saved (newest kept). */
const MAX_KEPT = 3000;

/** The email's Message-ID as Ember keys it (no angle brackets). */
const keyOf = (messageId: string) => String(messageId || "").trim().replace(/^<|>$/g, "");

/** An 11-character code for a Message-ID (53-bit cyrb53 hash, base 36). */
export function linkCode(messageId: string): string {
  const s = keyOf(messageId);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36).padStart(11, "0");
}

/** The link to an email, from the address Thunderbird listens on ("http://127.0.0.1:47391"). */
export const mailLink = (base: string, messageId: string) => `${base.replace(/\/+$/, "")}/email/${linkCode(messageId)}`;

/** Kept codes: code → [Message-ID, when handed out]. */
export type KeptLinks = Record<string, [string, number]>;

/** A stored value as kept codes (damaged entries dropped). */
export function readKept(value: any): KeptLinks {
  const out: KeptLinks = {};
  if (value && typeof value === "object") for (const [code, entry] of Object.entries(value)) {
    if (MAIL_LINK_CODE.test(code) && Array.isArray(entry) && typeof entry[0] === "string" && entry[0]) out[code] = [entry[0], Number(entry[1]) || 0];
  }
  return out;
}

/** Keeps these emails' codes; null when nothing new (no storage write needed). Oldest go past MAX_KEPT. */
export function keepLinks(kept: KeptLinks, messageIds: string[], now = Date.now()): KeptLinks | null {
  const next = { ...kept };
  let changed = false;
  for (const id of messageIds) {
    const key = keyOf(id);
    if (!key) continue;
    const code = linkCode(key);
    if (next[code]?.[0] === key) continue;
    next[code] = [key, now];
    changed = true;
  }
  if (!changed) return null;
  const codes = Object.keys(next);
  if (codes.length > MAX_KEPT) for (const code of codes.sort((a, b) => next[a][1] - next[b][1]).slice(0, codes.length - MAX_KEPT)) delete next[code];
  return next;
}

/** Of several copies of one email (Inbox, Archive, a label…), the one to show: Inbox first, Trash and Spam last. */
export function bestCopy<T extends { junk?: boolean; folder?: { specialUse?: string[] } }>(copies: T[]): T | null {
  const rank = (m: T) => { const use = m.folder?.specialUse || []; return use.includes("trash") ? 3 : use.includes("junk") || m.junk ? 2 : use.includes("inbox") ? 0 : 1; };
  return [...copies].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}
