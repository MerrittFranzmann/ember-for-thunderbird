import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalMailCache } from "../src/lib/local-mail-cache";
import type { MessageHeader } from "../src/lib/types";

const inbox = { id: "inbox", accountId: "a1", name: "Inbox", path: "/Inbox" };
const header = (id: number): MessageHeader => ({ id, date: new Date(), author: "ada@example.org", subject: `Mail ${id}`, recipients: [], ccList: [], bccList: [], headerMessageId: `m${id}@example.org`, size: 10, tags: [], flagged: false, read: true, folder: inbox } as MessageHeader);
const caches: LocalMailCache[] = [];
afterEach(() => { for (const c of caches) c.close(); caches.length = 0; vi.useRealTimers(); });

describe("emails the server can't return", () => {
  it("are retried after a growing wait, not on every pass, and at once on an explicit refresh", async () => {
    const native: any = {
      messages: {
        query: vi.fn(async () => ({ id: null, messages: [header(1), header(2)] })), continueList: vi.fn(), listAttachments: vi.fn(async () => []),
        getFull: vi.fn(async (id: number) => { if (id === 2) throw new Error("The server didn't return this email"); return { contentType: "text/plain", body: "hi" }; }),
      },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    };
    const cache = new LocalMailCache(native, crypto.randomUUID()); caches.push(cache);
    await cache.init(); cache.register([header(1), header(2)]);
    await cache.warm({ inventory: false });
    expect(native.messages.getFull.mock.calls.map(([id]: number[]) => id).sort()).toEqual([1, 2]);
    expect(cache.status).toMatchObject({ phase: "error", failed: 1 });
    expect(cache.status.lastCompletedAt).toBeGreaterThan(0); // every email was tried: views may use the saved lists
    expect(cache.status.failures).toEqual(["a1 /Inbox: The server didn't return this email"]); // why, for diagnosis

    native.messages.getFull.mockClear();
    await cache.warm({ inventory: false }); // e.g. the next new email
    expect(native.messages.getFull).not.toHaveBeenCalled();
    expect(cache.status).toMatchObject({ phase: "error", failed: 1 }); // still reported

    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 31 * 60000);
    await cache.warm({ inventory: false });
    expect(native.messages.getFull.mock.calls.map(([id]: number[]) => id)).toEqual([2]); // retried after 30 min
    native.messages.getFull.mockClear();
    vi.setSystemTime(Date.now() + 31 * 60000);
    await cache.warm({ inventory: false });
    expect(native.messages.getFull).not.toHaveBeenCalled(); // second failure: waits an hour

    cache.clearFailures();
    native.messages.getFull.mockImplementation(async () => ({ contentType: "text/plain", body: "now it works" }));
    await cache.warm({ inventory: false });
    expect(native.messages.getFull.mock.calls.map(([id]: number[]) => id)).toEqual([2]);
    expect(cache.status).toMatchObject({ phase: "ready", failed: 0 });
    expect(cache.status.failures).toBeUndefined(); // nothing left failing: the old reason goes
  });
  it("don't count as a complete pass when caching stopped early (offline)", async () => {
    const native: any = {
      messages: { query: vi.fn(), continueList: vi.fn(), listAttachments: vi.fn(async () => []), getFull: vi.fn(async () => { throw new Error("offline"); }) },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    };
    const cache = new LocalMailCache(native, crypto.randomUUID()); caches.push(cache);
    await cache.init(); cache.register([1, 2, 3, 4, 5, 6].map(header));
    await cache.warm({ inventory: false });
    expect(cache.status.phase).toBe("error");
    expect(cache.status.lastCompletedAt).toBeUndefined(); // three failures in a row stop the pass with emails untried
  });
  it("aren't asked for in Spam: Ember doesn't show it, and Gmail's often can't be fetched", async () => {
    const spam = { id: "spam", accountId: "a1", name: "Spam", path: "/[Gmail]/Spam", specialUse: ["junk"] };
    const native: any = {
      messages: { query: vi.fn(), continueList: vi.fn(), listAttachments: vi.fn(async () => []), getFull: vi.fn(async () => ({ contentType: "text/plain", body: "hi" })) },
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    };
    const cache = new LocalMailCache(native, crypto.randomUUID()); caches.push(cache);
    await cache.init(); cache.register([header(1), { ...header(2), folder: spam } as MessageHeader]);
    await cache.warm({ inventory: false });
    expect(native.messages.getFull.mock.calls.map(([id]: number[]) => id)).toEqual([1]);
    expect(cache.status).toMatchObject({ phase: "ready", total: 1, done: 1, failed: 0 });
  });
});
