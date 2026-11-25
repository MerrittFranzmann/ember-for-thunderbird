import type { SearchFilters } from "./mail-search";
import type { MeetingBrief } from "./meeting-brief";
// Shapes returned by the Thunderbird MailExtension APIs (MV3), trimmed to what we use.

export type MessageId = number;

export interface MailFolder {
  id: string;
  accountId?: string;
  name: string;
  path: string;
  specialUse?: string[];
  subFolders?: MailFolder[];
  isRoot?: boolean;
  isVirtual?: boolean;
  isUnified?: boolean;
  isTag?: boolean;
  isFavorite?: boolean;
}

export interface MailIdentity {
  id: string;
  accountId: string;
  email: string;
  name: string;
  label?: string;
  signature?: string;
  signatureIsPlainText?: boolean;
  composeHtml?: boolean;
  replyTo?: string;
}

export interface MailAccount {
  id: string;
  name: string;
  type: string;
  folders?: MailFolder[] | null;
  rootFolder?: MailFolder;
  identities: MailIdentity[];
}

export interface MessageHeader {
  id: MessageId;
  date: Date;
  author: string;
  subject: string;
  read?: boolean;
  flagged: boolean;
  junk?: boolean;
  new?: boolean;
  recipients: string[];
  ccList: string[];
  bccList: string[];
  headerMessageId: string;
  size: number;
  tags: string[];
  folder?: MailFolder;
  external?: boolean;
}

export interface MessageList {
  id: string | null;
  messages: MessageHeader[];
}

export interface MessagePart {
  contentType?: string;
  body?: string;
  headers?: Record<string, string[]>;
  name?: string;
  partName?: string;
  parts?: MessagePart[];
  size?: number;
}

export interface MessageAttachment {
  contentType: string;
  name: string;
  partName: string;
  size: number;
  contentId?: string;
  contentDisposition?: string;
}

/** "notification" is shown as Updates (the key is kept: it is saved in caches and settings). "receipt"
 *  (receipts, invoices, bills, expenses) is only ever Clef's answer (AI sorting on). */
export type Category = "people" | "calendar" | "notification" | "newsletter" | "receipt";
export type InboxCategory = Category | "pinned";

/** Cached per-message metadata derived from headers/body (keyed by Message-ID). */
export interface MessageMeta {
  cat?: Category;
  snippet?: string;
  refs?: string[]; // Message-IDs from In-Reply-To + References (no angle brackets)
  replyTo?: string;
  hasAtt?: boolean;
  listUnsubscribe?: string;
  /** "h" = classified from headers only, "f" = from full message (has snippet). */
  lvl?: "h" | "f";
}

export interface Conversation {
  key: string;
  ids: MessageId[]; // newest first
  latest: MessageHeader;
  count: number;
  unread: number;
  flagged: boolean;
  hasAttachment: boolean;
  cat: Category;
  /** Display names of distinct senders, newest first. */
  senders: string[];
}

export type MailboxRole = "inbox" | "sent" | "drafts" | "trash" | "archives" | "junk";

/** Work or Personal (inboxes.ts). */
export type InboxId = "work" | "personal";

export type View =
  | { kind: "smart"; inbox?: InboxId }
  | { kind: "pinned"; accountId?: string }
  | { kind: "mailbox"; role: MailboxRole; accountId?: string }
  | { kind: "attachments" }
  | { kind: "senders" }
  | { kind: "activity" }
  | { kind: "calendar" }
  | { kind: "trip"; id: string }
  /** `cat`: a base section (InboxCategory), or a group id of the inbox's groups when it's in Work/Personal. */
  | { kind: "category"; cat: InboxCategory | (string & {}); accountId?: string; folderId?: string; inbox?: InboxId }
  | { kind: "folder"; folderId: string }
  | { kind: "search"; query: string; filters?: SearchFilters; scope?: "local" | "all"; meeting?: MeetingBrief };
