import { describe, expect, it } from "vitest";
import { mailboxGroups, sameView } from "../src/lib/mailboxes";
import type { MailAccount } from "../src/lib/types";
const accounts: MailAccount[] = [{ id: "one", name: "Work", type: "imap", identities: [{ id: "i1", accountId: "one", email: "me@work.org", name: "Me" }], folders: [
  { id: "i", name: "Inbox", path: "/Inbox", specialUse: ["inbox"] },
  { id: "s", name: "Sent", path: "/Sent", specialUse: ["sent"] },
  { id: "custom", name: "Custom", path: "/Custom", subFolders: [{ id: "nested", name: "Archive", path: "/Custom/Archive", specialUse: ["archives"] }] },
] }, { id: "two", name: "Local Folders", type: "none", identities: [], folders: [{ id: "i2", name: "Inbox", path: "/Inbox", specialUse: ["inbox"] }] }];

describe("folder-first sidebar", () => {
  it("groups mailboxes once, with available accounts inside each", () => {
    const groups = mailboxGroups(accounts);
    expect(groups.map((group) => group.label)).toEqual(["Inbox", "Pins", "Sent", "Archive"]);
    expect(groups[0].accounts.map((entry) => entry.label)).toEqual(["me@work.org", "Local Folders"]);
    expect(groups.find((group) => group.key === "sent")?.accounts).toHaveLength(1);
    expect(groups.find((group) => group.key === "archives")?.accounts[0].folderIds).toEqual(["nested"]);
  });
  it("shows nicknames instead of addresses, keeping the address in the tooltip", () => {
    const inbox = mailboxGroups(accounts, { one: "Work", two: "  " })[0];
    expect(inbox.accounts.map((entry) => entry.label)).toEqual(["Work", "Local Folders"]);
    expect(inbox.accounts[0].title).toBe("Work — me@work.org");
  });
  it("separates all-account and account-specific navigation", () => {
    expect(sameView({ kind: "pinned" }, { kind: "pinned", accountId: "one" })).toBe(false);
    expect(sameView({ kind: "mailbox", role: "sent", accountId: "one" }, { kind: "mailbox", role: "sent", accountId: "two" })).toBe(false);
    expect(mailboxGroups(accounts)[0].view).toEqual({ kind: "smart" });
    expect(mailboxGroups(accounts)[0].accounts[0].view).toEqual({ kind: "mailbox", role: "inbox", accountId: "one" });
  });
});
