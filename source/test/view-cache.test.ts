import { afterEach, describe, expect, it, vi } from "vitest";
import { datasetKey, navigationKey, ViewCache } from "../src/lib/view-cache";
import type { MessageHeader, View } from "../src/lib/types";
const header = (id: number) => ({ id, flagged: true, read: false } as MessageHeader);
const folder = (id: string): View => ({ kind: "folder", folderId: id });
afterEach(() => vi.useRealTimers());

describe("mailbox cache", () => {
  it("shares Smart Inbox data without sharing each category's scroll position", () => {
    expect(datasetKey({ kind: "smart" })).toBe(datasetKey({ kind: "category", cat: "notification" }));
    expect(navigationKey({ kind: "smart" })).not.toBe(navigationKey({ kind: "category", cat: "notification" }));
    expect(datasetKey({ kind: "mailbox", role: "sent", accountId: "one" })).not.toBe(datasetKey({ kind: "mailbox", role: "sent", accountId: "two" }));
    expect(datasetKey({ kind: "pinned", accountId: "one" })).not.toBe(datasetKey({ kind: "pinned" }));
  });
  it("preserves empty inboxes and copies collections", () => {
    const cache = new ViewCache();
    const headers = new Map<number, MessageHeader>();
    cache.put(folder("one"), headers, new Set(["one"]), new Set());
    headers.set(1, header(1));
    expect(cache.get(folder("one"))?.headers.size).toBe(0);
    expect(cache.needsRefresh(cache.get(folder("one"))!)).toBe(false);
  });
  it("refreshes stale snapshots and bounds memory by least-recent use", () => {
    vi.useFakeTimers();
    const cache = new ViewCache(2, 1000);
    for (const id of ["one", "two"]) cache.put(folder(id), new Map(), new Set(), new Set());
    const one = cache.get(folder("one"))!;
    cache.put(folder("three"), new Map(), new Set(), new Set());
    expect(cache.get(folder("two"))).toBeUndefined();
    vi.advanceTimersByTime(1000);
    expect(cache.needsRefresh(one)).toBe(true);
  });
  it("patches read state and prevents deleted/unpinned mail from reappearing", () => {
    const cache = new ViewCache();
    const message = header(1);
    cache.put(folder("one"), new Map([[1, message]]), new Set(), new Set());
    cache.put({ kind: "pinned" }, new Map([[1, { ...message }]]), new Set(), new Set());
    cache.update(message, { read: true, flagged: false });
    expect(cache.get(folder("one"))?.headers.get(1)?.read).toBe(true);
    expect(cache.get({ kind: "pinned" })?.headers.size).toBe(0);
    cache.remove([1]);
    const snapshot = cache.get(folder("one"))!;
    expect(snapshot.headers.size).toBe(0);
    expect(cache.needsRefresh(snapshot)).toBe(true);
  });
});
