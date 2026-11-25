import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FULL_INVENTORY_MS, LocalMailCache, messageKey } from "../src/lib/local-mail-cache";
import type { MessageHeader } from "../src/lib/types";

const inbox = { id: "inbox", accountId: "a1", name: "Inbox", path: "/Inbox", specialUse: ["inbox"] };
const work = { id: "work", accountId: "a1", name: "Work", path: "/Work" };
const SENT = new Date();
const header = (id: number, folder: any): MessageHeader => ({ id, date: SENT, author: "ada@example.org", subject: `Mail ${id}`, recipients: [], ccList: [], bccList: [], headerMessageId: `m${id}@example.org`, size: 10, tags: [], flagged: false, read: true, folder } as MessageHeader);

// A Thunderbird stand-in: two folders with counts, and query() filtered by folderId.
function backend() {
  const folders: Record<string, MessageHeader[]> = { inbox: [header(1, inbox), header(2, inbox)], work: [header(3, work)] };
  const store: Record<string, any> = {};
  const native: any = {
    folders,
    accounts: { list: vi.fn(async () => [{ id: "a1", folders: [{ ...inbox }, { ...work }] }]) },
    folders_: null,
    messages: {
      query: vi.fn(async (q: any) => ({ id: null, messages: q.folderId ? (folders[q.folderId] || []).filter((m) => !q.flagged || m.flagged) : Object.values(folders).flat().filter((m) => !q.flagged || m.flagged) })),
      continueList: vi.fn(), getFull: vi.fn(async () => ({ contentType: "text/plain", body: "x" })), listAttachments: vi.fn(async () => []), getHeaders: vi.fn(),
    },
    storage: { local: { get: vi.fn(async (k: string) => ({ [k]: store[k] })), set: vi.fn(async (v: any) => Object.assign(store, v)) } },
  };
  native.folders = { getFolderInfo: vi.fn(async (id: string) => ({ totalMessageCount: folders[id].length, unreadMessageCount: 0, newMessageCount: 0 })) };
  return { native, folders, store };
}
const caches: LocalMailCache[] = [];
afterEach(() => { for (const c of caches) c.close(); caches.length = 0; vi.useRealTimers(); });
const queriedFolders = (native: any) => native.messages.query.mock.calls.map(([q]: any[]) => q.folderId ?? "ALL");

describe("incremental inventory", () => {
  it("lists a folder again after mail left it, even when its count is back where it was (a draft replaced)", async () => {
    const { native, folders, store } = backend();
    const cache = new LocalMailCache(native, crypto.randomUUID()); caches.push(cache);
    await cache.init();
    await cache.warm({ inventory: true });
    native.messages.query.mockClear();
    cache.remove([header(3, work)]); // its delete event
    folders.work = [header(6, work)]; // and a new one saved: still one email
    expect(store.cacheFolderMarks.marks.work).toBeUndefined(); // the page stops trusting it too
    await cache.warm({ inventory: true });
    expect(queriedFolders(native)).toEqual(["work"]);
    expect(cache.snapshotKeys().keys).toContain(messageKey(header(6, work)));
  });
  it("does a full inventory first, then lists only recent mail of folders whose counts changed", async () => {
    const { native, folders } = backend();
    const cache = new LocalMailCache(native, crypto.randomUUID()); caches.push(cache);
    await cache.init();
    await cache.warm({ inventory: true });
    expect(queriedFolders(native)).toEqual(["ALL", "ALL"]); // 90 days + flagged, every folder
    expect(cache.headersFor(cache.snapshotKeys().keys)).toHaveLength(3);

    native.messages.query.mockClear();
    await cache.warm({ inventory: true }); // nothing changed
    expect(native.messages.query).not.toHaveBeenCalled();
    expect(cache.headersFor(cache.snapshotKeys().keys)).toHaveLength(3); // unchanged folders keep their mail

    folders.work = [header(3, work), header(4, work)]; // a missed arrival in Work (its count changes)
    await cache.warm({ inventory: true });
    expect(queriedFolders(native)).toEqual(["work"]); // one recent-window query, not 90 days + flagged
    const since = native.messages.query.mock.calls[0][0].fromDate as Date;
    expect(Date.now() - since.getTime()).toBeLessThan(15 * 60000); // from just before the last pass
    let keys = cache.snapshotKeys().keys;
    expect(keys).toContain(messageKey(header(4, work))); // the missed arrival is found
    expect(keys).toContain(messageKey(header(3, work)));
    expect(keys).toContain(messageKey(header(1, inbox)));

    folders.work = [header(4, work), header(5, work)]; // 3 gone and 5 arrived: same count, missed events
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + FULL_INVENTORY_MS + 1000);
    await cache.warm({ inventory: true }); // the full one removes what's gone
    keys = cache.snapshotKeys().keys;
    expect(keys).not.toContain(messageKey(header(3, work)));
    expect(keys).toContain(messageKey(header(5, work)));
  });
  it("drops mail of a folder that no longer exists, even between full inventories", async () => {
    const { native, folders } = backend();
    const cache = new LocalMailCache(native, crypto.randomUUID()); caches.push(cache);
    await cache.init();
    await cache.warm({ inventory: true });
    native.accounts.list = vi.fn(async () => [{ id: "a1", folders: [{ ...inbox }] }]); // Work deleted
    delete (folders as any).work;
    await cache.warm({ inventory: true });
    const keys = cache.snapshotKeys().keys;
    expect(keys).not.toContain(messageKey(header(3, work)));
    expect(keys).toContain(messageKey(header(2, inbox)));
  });
  it("still runs a full inventory every few hours, and after a restart reuses saved counts", async () => {
    const { native } = backend();
    const name = crypto.randomUUID();
    const cache = new LocalMailCache(native, name); caches.push(cache);
    await cache.init();
    await cache.warm({ inventory: true });
    cache.close();
    const again = new LocalMailCache(native, name); caches.push(again); // background restarted
    await again.init();
    native.messages.query.mockClear();
    await again.warm({ inventory: true });
    expect(native.messages.query).not.toHaveBeenCalled(); // saved counts: nothing to re-list
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + FULL_INVENTORY_MS + 1000);
    await again.warm({ inventory: true });
    expect(queriedFolders(native)).toEqual(["ALL", "ALL"]);
  });
  it("falls back to a full inventory when folder counts can't be read", async () => {
    const { native } = backend();
    native.accounts.list = vi.fn(async () => { throw new Error("busy"); });
    const cache = new LocalMailCache(native, crypto.randomUUID()); caches.push(cache);
    await cache.init();
    await cache.warm({ inventory: true });
    await cache.warm({ inventory: true });
    expect(queriedFolders(native)).toEqual(["ALL", "ALL", "ALL", "ALL"]);
  });
  it("starts over with a full inventory when the database is empty, even with folder counts saved", async () => {
    const { native, store } = backend();
    store.cacheFolderMarks = { at: Date.now(), full: Date.now(), marks: { inbox: "2:0:0", work: "1:0:0" } }; // left by a cleared database
    const cache = new LocalMailCache(native, crypto.randomUUID()); caches.push(cache);
    await cache.init();
    expect(cache.empty).toBe(true);
    await cache.warm({ inventory: true });
    expect(queriedFolders(native)).toEqual(["ALL", "ALL"]); // 90 days + flagged across every folder, not an incremental pass
    expect(cache.headersFor(cache.snapshotKeys().keys)).toHaveLength(3);
  });
});
