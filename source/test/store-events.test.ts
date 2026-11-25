import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageHeader, MessageList } from "../src/lib/types";
const backend = vi.hoisted(() => {
  const event = () => ({ addListener: vi.fn() });
  return {
    runtime: { getBrowserInfo: vi.fn(async () => ({ version: "158.0.1" })) },
    storage: { local: { get: vi.fn(async (defaults) => defaults), set: vi.fn(async () => {}) } },
    accounts: { list: vi.fn(async () => []), onCreated: event(), onDeleted: event() },
    folders: { getFolderInfo: vi.fn(async () => ({ unreadMessageCount: 0 })), onFolderInfoChanged: event(), onCreated: event(), onDeleted: event(), onRenamed: event() },
    messages: { list: vi.fn(), listAttachments: vi.fn(), query: vi.fn(async (): Promise<MessageList> => ({ id: null, messages: [] })), continueList: vi.fn(), abortList: vi.fn(async (_id: string) => {}), update: vi.fn(async () => {}), onNewMailReceived: event(), onUpdated: event(), onMoved: event(), onCopied: event(), onDeleted: event() },
  };
});
vi.mock("../src/lib/api", async (original) => ({ ...await original<object>(), api: backend, listFolder: (id: string) => backend.messages.list(id), abortList: (id: string) => backend.messages.abortList(id), drain: async (list: MessageList | Promise<MessageList>) => (await list).messages }));
import { Store } from "../src/lib/store.svelte";
const folder = { id: "one", accountId: "work", name: "Inbox", path: "/Inbox" };
const message = (id: number, props: Partial<MessageHeader> = {}): MessageHeader => ({ id, date: new Date("2026-10-26T15:00:00Z"), author: "ada@example.org", subject: "Plan", recipients: [], ccList: [], bccList: [], headerMessageId: String(id), size: 1, tags: [], flagged: false, read: false, folder, ...props });
const view = { kind: "folder", folderId: "one" } as const;
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
async function initialized() {
  const store = new Store();
  vi.spyOn(store.meta, "init").mockResolvedValue();
  vi.spyOn(store.meta, "request").mockImplementation(() => {});
  await store.init();
  return store;
}

