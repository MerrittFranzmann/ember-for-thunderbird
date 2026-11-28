// "Before you send": what in an email's recipients and links is easy to regret. New outside domains
// (and likely typos), people added to a conversation they weren't in, big reply-alls and group
// addresses, and shared files some recipients can't open. Pure; unit-tested.
import type { Addr } from "./format";
import type { LinkAccess, SharedLink } from "./shared-links";

export interface SendWarning {
  key: string;
  kind: "typo" | "newDomain" | "notInThread" | "crowd" | "group" | "linkAccess" | "linkMissing" | "attachMissing" | "attachKind" | "olderVersion";
  text: string;
  detail?: string;
  /** remove/replace: a recipient; attach: pick a file; swap: use the conversation's newer file instead. */
  fix?: { label: string; remove?: string; replace?: { email: string; with: string }; attach?: boolean; swap?: { name: string; messageId: number; partName: string; with: string } };
}

/** Free mail services: an address there says nothing about an organization. */
export const WEBMAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "zoho.com", "fastmail.com", "hey.com", "comcast.net", "att.net", "verizon.net", "sbcglobal.net", "bellsouth.net"]);

export interface Correspondence {
  addresses: Set<string>;
  /** Each domain and how many saved emails involve it. */
  domains: Map<string, number>;
}

const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();
const lower = (email: string) => email.trim().toLowerCase();

/** Everyone the user has had email from or sent email to, from saved headers. */
export function correspondence(headers: { author: string; recipients?: string[]; ccList?: string[]; bccList?: string[] }[], emailOf: (s: string) => string): Correspondence {
  const addresses = new Set<string>(), domains = new Map<string, number>();
  for (const header of headers) {
    const seen = new Set<string>();
    for (const raw of [header.author, ...(header.recipients || []), ...(header.ccList || []), ...(header.bccList || [])]) {
      const email = emailOf(raw);
      if (!email.includes("@")) continue;
      addresses.add(email);
      const domain = domainOf(email);
      if (!seen.has(domain)) { seen.add(domain); domains.set(domain, (domains.get(domain) || 0) + 1); }
    }
  }
  return { addresses, domains };
}

/** Edit distance (adjacent swaps count once), stopping early above `limit`. */
export function editDistance(a: string, b: string, limit = 2): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, j) => j)];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1][j] + 1, row[j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, rows[i - 2][j - 2] + 1);
      row.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    rows.push(row);
  }
  return rows[a.length][b.length];
}

/** A well-known domain this one is probably a typo of ("gmial.com" → "gmail.com"). */
export function likelyDomain(domain: string, known: Map<string, number>): string | null {
  // A domain in use, or a well-known mail service ("gmail.com" isn't a typo of "ymail.com").
  if ((known.get(domain) || 0) > 0 || WEBMAIL.has(domain)) return null;
  let best: { domain: string; distance: number; count: number } | null = null;
  const candidates = new Map(known);
  for (const webmail of WEBMAIL) candidates.set(webmail, Math.max(candidates.get(webmail) || 0, 3));
  for (const [candidate, count] of candidates) {
    if (count < 2 || candidate === domain) continue;
    const allowed = domain.length >= 10 ? 2 : 1;
    const distance = editDistance(domain, candidate, allowed);
    if (distance > allowed) continue;
    if (!best || distance < best.distance || (distance === best.distance && count > best.count)) best = { domain: candidate, distance, count };
  }
  return best?.domain ?? null;
}

const GROUP = /^(?:all|everyone|everybody|staff|allstaff|all[-_.]staff|all[-_.]employees|employees|company|global|all[-_.]hands|allhands)$/i;
const nameOf = (addr: Addr) => addr.name?.trim() || addr.email;
/** "Ada", "Ada and Grace", "Ada, Grace and 3 others". */
export function people(names: string[]): string {
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}

/** Whether a recipient's address belongs to the organization that owns a shared file. */
function insideOwner(email: string, link: SharedLink, from: string): boolean {
  const domain = domainOf(email);
  if (link.service === "SharePoint" && link.tenant) return domain.split(".").includes(link.tenant.toLowerCase());
  // Google Drive, OneDrive, Dropbox: the file is presumably the sender's. Personal accounts have no organization.
  const own = domainOf(from);
  if (!own || WEBMAIL.has(own)) return false;
  return domain === own || domain.endsWith(`.${own}`);
}

export interface CheckInput {
  mode: "new" | "reply" | "replyAll" | "forward" | "draft";
  /** The sending address. */
  from: string;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  /** The user's own addresses. */
  me: Set<string>;
  known: Correspondence;
  /** Everyone in the conversation being answered (replies only). */
  thread?: string[];
  links?: { link: SharedLink; access: LinkAccess }[];
}

