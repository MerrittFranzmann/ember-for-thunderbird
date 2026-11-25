import type { MailAccount, MailboxRole, MailFolder, View } from "./types";

export interface MailboxEntry {
  key: string;
  accountId: string;
  label: string;
  title: string;
  avatar: string;
  /** The account's colour (0–7, by its place among the accounts): the --account-N token. */
  color: number;
  folderIds: string[];
  view: View;
}
export interface MailboxGroup {
  key: string;
  label: string;
  icon: string;
  view: View;
  accounts: MailboxEntry[];
}

/** How an account is shown: its nickname (Settings → Inbox nicknames), else its address. */
export function accountLabel(account: MailAccount, nicknames: Record<string, string> = {}): string {
  return nicknames[account.id]?.trim() || account.identities?.[0]?.email || account.name;
}

export function mailboxGroups(accounts: MailAccount[], nicknames: Record<string, string> = {}): MailboxGroup[] {
  const definitions: { key: MailboxRole | "pins"; label: string; icon: string }[] = [
    { key: "inbox", label: "Inbox", icon: "inbox" },
    { key: "pins", label: "Pins", icon: "pin" },
    { key: "sent", label: "Sent", icon: "send" },
    { key: "trash", label: "Trash", icon: "trash" },
    { key: "drafts", label: "Drafts", icon: "draft" },
    { key: "archives", label: "Archive", icon: "archive" },
    { key: "junk", label: "Spam", icon: "junk" },
  ];
  const allFolders = (account: MailAccount): MailFolder[] => {
    const result: MailFolder[] = [];
    const walk = (folders: MailFolder[]) => { for (const folder of folders) { result.push(folder); walk(folder.subFolders || []); } };
    walk(account.folders ?? account.rootFolder?.subFolders ?? []);
    return result;
  };
  return definitions.map(({ key, label, icon }): MailboxGroup => ({
    key, label, icon,
    view: key === "inbox" ? { kind: "smart" } : key === "pins" ? { kind: "pinned" } : { kind: "mailbox", role: key },
    accounts: accounts.flatMap((account, index) => {
      const folders = allFolders(account).filter((folder) => folder.specialUse?.includes(key));
      if (key !== "pins" && !folders.length) return [];
      return [{
        key: `${key}:${account.id}`, accountId: account.id, label: accountLabel(account, nicknames), title: `${account.name} — ${accountLabel(account)}`,
        avatar: account.identities?.[0] ? `${account.identities[0].name} <${account.identities[0].email}>` : account.name,
        color: index % 8,
        folderIds: folders.map((folder) => folder.id),
        view: key === "pins" ? { kind: "pinned", accountId: account.id } : { kind: "mailbox", role: key, accountId: account.id },
      }];
    }),
  })).filter((group) => group.accounts.length > 0);
}

/** With Work and Personal inboxes (inboxes.ts): Inbox becomes Work and Personal, each with its accounts, and the
 *  inbox of every account stays only when asked for ("All inboxes"). Needs an account on each side. */
export function splitInbox(groups: MailboxGroup[], workAccounts: string[], showAll = false): MailboxGroup[] {
  return groups.flatMap((group) => {
    if (group.key !== "inbox" || !workAccounts.length) return [group];
    const work = group.accounts.filter((entry) => workAccounts.includes(entry.accountId));
    const personal = group.accounts.filter((entry) => !workAccounts.includes(entry.accountId));
    if (!work.length || !personal.length) return [group];
    return [
      { key: "inbox-work", label: "Work", icon: "briefcase", view: { kind: "smart", inbox: "work" }, accounts: work },
      { key: "inbox-personal", label: "Personal", icon: "home", view: { kind: "smart", inbox: "personal" }, accounts: personal },
      ...(showAll ? [{ ...group, label: "All inboxes" }] : []),
    ];
  });
}
export const isInboxGroup = (key: string) => key === "inbox" || key.startsWith("inbox-");

export function sameView(a: View, b: View): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "smart" && b.kind === "smart") return a.inbox === b.inbox;
  if (a.kind === "mailbox" && b.kind === "mailbox") return a.role === b.role && a.accountId === b.accountId;
  if (a.kind === "pinned" && b.kind === "pinned") return a.accountId === b.accountId;
  if (a.kind === "folder" && b.kind === "folder") return a.folderId === b.folderId;
  if (a.kind === "category" && b.kind === "category") return a.cat === b.cat && a.accountId === b.accountId && a.folderId === b.folderId && a.inbox === b.inbox;
  if (a.kind === "search" && b.kind === "search") return a.query === b.query;
  if (a.kind === "trip" && b.kind === "trip") return a.id === b.id;
  return true;
}
