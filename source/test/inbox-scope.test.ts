import { describe, expect, it } from "vitest";
import { categoryParent, scopedCategory } from "../src/lib/inbox";
import { datasetKey, navigationKey } from "../src/lib/view-cache";
import { sameView } from "../src/lib/mailboxes";

describe("categories within individual inboxes", () => {
  it("keeps the account when entering a category and returning to the inbox", () => {
    const inbox = { kind: "mailbox", role: "inbox", accountId: "work" } as const;
    const category = scopedCategory("notification", inbox);
    expect(category).toEqual({ kind: "category", cat: "notification", accountId: "work" });
    expect(categoryParent(category)).toEqual(inbox);
    expect(datasetKey(category)).toBe(datasetKey(inbox));
    expect(datasetKey(category)).not.toBe(datasetKey({ kind: "mailbox", role: "inbox", accountId: "personal" }));
  });
  it("preserves a specific folder scope and gives each lens its own scroll position", () => {
    const inbox = { kind: "folder", folderId: "folder-one" } as const;
    const category = scopedCategory("newsletter", inbox);
    expect(categoryParent(category)).toEqual(inbox);
    expect(datasetKey(category)).toBe(datasetKey(inbox));
    expect(navigationKey(category)).not.toBe(navigationKey(inbox));
    expect(sameView(category, { kind: "category", cat: "newsletter", folderId: "folder-two" })).toBe(false);
  });
  it("keeps the unified Smart Inbox available", () => {
    expect(scopedCategory("notification", { kind: "smart" })).toEqual({ kind: "category", cat: "notification" });
    expect(categoryParent({ kind: "category", cat: "notification" })).toEqual({ kind: "smart" });
  });
});