describe("cache freshness during Thunderbird events", () => {
  it("does not resurrect a message deleted while a refreshed page was in flight", async () => {
    const store = await initialized();
    backend.messages.list.mockResolvedValueOnce({ id: null, messages: [message(1)] });
    await store.setView(view);
    let finish!: (page: MessageList) => void;
    backend.messages.list.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const refresh = store.reload();
    const deleted = backend.messages.onDeleted.addListener.mock.calls[0][0];
    await deleted({ id: null, messages: [message(1)] });
    finish({ id: null, messages: [message(1)] });
    await refresh;
    expect(store.get(1)).toBeUndefined();
    expect(store.loadedCount).toBe(0);
  });
  it("does not restart an attachment scan every time new mail arrives", async () => {
    const store = await initialized();
    const current = { ...message(1), date: new Date() };
    backend.messages.query.mockResolvedValueOnce({ id: null, messages: [current] });
    backend.messages.listAttachments.mockImplementationOnce(() => new Promise(() => {}));
    const scan = store.setView({ kind: "attachments" });
    await vi.advanceTimersByTimeAsync(1);
    const received = backend.messages.onNewMailReceived.addListener.mock.calls[0][0];
    await received(folder, { id: null, messages: [{ ...message(2), date: new Date() }] });
    await vi.advanceTimersByTimeAsync(500);
    expect(backend.messages.listAttachments).toHaveBeenCalledTimes(1);
    expect(store.loading).toBe(true);
    store.stopAttachmentScan();
    await scan;
    expect(store.attachmentStopped).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(store.loading).toBe(false);
  });
  it("preserves a read update received before the refreshed message page", async () => {
    const store = await initialized();
    backend.messages.list.mockResolvedValueOnce({ id: null, messages: [message(1)] });
    await store.setView(view);
    let finish!: (page: MessageList) => void;
    backend.messages.list.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const refresh = store.reload();
    const updated = backend.messages.onUpdated.addListener.mock.calls[0][0];
    updated(message(1), { read: true });
    finish({ id: null, messages: [message(1, { read: false })] });
    await refresh;
    expect(store.get(1)?.read).toBe(true);
  });
  it("shows a cached inbox immediately and refreshes it after mail arrived elsewhere", async () => {
    const store = await initialized();
    backend.messages.list.mockResolvedValueOnce({ id: null, messages: [message(1)] });
    await store.setView(view);
    backend.messages.list.mockResolvedValueOnce({ id: null, messages: [] });
    await store.setView({ kind: "folder", folderId: "two" });
    const received = backend.messages.onNewMailReceived.addListener.mock.calls[0][0];
    await received(folder, { id: null, messages: [message(2)] });
    let finish!: (page: MessageList) => void;
    backend.messages.list.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const refreshing = store.setView(view);
    expect(store.get(1)?.id).toBe(1);
    expect(store.loading).toBe(true);
    finish({ id: null, messages: [message(1), message(2)] });
    await refreshing;
    expect(store.get(2)?.id).toBe(2);
  });
  it("finds mail that arrived already read (no new-mail event, only a higher folder total)", async () => {
    const store = await initialized();
    backend.messages.list.mockResolvedValueOnce({ id: null, messages: [message(1)] });
    await store.setView(view);
    const info = backend.folders.onFolderInfoChanged.addListener.mock.calls[0][0];
    const received = backend.messages.onNewMailReceived.addListener.mock.calls[0][0];
    backend.messages.query.mockClear();
    info(folder, { totalMessageCount: 10 }); // baseline
    // Announced new mail accounts for its own increase: no check.
    info(folder, { totalMessageCount: 11 });
    await received(folder, { id: null, messages: [message(2)] });
    await vi.advanceTimersByTimeAsync(5500);
    expect(backend.messages.query).not.toHaveBeenCalled();
    // The event may also come first (moves are reported before the total changes): still no check.
    await received(folder, { id: null, messages: [message(4)] });
    info(folder, { totalMessageCount: 12 });
    await vi.advanceTimersByTimeAsync(5500);
    expect(backend.messages.query).not.toHaveBeenCalled();
    // Read on another device first: only the total moves, so the folder's recent mail is checked.
    backend.messages.query.mockResolvedValueOnce({ id: null, messages: [message(3, { read: true, subject: "Read on the phone" })] });
    info(folder, { totalMessageCount: 13 });
    await vi.advanceTimersByTimeAsync(5500);
    expect(backend.messages.query).toHaveBeenCalledWith(expect.objectContaining({ folderId: "one", fromDate: expect.any(Date) }));
    expect(store.get(3)?.subject).toBe("Read on the phone");
  });
  it("new mail waiting for its preview is not listed if it was moved away or the view changed meanwhile", async () => {
    const store = await initialized();
    backend.messages.list.mockResolvedValueOnce({ id: null, messages: [message(1)] });
    await store.setView(view);
    const received = backend.messages.onNewMailReceived.addListener.mock.calls[0][0];
    const moved = backend.messages.onMoved.addListener.mock.calls[0][0];
    let release!: () => void;
    vi.spyOn(store.meta, "settled").mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    // A filter moves it to Junk while its preview loads: no ghost row with a dead id.
    const arriving = received(folder, { id: null, messages: [message(5)] });
    await vi.advanceTimersByTimeAsync(0);
    await moved({ id: null, messages: [message(5)] }, { id: null, messages: [message(50, { folder: { ...folder, id: "junk" }, junk: true })] });
    release(); await arriving;
    expect(store.get(5)).toBeUndefined();
    // The user switches to another folder while it loads: it doesn't land in that folder's list.
    const other = received(folder, { id: null, messages: [message(6)] });
    await vi.advanceTimersByTimeAsync(0);
    backend.messages.list.mockResolvedValueOnce({ id: null, messages: [] });
    await store.setView({ kind: "folder", folderId: "two" });
    release(); await other;
    expect(store.get(6)).toBeUndefined();
  });
  it("a recent-mail check that was under way doesn't bring back mail archived meanwhile", async () => {
    const store = await initialized();
    backend.messages.list.mockResolvedValueOnce({ id: null, messages: [message(1)] });
    await store.setView(view);
    const info = backend.folders.onFolderInfoChanged.addListener.mock.calls[0][0];
    const moved = backend.messages.onMoved.addListener.mock.calls[0][0];
    let answer!: (page: MessageList) => void;
    backend.messages.query.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    info(folder, { totalMessageCount: 20 }); info(folder, { totalMessageCount: 21 });
    await vi.advanceTimersByTimeAsync(5500); // the check starts
    await moved({ id: null, messages: [message(1)] }, { id: null, messages: [message(10, { folder: { ...folder, id: "archive" } })] });
    answer({ id: null, messages: [message(1), message(7, { subject: "Read on the phone" })] }); // listed before the archive
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get(1)).toBeUndefined();
    expect(store.get(7)?.subject).toBe("Read on the phone");
  });
  it("lists a copy made into the open folder, even of mail just moved out of it", async () => {
    const store = await initialized();
    backend.messages.list.mockResolvedValueOnce({ id: null, messages: [message(1)] });
    await store.setView(view);
    const moved = backend.messages.onMoved.addListener.mock.calls[0][0];
    const copied = backend.messages.onCopied.addListener.mock.calls[0][0];
    await moved({ id: null, messages: [message(1)] }, { id: null, messages: [message(10, { folder: { ...folder, id: "archive" } })] });
    expect(store.get(1)).toBeUndefined();
    await copied({ id: null, messages: [message(10, { folder: { ...folder, id: "archive" } })] }, { id: null, messages: [message(11)] });
    expect(store.get(11)?.subject).toBe("Plan");
  });
  it("reloads the open conversation for new mail only when it may belong to it", async () => {
    // Each reload regroups all saved mail for related messages (~40 ms at 20k emails).
    const store = await initialized();
    backend.messages.list.mockResolvedValueOnce({ id: null, messages: [message(1, { subject: "Plan" })] });
    await store.setView(view);
    store.select(store.conversations[0].key);
    const received = backend.messages.onNewMailReceived.addListener.mock.calls[0][0];
    const before = store.readerRev;
    await received(folder, { id: null, messages: [message(2, { subject: "Lunch on Friday", headerMessageId: "2" })] });
    expect(store.readerRev).toBe(before);
    await received(folder, { id: null, messages: [message(3, { subject: "Plan", headerMessageId: "3" })] });
    expect(store.readerRev).toBe(before + 1);
  });
});

