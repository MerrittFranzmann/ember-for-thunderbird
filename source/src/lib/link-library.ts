// Links in Attachments: shared files and review links (Dropbox, Google Drive, Frame.io, Vimeo …) found in
// received mail. The cache owner extracts each saved email's links once (messageLinks) and keeps them in
// its "links" store; the page dedupes them (libraryLinks) and filters them like files. Pure; unit-tested
// (test/link-library.test.ts). No DOM: this also runs in the background.
import { extractBodies, splitQuotedText } from "./body";
import { sharedLinkKind } from "./link-kinds";
import { displayName, emailOf } from "./format";
import type { MessageHeader, MessagePart } from "./types";

export const LINK_SERVICES = ["Dropbox", "Google Drive", "OneDrive", "SharePoint", "Box", "WeTransfer", "iCloud", "Google Photos", "Frame.io", "Vimeo", "YouTube", "Loom", "Figma", "Canva", "Adobe", "Notion"] as const;
export type LinkService = typeof LINK_SERVICES[number];

/** A link as saved per email: the address, what it is, and the email's own words for it. */
export interface FoundLink { url: string; service: LinkService; kind: string; text?: string }

/** The service and kind of thing a link points at, or null for any other link. */
export function linkKind(url: string): { service: LinkService; kind: string } | null {
  const shared = sharedLinkKind(url);
  if (shared) {
    if (shared.service === "Dropbox" && /\/t\//.test(url)) return { service: "Dropbox", kind: "Dropbox transfer" };
    return { service: shared.service, kind: shared.kind };
  }
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, ""), path = u.pathname;
  const deep = path.replace(/\/+$/, "").length > 1;
  if (host === "dropbox.com" && /^\/t\/[\w-]+/.test(path)) return { service: "Dropbox", kind: "Dropbox transfer" };
  if (host === "f.io" && deep) return { service: "Frame.io", kind: "Frame.io review" };
  if (/^(?:app|next)\.frame\.io$/.test(host) && /^\/(?:reviews|presentations|player|share|f|project|projects)\//.test(path)) return { service: "Frame.io", kind: "Frame.io review" };
  if (host === "vimeo.com" && (/^\/\d{5,}(?:\/[\w]+)?$/.test(path) || /^\/(?:user\d+|[\w-]+)\/review\/\d+/.test(path) || /^\/manage\/videos\/\d+/.test(path) || /^\/showcase\/\d+/.test(path))) return { service: "Vimeo", kind: "Vimeo video" };
  if (host === "player.vimeo.com" && /^\/video\/\d+/.test(path)) return { service: "Vimeo", kind: "Vimeo video" };
  if (/^(?:m\.)?youtube\.com$/.test(host) && ((path === "/watch" && u.searchParams.get("v")) || /^\/(?:shorts|live)\/[\w-]{6,}/.test(path))) return { service: "YouTube", kind: "YouTube video" };
  if (/^(?:m\.)?youtube\.com$/.test(host) && path === "/playlist" && u.searchParams.get("list")) return { service: "YouTube", kind: "YouTube playlist" };
  if (host === "youtu.be" && /^\/[\w-]{6,}/.test(path)) return { service: "YouTube", kind: "YouTube video" };
  if (host === "we.tl" && deep) return { service: "WeTransfer", kind: "WeTransfer files" };
  if (/(?:^|\.)wetransfer\.com$/.test(host) && /^\/downloads\//.test(path)) return { service: "WeTransfer", kind: "WeTransfer files" };
  if (/(?:^|\.)box\.com$/.test(host) && /^\/(?:s|file|folder)\/[\w-]+/.test(path)) return { service: "Box", kind: /^\/folder\//.test(path) ? "Box folder" : "Box file" };
  if (host === "figma.com" && /^\/(?:file|design|proto|board|deck|slides)\/[\w-]+/.test(path)) return { service: "Figma", kind: /^\/proto\//.test(path) ? "Figma prototype" : "Figma file" };
  if (host === "canva.com" && /^\/design\/[\w-]+/.test(path)) return { service: "Canva", kind: "Canva design" };
  if (host === "loom.com" && /^\/(?:share|embed)\/[\w-]+/.test(path)) return { service: "Loom", kind: "Loom video" };
  if (host === "icloud.com" && /^\/(?:iclouddrive|photos|keynote|pages|numbers|attachment)\b/.test(path) && (deep || u.hash.length > 2)) return { service: "iCloud", kind: "iCloud file" };
  if (host === "share.icloud.com" && deep) return { service: "iCloud", kind: "iCloud photos" };
  if ((host === "photos.app.goo.gl" && deep) || (host === "photos.google.com" && /^\/(?:share|album)\//.test(path))) return { service: "Google Photos", kind: "Google Photos album" };
  if ((host === "acrobat.adobe.com" && /^\/(?:id|link)\//.test(path)) || (host === "adobe.ly" && deep) || (host === "documentcloud.adobe.com" && /^\/link\//.test(path))) return { service: "Adobe", kind: "Adobe document" };
  if ((host === "notion.so" || /\.notion\.site$/.test(host)) && /[0-9a-f]{32}/i.test(path)) return { service: "Notion", kind: "Notion page" };
  return null;
}

/** Outlook's safe links and Google's redirects wrap the real address. */
function unwrap(url: string): string {
  try {
    const u = new URL(url);
    if (/(?:^|\.)safelinks\.protection\.outlook\.com$/i.test(u.hostname)) return u.searchParams.get("url") || url;
    if (/^(?:www\.)?google\.com$/i.test(u.hostname) && u.pathname === "/url") return u.searchParams.get("q") || u.searchParams.get("url") || url;
  } catch { /* keep it */ }
  return url;
}
const decode = (text: string) => text.replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" })[e as "amp"]);
/** Link words that say nothing about what it is. */
const VAGUE = /^(?:here|click here|this|this link|link|the link|open|view|view (?:it|file|files|video|folder|online)|download|download (?:it|here|files?)|watch|watch (?:it|here|now)|see here|review|share|shared|https?:\/\/.*|www\..*)$/i;

/** The email's own part, without the quoted history below it (whose links belong to earlier emails). */
function ownPart(full: MessagePart): { html?: string; text?: string } {
  const bodies = extractBodies(full);
  if (bodies.html !== undefined) {
    const at = bodies.html.search(/<(?:div|blockquote|span)\b[^>]*(?:class\s*=\s*["'][^"']*\b(?:gmail_quote|yahoo_quoted|moz-cite-prefix)\b|type\s*=\s*["']cite["']|id\s*=\s*["']divRplyFwdMsg["'])/i);
    return { html: at > 0 ? bodies.html.slice(0, at) : bodies.html };
  }
  return bodies.text !== undefined ? { text: splitQuotedText(bodies.text).text } : {};
}

/** Shared-file and review links in an email (its own part), each once, in order. */
export function messageLinks(full: MessagePart | undefined, max = 40): FoundLink[] {
  if (!full) return [];
  const found = new Map<string, FoundLink>();
  const add = (raw: string, words = "") => {
    if (found.size >= max) return;
    const url = unwrap(decode(raw).trim().replace(/[)\].,;:!?'"]+$/, ""));
    const kind = linkKind(url);
    if (!kind) return;
    const text = words.replace(/\s+/g, " ").trim();
    const link = found.get(url);
    if (link) { if (!link.text && text && !VAGUE.test(text) && text.length <= 120) link.text = text; return; }
    found.set(url, { url, ...kind, ...(text && !VAGUE.test(text) && text.length <= 120 ? { text } : {}) });
  };
  const own = ownPart(full);
  if (own.html !== undefined) {
    for (const m of own.html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)) add(m[1] ?? m[2] ?? "", decode(m[3].replace(/<[^>]+>/g, "")));
    const rest = decode(own.html.replace(/<a\b[\s\S]*?<\/a>/gi, " ").replace(/<(?:style|script)\b[\s\S]*?<\/(?:style|script)>/gi, " ").replace(/<[^>]+>/g, " "));
    for (const m of rest.matchAll(/https:\/\/[^\s<>"']+/gi)) add(m[0]);
  } else if (own.text !== undefined) {
    for (const m of own.text.matchAll(/https:\/\/[^\s<>"'\]]+/gi)) add(m[0]);
  }
  return [...found.values()];
}

/** A name for a link: the email's words for it, else the file name in the address, else what it is. */
export function linkTitle(link: FoundLink): string {
  if (link.text) return link.text;
  try {
    const u = new URL(link.url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
    if ((link.service === "Dropbox" || link.service === "Box") && /\.[a-z0-9]{2,5}$/i.test(last)) return last;
    if (link.service === "Figma") { const name = decodeURIComponent(u.pathname.split("/")[3] || "").replace(/-/g, " ").trim(); if (name) return name; }
  } catch { /* fall through */ }
  return link.kind;
}

export interface ReceivedLink {
  key: string;
  link: FoundLink;
  title: string;
  /** The email that first shared it (received mail only), and how many emails mention it. */
  message: MessageHeader;
  mentions: number;
  lastDate: Date;
  domain: string;
}

/** Each link once, credited to the first received email with it; newest shares first. */
export function libraryLinks(records: { message: MessageHeader; links: FoundLink[] }[], domainOf: (author: string) => string): ReceivedLink[] {
  const byUrl = new Map<string, ReceivedLink>();
  const sorted = [...records].sort((a, b) => +new Date(a.message.date) - +new Date(b.message.date));
  for (const { message, links } of sorted) {
    for (const link of links) {
      const existing = byUrl.get(link.url);
      if (existing) {
        existing.mentions++;
        existing.lastDate = new Date(message.date);
        if (!existing.link.text && link.text) { existing.link = { ...existing.link, text: link.text }; existing.title = linkTitle(existing.link); }
        continue;
      }
      byUrl.set(link.url, { key: `${message.id}:${link.url}`, link, title: linkTitle(link), message, mentions: 1, lastDate: new Date(message.date), domain: domainOf(message.author) });
    }
  }
  return [...byUrl.values()].sort((a, b) => +new Date(b.message.date) - +new Date(a.message.date));
}

export type LinkGrouping = "none" | "sender" | "conversation" | "service";

export function filterLinks(items: ReceivedLink[], options: { approvedOnly: boolean; domains: string[]; query: string; service: LinkService | "all" }): ReceivedLink[] {
  const allowed = new Set(options.domains);
  const q = options.query.trim().toLowerCase();
  return items.filter((item) => {
    if (options.approvedOnly && !allowed.has(item.domain)) return false;
    if (options.service !== "all" && item.link.service !== options.service) return false;
    return !q || [item.title, item.link.url, item.link.service, item.message.author, item.message.subject, item.domain].some((v) => (v || "").toLowerCase().includes(q));
  });
}

export function groupLinks(items: ReceivedLink[], grouping: LinkGrouping, conversation: (message: MessageHeader) => { key: string; label: string }): { key: string; label?: string; links: ReceivedLink[] }[] {
  if (grouping === "none") return [{ key: "all", links: items }];
  const groups = new Map<string, { key: string; label?: string; links: ReceivedLink[] }>();
  for (const item of items) {
    const sender = emailOf(item.message.author).toLowerCase();
    const source = grouping === "service" ? { key: item.link.service, label: item.link.service }
      : grouping === "sender" ? { key: sender || item.message.author, label: `${displayName(item.message.author)}${sender ? ` · ${sender}` : ""}` }
      : conversation(item.message);
    if (!groups.has(source.key)) groups.set(source.key, { ...source, links: [] });
    groups.get(source.key)!.links.push(item);
  }
  return [...groups.values()].sort((a, b) => grouping === "conversation" ? +new Date(b.links[0].message.date) - +new Date(a.links[0].message.date) : a.label!.localeCompare(b.label!));
}
