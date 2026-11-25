// The composer's link check: links in an email that point at shared files (Google Drive, OneDrive,
// SharePoint, Dropbox). Whether each opens without signing in is asked by the sparkLinks Experiment;
// send-checks.ts decides which recipients that leaves out. Pure apart from accessOf(); unit-tested.
import { api } from "./api";
import { sharedLinkKind } from "./link-kinds";
export { sharedLinkKind };

export type LinkAccess = "public" | "signin" | "missing" | "unknown";
export type LinkService = "Google Drive" | "OneDrive" | "SharePoint" | "Dropbox";
export interface SharedLink {
  url: string;
  /** What the email calls it ("the Q3 plan"), else what it is ("a Google Doc"). */
  label: string;
  service: LinkService;
  /** SharePoint: the organization's tenant name (northwind.sharepoint.com → "northwind"). */
  tenant?: string;
}

/** Outlook's "safe links" wrap the real address. */
function unwrap(url: string): string {
  if (/^https:\/\/[\w.-]*safelinks\.protection\.outlook\.com\//i.test(url)) {
    try { return new URL(url).searchParams.get("url") || url; } catch { /* keep it */ }
  }
  return url;
}
const decode = (text: string) => text.replace(/&nbsp;/g, " ").replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e as "amp"]);

/** Shared-file links in the email's own HTML (links and pasted addresses), each once. */
export function sharedLinks(html: string): SharedLink[] {
  const found = new Map<string, SharedLink>();
  const add = (raw: string, text = "") => {
    const url = unwrap(decode(raw).trim().replace(/[)\].,;:!?]+$/, ""));
    const kind = sharedLinkKind(url);
    if (!kind || found.has(url)) return;
    const name = text.replace(/\s+/g, " ").trim();
    // Link text that is just an address says nothing about the file.
    const label = name && !/^(?:https?:\/\/|www\.)/i.test(name) && name.length <= 80 ? `“${name}”` : `a ${kind.kind}`;
    const { kind: _, ...rest } = kind;
    found.set(url, { url, label, ...rest });
  };
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi)) {
    add(match[1] ?? match[2] ?? "", decode(match[3].replace(/<[^>]+>/g, "")));
  }
  // Addresses typed or pasted as text (not inside a link).
  const text = decode(html.replace(/<a\b[\s\S]*?<\/a>/gi, " ").replace(/<[^>]+>/g, " "));
  for (const match of text.matchAll(/https:\/\/[^\s<>"']+/gi)) add(match[0]);
  return [...found.values()];
}

const answers = new Map<string, { at: number; value: Promise<LinkAccess> }>();
/** Whether a link opens without signing in; asked once per link every ten minutes (a minute when unsure). */
export function accessOf(url: string): Promise<LinkAccess> {
  const cached = answers.get(url);
  if (cached && Date.now() - cached.at < 10 * 60000) return cached.value;
  if (typeof api?.sparkLinks?.access !== "function") return Promise.resolve("unknown");
  const value: Promise<LinkAccess> = Promise.resolve(api.sparkLinks.access(url)).then((answer: any) => {
    const status = answer?.status as LinkAccess;
    if (status === "unknown") setTimeout(() => { if (answers.get(url)?.value === value) answers.delete(url); }, 60000);
    return ["public", "signin", "missing"].includes(status) ? status : "unknown";
  }, () => "unknown" as LinkAccess);
  answers.set(url, { at: Date.now(), value });
  return value;
}
