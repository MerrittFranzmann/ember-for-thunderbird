// Which shared-file service a link points at (Google Drive, OneDrive, SharePoint, Dropbox). Pure, with no
// page imports: the composer's link check (shared-links.ts) and the background's link index both use it.
import type { SharedLink } from "./shared-links";

const GOOGLE_KINDS: Record<string, string> = { document: "Google Doc", spreadsheets: "Google Sheet", presentation: "Google Slides deck", forms: "Google Form", drawings: "Google Drawing" };
const OFFICE_KINDS: Record<string, string> = { w: "Word file", x: "Excel file", p: "PowerPoint file", b: "PDF", f: "folder", o: "OneNote notebook", v: "video", i: "image", u: "file", t: "file" };

/** The service and kind of file a link points at, or null for any other link. */
export function sharedLinkKind(url: string): Omit<SharedLink, "url" | "label"> & { kind: string } | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase(), path = parsed.pathname;
  if (host === "docs.google.com") {
    const kind = /^\/(document|spreadsheets|presentation|forms|drawings)\/d\//.exec(path)?.[1];
    return kind ? { service: "Google Drive", kind: GOOGLE_KINDS[kind] } : /^\/file\/d\//.test(path) ? { service: "Google Drive", kind: "Drive file" } : null;
  }
  if (host === "drive.google.com") {
    if (/^\/(?:drive\/(?:u\/\d+\/)?folders)\//.test(path)) return { service: "Google Drive", kind: "Drive folder" };
    return /^\/(?:file\/d\/|open$)/.test(path) ? { service: "Google Drive", kind: "Drive file" } : null;
  }
  const tenant = /^([a-z0-9-]+?)(?:-my)?\.sharepoint\.com$/.exec(host)?.[1];
  if (tenant) {
    const kind = /^\/:([a-z]):\//.exec(path)?.[1];
    if (kind) return { service: "SharePoint", tenant, kind: OFFICE_KINDS[kind] || "file" };
    return /^\/(?:sites|teams|personal)\/[^/]+\/.+/.test(path) || /\/_layouts\/15\/(?:Doc|WopiFrame|guestaccess)\.aspx$/i.test(path) ? { service: "SharePoint", tenant, kind: "file" } : null;
  }
  if (host === "1drv.ms" && path.length > 3) return { service: "OneDrive", kind: "OneDrive file" };
  if (host === "onedrive.live.com" && /resid=|\/redir|\/edit|\/view/i.test(parsed.search + path)) return { service: "OneDrive", kind: "OneDrive file" };
  if ((host === "www.dropbox.com" || host === "dropbox.com") && /^\/(?:s|scl\/f[io]|sh)\//.test(path)) return { service: "Dropbox", kind: "Dropbox file" };
  return null;
}

