import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageLoader } from "../src/lib/message-loader";
import { MemoryCache } from "../src/lib/memory-cache";
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; };
afterEach(() => vi.useRealTimers());
describe("progressive message loading", () => {
  it("publishes the body and releases foreground priority while attachment metadata is still pending", async () => {
    const files = deferred<any[]>(); const release = vi.fn(); const onBody = vi.fn();
    const full = { body: "Readable immediately" };
    const api = { messages: { getFull: vi.fn(async () => full), listAttachments: vi.fn(() => files.promise) } };
    const loader = new MessageLoader(() => release);
    const loaded = loader.load(api, 1, onBody);
    await vi.waitFor(() => expect(onBody).toHaveBeenCalledWith({ full, atts: [], attachmentsPending: true }));
    expect(release).toHaveBeenCalledOnce();
    files.resolve([{ name: "agenda.pdf" }]);
    expect((await loaded).atts).toEqual([{ name: "agenda.pdf" }]);
    const reopened = vi.fn(); await loader.load(api, 1, reopened);
    expect(reopened.mock.calls[0][0].attachmentsPending).toBe(false);
    expect(api.messages.getFull).toHaveBeenCalledOnce(); expect(api.messages.listAttachments).toHaveBeenCalledOnce();
  });
  it("keeps text available when attachment discovery times out, and allows an explicit retry", async () => {
    vi.useFakeTimers();
    const full = { body: "Still readable" }; const onBody = vi.fn();
    const api = { messages: { getFull: vi.fn(async () => full), listAttachments: vi.fn(() => new Promise(() => {})) } };
    const loader = new MessageLoader(); const result = loader.load(api, 2, onBody);
    await vi.advanceTimersByTimeAsync(1); expect(onBody).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15000);
    expect(await result).toMatchObject({ full, atts: [], attachmentError: expect.any(String) });
    loader.forget(2); api.messages.listAttachments.mockImplementation(async () => []);
    await loader.load(api, 2); expect(api.messages.getFull).toHaveBeenCalledTimes(2);
  });
  it("shares body prefetch with the reader instead of downloading twice", async () => {
    const body = deferred<any>(); const api = { messages: { getFull: vi.fn(() => body.promise), listAttachments: vi.fn(async () => []) } };
    const loader = new MessageLoader(); const prefetch = loader.body(api, 3); const read = loader.load(api, 3);
    body.resolve({ body: "Shared" }); await Promise.all([prefetch, read]);
    expect(api.messages.getFull).toHaveBeenCalledOnce();
  });
});
describe("bounded session cache", () => {
  it("evicts least recently used entries and respects the byte limit", () => {
    const cache = new MemoryCache<string>(2, 6, value => value.length);
    cache.set("a", "aaa"); cache.set("b", "bb"); expect(cache.get("a")).toBe("aaa");
    cache.set("c", "ccc"); expect(cache.get("b")).toBeUndefined();
    cache.set("huge", "1234567"); expect(cache.get("huge")).toBeUndefined(); expect(cache.get("a")).toBe("aaa");
    cache.delete("a"); cache.set("d", "ddd"); expect(cache.get("d")).toBe("ddd");
  });
});