export function sendWarnings(input: CheckInput): SendWarning[] {
  const warnings: SendWarning[] = [];
  const me = new Set([...input.me].map(lower));
  const seen = new Set<string>();
  const recipients = [...input.to, ...input.cc, ...input.bcc].filter((addr) => {
    const email = lower(addr.email);
    if (!email.includes("@") || me.has(email) || seen.has(email)) return false;
    seen.add(email);
    return true;
  });
  const ownDomains = new Set([...me, lower(input.from)].filter((email) => email.includes("@")).map(domainOf));
  // The user's organization includes its subdomains (eu.acme.com for acme.com), but not other people at webmail.
  const own = (domain: string) => ownDomains.has(domain) || [...ownDomains].some((d) => !WEBMAIL.has(d) && domain.endsWith(`.${d}`));

  // Typos first: a mistyped domain is also "new", and the fix is different.
  const typos = new Set<string>();
  for (const addr of recipients) {
    const email = lower(addr.email), domain = domainOf(email);
    if (own(domain) || input.known.addresses.has(email)) continue;
    const suggestion = likelyDomain(domain, input.known.domains);
    if (!suggestion) continue;
    typos.add(email);
    const fixed = `${email.slice(0, email.lastIndexOf("@"))}@${suggestion}`;
    warnings.push({ key: `typo:${email}`, kind: "typo", text: `${email}: did you mean ${suggestion}?`, detail: `You've never emailed anyone at ${domain}.`, fix: { label: `Use ${suggestion}`, replace: { email, with: fixed } } });
  }

  // Domains nobody in the user's mail has ever used (free mail services say nothing, so they're left out).
  const fresh = new Map<string, Addr[]>();
  for (const addr of recipients) {
    const email = lower(addr.email), domain = domainOf(email);
    if (typos.has(email) || own(domain) || WEBMAIL.has(domain) || (input.known.domains.get(domain) || 0) > 0) continue;
    fresh.set(domain, [...(fresh.get(domain) || []), addr]);
  }
  for (const [domain, addrs] of fresh) {
    warnings.push({ key: `new:${domain}`, kind: "newDomain", text: `First email to anyone at ${domain}`, detail: `${people(addrs.map(nameOf))} ${addrs.length === 1 ? "isn't" : "aren't"} in any email you've sent or received.`, ...(addrs.length === 1 ? { fix: { label: "Remove", remove: lower(addrs[0].email) } } : {}) });
  }

  // Replies: people who weren't in the conversation (the classic wrong-person reply).
  if ((input.mode === "reply" || input.mode === "replyAll") && input.thread?.length) {
    const thread = new Set(input.thread.map(lower));
    const threadDomains = new Set([...thread].filter((email) => !me.has(email)).map(domainOf));
    const internal = threadDomains.size > 0 && [...threadDomains].every((domain) => own(domain)) && ![...ownDomains].every((domain) => WEBMAIL.has(domain));
    const added = recipients.filter((addr) => !thread.has(lower(addr.email)));
    for (const addr of added.slice(0, 4)) {
      const email = lower(addr.email);
      const outside = internal && !own(domainOf(email));
      warnings.push({ key: `added:${email}`, kind: "notInThread", text: `${nameOf(addr)} wasn't in this conversation`, detail: outside ? `Everyone else in it is at ${domainOf(input.from) || [...ownDomains][0]}; ${email} is outside it.` : email !== nameOf(addr).toLowerCase() ? email : undefined, fix: { label: "Remove", remove: email } });
    }
    if (added.length > 4) warnings.push({ key: "added:more", kind: "notInThread", text: `${added.length - 4} more people weren't in this conversation` });
  }

  // How far it goes.
  const visible = recipients.filter((addr) => !input.bcc.some((b) => lower(b.email) === lower(addr.email)));
  if (input.mode === "replyAll" && recipients.length >= 8) warnings.push({ key: "crowd", kind: "crowd", text: `Reply all goes to ${recipients.length} people`, detail: visible.length < recipients.length ? undefined : "Everyone in To and Cc gets your reply." });
  else if (recipients.length >= 20) warnings.push({ key: "crowd", kind: "crowd", text: `This goes to ${recipients.length} people`, detail: visible.length >= 20 ? "They can all see each other's addresses. Bcc keeps them private." : undefined });
  for (const addr of recipients) {
    const email = lower(addr.email);
    if (GROUP.test(email.slice(0, email.lastIndexOf("@")))) warnings.push({ key: `group:${email}`, kind: "group", text: `${email} is a group address`, detail: "Everyone on that list gets this email." });
  }

  // Shared files.
  for (const { link, access } of input.links || []) {
    if (access === "missing") {
      warnings.push({ key: `link:${link.url}`, kind: "linkMissing", text: `${capital(link.label)} doesn't open`, detail: `${link.service} says there's no such file. The link may be cut short, or the file was moved or deleted.` });
    } else if (access === "signin" && recipients.length) {
      const outside = recipients.filter((addr) => !insideOwner(lower(addr.email), link, input.from));
      if (!outside.length) continue;
      const org = link.service === "SharePoint" ? `${link.tenant}'s SharePoint` : link.service;
      warnings.push({ key: `link:${link.url}`, kind: "linkAccess", text: `${capital(link.label)} needs a sign-in`, detail: `${people(outside.map(nameOf))} can open it only if it's shared with ${outside.length === 1 ? "them" : "each of them"} on ${org}. Anyone with the link can't.` });
    }
  }
  return warnings;
}

const capital = (text: string) => text.replace(/^(“?)(\p{Ll})/u, (_, quote, letter) => quote + letter.toUpperCase());

/** The same warnings as last time (so "Send anyway" isn't asked again for them). */
export function warningSignature(warnings: SendWarning[]): string {
  return warnings.map((warning) => warning.key).sort().join("|");
}
