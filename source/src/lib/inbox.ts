import type { InboxCategory, View } from "./types";

export function categoryParent(view: View): View {
  if (view.kind !== "category") return { kind: "smart" };
  if (view.folderId) return { kind: "folder", folderId: view.folderId };
  if (view.accountId) return { kind: "mailbox", role: "inbox", accountId: view.accountId };
  return view.inbox ? { kind: "smart", inbox: view.inbox } : { kind: "smart" };
}

/** A section (or Work/Personal group) of the inbox being shown. */
export function scopedCategory(cat: InboxCategory | (string & {}), inbox: View): View {
  if (inbox.kind === "category") return { ...inbox, cat };
  if (inbox.kind === "folder") return { kind: "category", cat, folderId: inbox.folderId };
  if (inbox.kind === "mailbox" && inbox.accountId) return { kind: "category", cat, accountId: inbox.accountId };
  if (inbox.kind === "smart" && inbox.inbox) return { kind: "category", cat, inbox: inbox.inbox };
  return { kind: "category", cat };
}

/** What each inbox section is called. */
export const CATEGORY_LABEL: Record<InboxCategory, string> = { people: "People", calendar: "Calendar", notification: "Updates", newsletter: "Newsletters", receipt: "Receipts", pinned: "Pinned" };