describe("picking several conversations", () => {
  it("picks with ⌘-click, Shift-click and ⌘A, and archives every picked one at once", async () => {
    const store = await initialized();
    (backend.messages as any).archive = vi.fn(async () => {});
    backend.messages.list.mockResolvedValueOnce({ id: null, messages: [1, 2, 3, 4].map((id) => message(id, { subject: `Topic ${id}`, date: new Date(Date.UTC(2026, 9, 26, 15, 0, 0) - id * 60000) })) });
    await store.setView(view);
    const keys = store.navOrder.map((c) => c.key);
    expect(keys).toHaveLength(4);
    store.select(keys[0]);
    store.togglePick(keys[2]);            // ⌘-click: the selected one joins the first pick
    expect([...store.picked].sort()).toEqual([keys[0], keys[2]].sort());
    store.togglePick(keys[0]);
    expect([...store.picked]).toEqual([keys[2]]);
    store.pickRange(keys[3]);             // Shift-click from the last picked
    expect(store.pickedConversations.map((c) => c.key)).toEqual([keys[2], keys[3]]);
    expect(store.targets(store.selected).map((c) => c.key)).toEqual([keys[2], keys[3]]);
    store.pickAll();
    expect(store.pickedConversations).toHaveLength(4);
    store.clearPicks();
    expect(store.targets(store.selected).map((c) => c.key)).toEqual([keys[0]]);

    store.togglePick(keys[1]); store.togglePick(keys[3]);
    await store.archive(store.pickedConversations);
    expect((backend.messages as any).archive).toHaveBeenCalledWith(expect.arrayContaining([1, 2, 4]));
    expect(store.navOrder.map((c) => c.key)).toEqual([keys[2]]);
    expect(store.picked.size).toBe(0);
  });

  it("extends with Shift+↓ and forgets picks when the view changes", async () => {
    const store = await initialized();
    backend.messages.list.mockResolvedValueOnce({ id: null, messages: [1, 2, 3].map((id) => message(id, { subject: `Topic ${id}`, date: new Date(Date.UTC(2026, 9, 26, 15, 0, 0) - id * 60000) })) });
    await store.setView(view);
    const keys = store.navOrder.map((c) => c.key);
    store.select(keys[0]);
    store.extendPick(1); store.extendPick(1);
    expect(store.pickedConversations.map((c) => c.key)).toEqual(keys);
    backend.messages.list.mockResolvedValueOnce({ id: null, messages: [] });
    await store.setView({ kind: "folder", folderId: "two" });
    expect(store.picked.size).toBe(0);
  });
});
