import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalMailCache } from "../src/lib/local-mail-cache";
import type { MessageHeader } from "../src/lib/types";

const inbox = { id: "inbox", accountId: "a1", name: "Inbox", path: "/Inbox" };
const SENT = new Date();
const header = (id: number): MessageHeader => ({ id, date: SENT, author: "ada@example.org", subject: `Mail ${id}`, recipients: [], ccList: [], bccList: [], headerMessageId: `m${id}@example.org`, size: 10, tags: [], flagged: false, read: true, folder: inbox } as MessageHeader);

function backend(live: MessageHeader[]) {
  return {
    messages: { query: vi.fn(async () => ({ id: null, messages: live })), continueList: vi.fn(), getFull: vi.fn(), listAttachments: vi.fn() },
    sparkSearch: { locate: vi.fn(async (items: { folderId: string; headerMessageId: string }[]) => items.map((item) => live.find((m) => m.folder?.id === item.folderId && m.headerMessageId === item.headerMessageId) || null)) },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  } as any;
}
const caches: LocalMailCache[] = [];
afterEach(() => { for (const c of caches) c.close(); caches.length = 0; });

// Saved mail after a restart: the headers are on disk, but none has a live Thunderbird id yet.
async function restarted(live: MessageHeader[]) {
  const name = crypto.randomUUID();
  const first = new LocalMailCache(backend([]), name); caches.push(first);
  await first.init(); first.register([header(1), header(2), header(3)]); await first.flush(); first.close();
  const native = backend(live);
  const cache = new LocalMailCache(native, name); caches.push(cache);
  await cache.init();
  const saved = cache.all();
  expect(saved.every((m) => m.id < 0)).toBe(true);
  return { cache, native, saved };
}

describe("finding saved mail's live Thunderbird id", () => {
  it("uses the folder's Message-ID index, in one call for lookups started together, without a folder scan", async () => {
    const live = [header(101), header(102), header(103)].map((m, i) => ({ ...m, headerMessageId: `m${i + 1}@example.org`, subject: `Mail ${i + 1}` }));
    const { cache, native, saved } = await restarted(live);
    const ids = await Promise.all(saved.map((m) => cache.resolve(m.id)));
    expect(ids.sort()).toEqual([101, 102, 103]);
    expect(native.sparkSearch.locate).toHaveBeenCalledTimes(1);
    expect(native.messages.query).not.toHaveBeenCalled();
    expect(await cache.resolve(saved[0].id)).toBeGreaterThan(100); // now live: no second lookup
    expect(native.sparkSearch.locate).toHaveBeenCalledTimes(1);
  });

  it("falls back to a query when the index finds nothing or a different email with that Message-ID", async () => {
    const other = { ...header(201), headerMessageId: "m1@example.org", subject: "Another email reusing the id" };
    const { cache, native, saved } = await restarted([other]);
    native.messages.query.mockResolvedValue({ id: null, messages: [{ ...header(1), id: 301 }] });
    const target = saved.find((m) => m.headerMessageId === "m1@example.org")!;
    expect(await cache.resolve(target.id)).toBe(301);
    expect(native.messages.query).toHaveBeenCalledTimes(1);
  });

  it("falls back to a query when the experiment fails", async () => {
    const { cache, native, saved } = await restarted([]);
    native.sparkSearch.locate.mockRejectedValue(new Error("no database"));
    native.messages.query.mockResolvedValue({ id: null, messages: [{ ...header(2), id: 302 }] });
    expect(await cache.resolve(saved.find((m) => m.headerMessageId === "m2@example.org")!.id)).toBe(302);
  });
});
