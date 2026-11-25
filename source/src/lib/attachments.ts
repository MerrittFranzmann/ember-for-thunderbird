import { fileKind, type FileKind } from "./attachment-library";
import type { MailFolder, MessageAttachment, MessageHeader } from "./types";
import { RequestTimeout, withDeadline } from "./async";
import { emailOf } from "./format";

export interface ReceivedAttachment {
  key: string;
  message: MessageHeader;
  attachment: MessageAttachment;
  domain: string;
}

export const ATTACHMENT_DAYS = 90;
export function attachmentCutoff(now = new Date()): Date {
  return new Date(+now - ATTACHMENT_DAYS * 86400000);
}

/** Only domain names: no URLs, mailboxes, wildcards or suffix matching. */
export function normalizeDomain(value: string): string | null {
  const s = value.trim().toLowerCase().replace(/\.$/, "");
  if (!s || /[\s/@:*?#%\\]/.test(s)) return null;
  try {
    const host = new URL(`https://${s}`).hostname;
    if (host.length > 253 || !host.includes(".")) return null;
    return host.split(".").every((p) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p)) ? host : null;
  } catch { return null; }
}

export function senderDomain(author: string): string | null {
  const address = emailOf(author);
  const parts = address.split("@");
  if (parts.length !== 2 || !parts[0] || /[\s<>]/.test(parts[0])) return null;
  return normalizeDomain(parts[1]);
}

export function excludedAttachmentFolders(folders: Iterable<MailFolder>): Set<string> {
  const excluded = new Set<string>();
  const roles = new Set(["sent", "drafts", "templates", "outbox", "trash", "junk"]);
  const walk = (f: MailFolder, inherited = false) => {
    const skip = inherited || !!f.specialUse?.some((r) => roles.has(r));
    if (skip) excluded.add(f.id);
    for (const sub of f.subFolders || []) walk(sub, skip);
  };
  for (const f of folders) walk(f);
  return excluded;
}

export function isReceivedAttachmentMessage(m: MessageHeader, me: Set<string>, excluded: Set<string>, now = new Date()): boolean {
  const date = +new Date(m.date);
  return Number.isFinite(date) && date >= +attachmentCutoff(now) && date <= +now &&
    !m.junk && !!m.folder && !excluded.has(m.folder.id) && !me.has(emailOf(m.author));
}

/** MIME inline resources are reader content, not files in the library. */
export function isFileAttachment(a: MessageAttachment): boolean {
  if (a.contentDisposition?.toLowerCase().startsWith("attachment")) return true;
  return !a.contentId && !a.contentDisposition?.toLowerCase().startsWith("inline");
}

export function filterAttachments(items: ReceivedAttachment[], options: { approvedOnly: boolean; domains: string[]; query: string; type?: FileKind | "all"; now?: Date }): ReceivedAttachment[] {
  const allowed = new Set(options.domains.map(normalizeDomain).filter(Boolean));
  const q = options.query.trim().toLowerCase();
  const now = options.now ?? new Date();
  return items.filter(({ message: m, attachment: a, domain }) => {
    const date = +new Date(m.date);
    if (date < +attachmentCutoff(now) || date > +now) return false;
    if (options.approvedOnly && !allowed.has(domain)) return false;
    if (options.type && options.type !== "all" && fileKind(a) !== options.type) return false;
    return !q || [a.name, m.author, m.subject, domain].some((v) => v.toLowerCase().includes(q));
  // Same email: attachment order (part 1.2 before 1.10, so a numeric-aware compare).
  }).sort((a, b) => +new Date(b.message.date) - +new Date(a.message.date) || a.key.localeCompare(b.key, undefined, { numeric: true }));
}

/** Bounded fetches keep IMAP connections available for the reader. Failures stay visible. */
export async function collectAttachments(messages: MessageHeader[], options: {
  list: (id: number) => Promise<MessageAttachment[]>;
  active: () => boolean;
  onMessage: (message: MessageHeader, files: MessageAttachment[]) => void;
  onError: (message: MessageHeader) => void;
  onDeferred?: (count: number) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}) {
  let next = 0;
  const worker = async () => {
    while (options.active() && !options.signal?.aborted && next < messages.length) {
      const message = messages[next++];
      try {
        const files = await withDeadline(options.list(message.id), options.timeoutMs ?? 15000, options.signal, "Attachment list");
        if (options.active()) options.onMessage(message, files.filter(isFileAttachment));
      } catch (error) {
        if (options.signal?.aborted) return;
        if (options.active()) options.onError(message);
        // The API cannot cancel a MIME stream. Retire this worker after a timeout
        // rather than queueing unbounded additional streams behind a stuck server.
        if (error instanceof RequestTimeout) return;
      }
    }
  };
  await Promise.all([worker(), worker()]);
  if (options.active() && !options.signal?.aborted && next < messages.length) options.onDeferred?.(messages.length - next);
}
