// Right-clicks in Ember. Thunderbird's own menu (Back, Reload, Select All, Inspect…) appeared wherever Ember had no
// menu of its own (2026-11-14). Now: Ember's menus where it has them (conversation rows, mailboxes, email bodies),
// nothing on the rest of its interface, and the standard text menu only where you type (spelling, cut, copy, paste).
// Pure parts unit-tested in test/context-menu.test.ts; ContextMenu.svelte draws a menu, HtmlFrame.svelte the email's.

interface Node_ { closest?: (selector: string) => any; nodeType?: number; parentElement?: any }

const EDITABLE = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=range]), textarea, select, [contenteditable=""], [contenteditable="true"]';

/** Where the standard text menu stays: fields you type in (spelling suggestions, cut, copy, paste). */
export function allowsNativeMenu(target: Node_ | null | undefined): boolean {
  const el = target && target.nodeType === 3 ? target.parentElement : target; // a text node: its element
  return !!el?.closest?.(EDITABLE);
}

/** No Thunderbird menu on Ember's own interface: a page's right-click that no Ember menu took is dropped. */
export function installNativeMenuGuard(target: { addEventListener: (type: string, fn: (e: any) => void) => void }) {
  // Bubbling, so it runs after Ember's own menus (which call preventDefault themselves).
  target.addEventListener("contextmenu", (e: any) => {
    if (!e.defaultPrevented && !allowsNativeMenu(e.target)) e.preventDefault();
  });
}

export type BodyAction = "copy" | "search" | "open-link" | "copy-link" | "write-to" | "copy-address" | "copy-image" | "save-image";
export interface BodyItem { action: BodyAction; label: string; icon: string }

/** What a right-click in an email offers: for selected text, a link (web or email address) and an image. */
export function bodyMenuItems(info: { selection?: string; href?: string; image?: string }): BodyItem[] {
  const items: BodyItem[] = [];
  const text = (info.selection || "").replace(/\s+/g, " ").trim();
  if (text) {
    items.push({ action: "copy", label: "Copy", icon: "copy" });
    const short = text.length > 28 ? `${text.slice(0, 26)}…` : text;
    items.push({ action: "search", label: `Search mail for “${short}”`, icon: "search" });
  }
  const href = info.href || "";
  const mail = mailtoAddress(href);
  if (mail) {
    items.push({ action: "write-to", label: `Write to ${mail}`, icon: "compose" });
    items.push({ action: "copy-address", label: "Copy email address", icon: "copy" });
  } else if (/^https?:/i.test(href)) {
    items.push({ action: "open-link", label: "Open link", icon: "open" });
    items.push({ action: "copy-link", label: "Copy link", icon: "link" });
  }
  if (info.image) {
    items.push({ action: "copy-image", label: "Copy image", icon: "image" });
    items.push({ action: "save-image", label: "Save image…", icon: "download" });
  }
  return items;
}

/** The address of a mailto: link ("" otherwise). */
export function mailtoAddress(href: string): string {
  const m = /^mailto:([^?]+)/i.exec(href || "");
  if (!m) return "";
  try { return decodeURIComponent(m[1]).trim(); } catch { return m[1].trim(); }
}

/** A file name for a saved image: its own name when the address has one. */
export function imageFileName(src: string, fallback = "image"): string {
  try {
    const url = new URL(src);
    if (url.protocol === "http:" || url.protocol === "https:") {
      const last = decodeURIComponent(url.pathname.split("/").pop() || "");
      if (/\.[a-z0-9]{2,5}$/i.test(last)) return last.replace(/[/\\:*?"<>|]/g, "_");
    }
  } catch { /* not a URL */ }
  return `${fallback}.png`;
}

export type PersonAction = "write-to" | "copy-address" | "copy-contact" | "show-mail";
export interface PersonItem { action: PersonAction; label: string; icon: string }

/** Right-clicking a sender or recipient in an email: write, copy, or see your mail with them (yourself: copy only). */
export function personMenuItems(who: { name?: string; email: string; isMe?: boolean }): PersonItem[] {
  const email = (who.email || "").trim();
  if (!email) return [];
  const items: PersonItem[] = [{ action: "copy-address", label: "Copy email address", icon: "copy" }];
  const name = (who.name || "").trim();
  if (name && name.toLowerCase() !== email.toLowerCase()) items.push({ action: "copy-contact", label: "Copy name and address", icon: "copy" });
  if (who.isMe) return items;
  const short = firstName(name) || email;
  return [
    { action: "write-to", label: `Write to ${short}`, icon: "compose" },
    ...items,
    { action: "show-mail", label: `Show mail with ${short}`, icon: "search" },
  ];
}

/** "Ana" for "Ana Lima" and "Lima, Ana"; "" for a name that is an address. */
export function firstName(name: string): string {
  const n = (name || "").replace(/["']/g, "").trim();
  if (!n || n.includes("@")) return "";
  const comma = n.split(",");
  return (comma.length === 2 ? comma[1] : n).trim().split(/\s+/)[0] || "";
}

/** "Ana Lima <ana@example.org>", quoting a name with commas or other specials. */
export function contactLine(name: string, email: string): string {
  const n = (name || "").trim();
  if (!n || n.toLowerCase() === email.toLowerCase()) return email;
  return /[",<>@;:()\[\]]/.test(n) ? `"${n.replace(/"/g, "'")}" <${email}>` : `${n} <${email}>`;
}

export type FileAction = "preview" | "open" | "save" | "save-all" | "copy-name" | "show-email";
export interface FileItem { action: FileAction; label: string; icon: string }

/** Right-clicking an attachment: in an email (others beside it: Save all) or in the Attachments view (Show the email). */
export function attachmentMenuItems(file: { canPreview?: boolean; others?: number; inLibrary?: boolean }): FileItem[] {
  const items: FileItem[] = [];
  if (file.canPreview) items.push({ action: "preview", label: "Quick Look", icon: "search" });
  items.push({ action: "open", label: "Open", icon: "open" }, { action: "save", label: "Save…", icon: "download" });
  if (!file.inLibrary && (file.others || 0) > 0) items.push({ action: "save-all", label: `Save all ${(file.others || 0) + 1} to Downloads`, icon: "download" });
  items.push({ action: "copy-name", label: "Copy file name", icon: "copy" });
  if (file.inLibrary) items.push({ action: "show-email", label: "Show the email", icon: "mail" });
  return items;
}
