import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageHeader } from "../src/lib/types";

const backend = vi.hoisted(() => ({
  messages: { list: vi.fn(), query: vi.fn(), continueList: vi.fn(), abortList: vi.fn(async (_id: string) => {}), listAttachments: vi.fn(), getHeaders: vi.fn(), update: vi.fn(async () => {}) },
  storage: { local: { set: vi.fn(async () => {}) } },
}));
vi.mock("../src/lib/api", async (importOriginal) => ({ ...await importOriginal<object>(), api: backend, listFolder: (id: string) => backend.messages.list(id), abortList: (id: string) => backend.messages.abortList(id) }));
import { Store } from "../src/lib/store.svelte";
import { vocabularyKey } from "../src/lib/inboxes";
const now = new Date("2026-10-26T15:00:00Z");
const message = (id: number, p: Partial<MessageHeader> = {}): MessageHeader => ({ id, date: now, author: "Ada <ada@example.org>", subject: "Plan", recipients: ["me@work.org"], ccList: [], bccList: [], headerMessageId: `message-${id}`, size: 10, tags: [], flagged: false, folder: { id: "inbox", name: "Inbox", path: "/Inbox" }, ...p });
const file = { name: "plan.pdf", partName: "1.2", contentType: "application/pdf", size: 42 };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); vi.clearAllMocks(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("Thunderbird attachment integration", () => {
  it("queries and drains every page, excludes outgoing/junk/old mail and lists actual MIME attachments", async () => {
    const store = new Store();
    store.me.add("me@work.org");
    store.folderById.set("sent", { id: "sent", name: "Sent", path: "/Sent", specialUse: ["sent"] });
    backend.messages.query.mockResolvedValue("page-one");
    backend.messages.continueList.mockImplementation(async (id) => id === "page-one" ? { id: "page-two", messages: [message(1), message(2, { junk: true }), message(3, { author: "me@work.org" })] } : { id: null, messages: [message(4), message(5, { date: new Date("2026-01-01") }), message(6, { folder: store.folderById.get("sent") })] });
    backend.messages.listAttachments.mockResolvedValue([file]);
    await store.setView({ kind: "attachments" });
    expect(backend.messages.query).toHaveBeenCalledWith(expect.objectContaining({ attachment: true, fromDate: new Date(+now - 90 * 86400000) }));
    expect(backend.messages.continueList.mock.calls.map(([id]) => id)).toEqual(["page-one", "page-two"]);
    expect(store.attachments.map((x) => x.message.id)).toEqual([1, 4]);
    expect(store.loading).toBe(false);
    expect(store.attachmentsScanned).toBe(2);
  });
  it("aborts a late query page after leaving the attachment view", async () => {
    const store = new Store();
    let resolveQuery!: (value: unknown) => void;
    backend.messages.query.mockReturnValueOnce(new Promise((resolve) => { resolveQuery = resolve; }));
    const loading = store.setView({ kind: "attachments" });
    backend.messages.query.mockResolvedValue({ id: null, messages: [] });
    await store.setView({ kind: "search", query: "other" });
    resolveQuery({ id: "stale-page", messages: [message(1)] });
    await loading;
    expect(backend.messages.abortList).toHaveBeenCalledWith("stale-page");
    expect(backend.messages.listAttachments).not.toHaveBeenCalled();
    expect(store.attachments).toEqual([]);
  });
  it("preserves successful files when another message is offline", async () => {
    const store = new Store();
    backend.messages.query.mockResolvedValue({ id: null, messages: [message(1), message(2)] });
    backend.messages.listAttachments.mockImplementation(async (id) => { if (id === 2) throw new Error("offline"); return [file]; });
    await store.setView({ kind: "attachments" });
    expect(store.attachments).toHaveLength(1);
    expect(store.attachmentFailures).toBe(1);
    expect(store.error).toBeNull();
  });
  it("shows successful files before the scan finishes and allows stopping stalled reads", async () => {
    const store = new Store();
    backend.messages.query.mockResolvedValue({ id: null, messages: [message(1), message(2), message(3)] });
    backend.messages.listAttachments.mockImplementation(async (id) => id === 1 ? [file] : new Promise(() => {}));
    const scan = store.setView({ kind: "attachments" });
    await vi.advanceTimersByTimeAsync(1);
    expect(store.loading).toBe(true);
    expect(store.attachments).toHaveLength(1);
    store.stopAttachmentScan();
    await scan;
    expect(store.loading).toBe(false);
    expect(store.attachmentStopped).toBe(true);
    expect(store.attachments).toHaveLength(1);
  });
  it("reuses unresolved MIME reads when retrying instead of queueing more streams", async () => {
    const store = new Store();
    backend.messages.query.mockResolvedValue({ id: null, messages: [message(1), message(2)] });
    backend.messages.listAttachments.mockImplementation(() => new Promise(() => {}));
    const first = store.setView({ kind: "attachments" });
    await vi.advanceTimersByTimeAsync(15001);
    await first;
    expect(store.attachmentFailures).toBe(2);
    const retry = store.reload();
    await vi.advanceTimersByTimeAsync(15001);
    await retry;
    expect(backend.messages.listAttachments).toHaveBeenCalledTimes(2);
    expect(store.loading).toBe(false);
  });
  it("finishes with an actionable error when the attachment query never responds", async () => {
    const store = new Store();
    backend.messages.query.mockReturnValueOnce(new Promise(() => {}));
    const scan = store.setView({ kind: "attachments" });
    await vi.advanceTimersByTimeAsync(20001);
    await scan;
    expect(store.loading).toBe(false);
    expect(store.error).toContain("took too long");
  });
  it("surfaces query failures and leaves loading state", async () => {
    const store = new Store();
    backend.messages.query.mockRejectedValue(new Error("Unavailable"));
    await store.setView({ kind: "attachments" });
    expect(store.error).toBe("Unavailable");
    expect(store.loading).toBe(false);
  });
  it("persists approvals and never applies preferences that failed to save", async () => {
    const store = new Store();
    await store.approveAttachmentDomain("Example.ORG");
    expect(store.settings.approvedAttachmentDomains).toEqual(["example.org"]);
    expect(backend.storage.local.set).toHaveBeenCalledWith({ approvedAttachmentDomains: ["example.org"] });
    backend.storage.local.set.mockRejectedValueOnce(new Error("Storage full"));
    await expect(store.setSetting("attachmentApprovedOnly", false)).rejects.toThrow("Storage full");
    expect(store.settings.attachmentApprovedOnly).toBe(true);
  });
});

describe("cached inbox navigation", () => {
  const folder = (id: string) => ({ kind: "folder", folderId: id } as const);
  it("stages all pages and restores a visited inbox without fetching it again", async () => {
    const store = new Store();
    let finish!: (value: unknown) => void;
    backend.messages.list.mockResolvedValueOnce({ id: "next", messages: [message(1)] });
    backend.messages.continueList.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const loading = store.setView(folder("one"));
    await Promise.resolve(); await Promise.resolve();
    expect(store.hasLoadedView).toBe(false);
    expect(store.get(1)).toBeUndefined();
    finish({ id: null, messages: [message(2)] });
    await loading;
    expect(store.get(1)?.id).toBe(1);
    expect(store.get(2)?.id).toBe(2);
    backend.messages.list.mockResolvedValueOnce({ id: null, messages: [message(3)] });
    await store.setView(folder("two"));
    await store.setView(folder("one"));
    expect(backend.messages.list).toHaveBeenCalledTimes(2);
    expect(store.get(1)?.id).toBe(1);
    expect(store.get(3)).toBeUndefined();
    expect(store.loadedCount).toBe(2);
  });
  it("keeps the cached list and count visible until a stale refresh completes", async () => {
    const store = new Store();
    backend.messages.list.mockResolvedValueOnce({ id: null, messages: [message(1)] });
    await store.setView(folder("one"));
    backend.messages.list.mockResolvedValueOnce({ id: null, messages: [] });
    await store.setView(folder("two"));
    await vi.advanceTimersByTimeAsync(60001);
    let finish!: (value: unknown) => void;
    backend.messages.list.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const refreshing = store.setView(folder("one"));
    expect(store.hasLoadedView).toBe(true);
    expect(store.loading).toBe(true);
    expect(store.get(1)?.id).toBe(1);
    expect(store.loadedCount).toBe(1);
    finish({ id: null, messages: [message(2), message(3)] });
    await refreshing;
    expect(store.get(1)).toBeUndefined();
    expect(store.get(2)?.id).toBe(2);
    expect(store.loadedCount).toBe(2);
  });
  it("retains cached mail if a refresh fails and remembers separate scroll positions", async () => {
    const store = new Store();
    backend.messages.list.mockResolvedValueOnce({ id: null, messages: [message(1)] });
    await store.setView(folder("one"));
    store.saveListScroll(640);
    backend.messages.list.mockResolvedValueOnce({ id: null, messages: [] });
    await store.setView(folder("two"));
    expect(store.listScroll()).toBe(0);
    store.saveListScroll(120);
    await store.setView(folder("one"));
    expect(store.listScroll()).toBe(640);
    backend.messages.list.mockRejectedValueOnce(new Error("Offline"));
    await store.reload();
    expect(store.get(1)?.id).toBe(1);
    expect(store.error).toBe("Offline");
    expect(store.hasLoadedView).toBe(true);
  });
  it("aggregates a mailbox across accounts and isolates an account's pins", async () => {
    const store = new Store();
    for (const id of ["one", "two"]) store.folderById.set(id, { id, accountId: id, name: "Sent", path: "/Sent", specialUse: ["sent"] });
    backend.messages.list.mockImplementation(async (id) => ({ id: null, messages: [message(id === "one" ? 1 : 2)] }));
    await store.setView({ kind: "mailbox", role: "sent" });
    expect(store.loadedCount).toBe(2);
    await store.setView({ kind: "mailbox", role: "sent", accountId: "one" });
    expect(store.loadedCount).toBe(1);
    backend.messages.query.mockResolvedValue({ id: null, messages: [message(1, { flagged: true, folder: store.folderById.get("one") }), message(2, { flagged: true, folder: store.folderById.get("two") })] });
    await store.setView({ kind: "pinned", accountId: "one" });
    expect(store.get(1)?.id).toBe(1);
    expect(store.get(2)).toBeUndefined();
  });
});

describe("Receipts (AI sorting)", () => {
  it("files what Clef calls a receipt, invoice or bill under Receipts, only with AI sorting on", () => {
    const store = new Store();
    store.me.add("me@work.org");
    const bill = message(1, { author: "Billing <billing@shop.example>", subject: "Your invoice", headerMessageId: "<bill@x>" });
    const note = message(2, { author: "Ada <ada@example.org>", subject: "Lunch?", headerMessageId: "<note@x>" });
    const mine = message(3, { author: "me@work.org", subject: "Expenses", headerMessageId: "<mine@x>" });
    const at = Math.floor(+now / 60000);
    (store as any).takeAiAnswers({ "bill@x": ["notification", 90, at, 5, 10, 96, 3], "note@x": ["people", 92, at, 80, 20, 2, 1], "mine@x": ["people", 90, at, 0, 0, 95, 0] });
    store.settings.aiSort = true;
    expect(store.categoryOf(bill)).toBe("receipt");
    expect(store.categoryOf(note)).toBe("people");
    expect(store.categoryOf(mine)).not.toBe("receipt");
    store.settings.aiSort = false;
    expect(store.categoryOf(bill)).not.toBe("receipt");
  });
});

describe("Work and Personal inboxes", () => {
  const account = (id: string, email: string) => ({ account: { id, name: email, type: "imap", identities: [{ email, name: "Me" }] }, primary: [{ folder: { id: `${id}/inbox`, name: "Inbox", path: "/Inbox", accountId: id, specialUse: ["inbox"] }, depth: 0, role: "inbox" }], others: [] }) as any;
  const inFolder = (accountId: string) => ({ id: `${accountId}/inbox`, name: "Inbox", path: "/Inbox", accountId, specialUse: ["inbox"] });
  function workStore() {
    const store = new Store();
    store.me.add("me@northwind.example"); store.me.add("me@gmail.com");
    store.accounts = [account("a7", "me@northwind.example"), account("a1", "me@gmail.com")];
    store.settings.workAccounts = ["a7"];
    return store;
  }

  it("sorts each inbox into its own groups: the sender rule first, then a sure Clef group, then the rules", () => {
    const store = workStore();
    expect(store.split).toBe(true);
    const colleague = message(1, { author: "Grace <grace@northwind.example>", folder: inFolder("a7"), headerMessageId: "<c@x>" });
    const donor = message(2, { author: "Don <don@donors.org>", folder: inFolder("a7"), headerMessageId: "<d@x>" });
    const shop = message(3, { author: "Shop <orders@shop.example>", subject: "Your order has shipped", folder: inFolder("a1"), headerMessageId: "<s@x>" });
    expect(store.inboxOfAccount("a7")).toBe("work");
    expect(store.groupOf(colleague)).toBe("team");
    expect(store.groupOf(donor)).toBe("outside");
    expect(store.groupOf(shop)).toBe("purchases");

    store.settings.aiSort = true;
    (store as any).takeAiGroups({ "d@x": [vocabularyKey("work"), "tools", 88] });
    expect(store.groupOf(donor)).toBe("tools");
    store.settings.senderGroups = { work: { "don@donors.org": "outside" } };
    expect(store.groupOf(donor)).toBe("outside");
    // One inbox again without work accounts: the base sections.
    store.settings.workAccounts = [];
    expect(store.split).toBe(false);
    expect(store.groupOf(shop)).toBe(store.categoryOf(shop));
  });

  it("shows a Work group's conversations in its tab, and names the inbox and group", async () => {
    const store = workStore();
    expect(store.homeView()).toEqual({ kind: "smart", inbox: "work" });
    store.view = { kind: "category", cat: "team", inbox: "work" };
    expect(store.viewTitle).toBe("Team — Work");
    expect(store.inboxTabs.map((t) => t.id)).toEqual(["team", "outside", "calendar", "tools", "receipts", "announcements", "pinned"]);
    store.settings.inboxGroups = { work: { hidden: ["announcements"], labels: { team: "Northwind" } } };
    expect(store.inboxTabs.map((t) => t.label)).toEqual(["Northwind", "Outside", "Calendar", "Tools", "Receipts", "Pinned"]);
    expect(store.viewInbox({ kind: "mailbox", role: "inbox", accountId: "a1" })).toBe("personal");
    expect(store.inboxFolders("work").map((f) => f.id)).toEqual(["a7/inbox"]);
  });
});
