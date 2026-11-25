import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageHeader } from "../src/lib/types";
const native = vi.hoisted(() => ({ messages: { getFull: vi.fn(async (_id: number) => ({ contentType: "text/plain", body: "Preview" })) } }));
vi.mock("../src/lib/api", () => ({ api: native, env: { hasGetHeaders: false }, mailCache: { body: vi.fn() } }));
import { MetaCache } from "../src/lib/meta";
const header = (id: number) => ({ id, headerMessageId: `preview-${id}`, author: "Ada <ada@example.org>", subject: "Plan", date: new Date() }) as MessageHeader;
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe("preview work while scrolling", () => {
  it("batches metadata arriving during a gesture until the final priority hold releases", async () => {
    const meta = new MetaCache(); const notify = vi.fn(); meta.onChange = notify;
    const releaseScroll = meta.hold(), releaseReader = meta.hold();
    meta.put(header(1), { cat: "people", lvl: "f", snippet: "Finished in flight" });
    await vi.advanceTimersByTimeAsync(121); expect(notify).not.toHaveBeenCalled();
    meta.put(header(2), { cat: "notification", lvl: "h" });
    await vi.advanceTimersByTimeAsync(1); expect(notify).not.toHaveBeenCalled();
    releaseScroll(); expect(notify).not.toHaveBeenCalled();
    releaseReader(); expect(notify).toHaveBeenCalledExactlyOnceWith(true, true);
    expect(meta.get(header(1))?.snippet).toBe("Finished in flight");
    releaseReader(); expect(notify).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(200); expect(notify).toHaveBeenCalledOnce();
  });
  it("distinguishes snippet-only updates from changes that affect grouping or badges", async () => {
    const meta = new MetaCache(); const notify = vi.fn(); meta.onChange = notify;
    const m = header(1); const base = { cat: "people" as const, refs: ["parent"], hasAtt: false, lvl: "h" as const };
    meta.put(m, base); await vi.advanceTimersByTimeAsync(121); expect(notify).toHaveBeenLastCalledWith(true, true);
    meta.put(m, { ...base, snippet: "A new preview", lvl: "f" }); await vi.advanceTimersByTimeAsync(121); expect(notify).toHaveBeenLastCalledWith(false, false);
    meta.put(m, { ...base, refs: ["different-parent"] }); await vi.advanceTimersByTimeAsync(121); expect(notify).toHaveBeenLastCalledWith(true, true);
    meta.put(m, { ...base, cat: "newsletter" }); await vi.advanceTimersByTimeAsync(121); expect(notify).toHaveBeenLastCalledWith(true, true);
    // An attachment flag (often corrected when an email is opened) changes list badges, not threading.
    meta.put(m, { ...base, cat: "newsletter", hasAtt: true }); await vi.advanceTimersByTimeAsync(121); expect(notify).toHaveBeenLastCalledWith(true, false);
  });
  it("retains a grouping change when several updates share a notification batch", async () => {
    const meta = new MetaCache(); const notify = vi.fn(); meta.onChange = notify;
    meta.put(header(1), { cat: "people", lvl: "h" }); await vi.advanceTimersByTimeAsync(121); notify.mockClear();
    meta.put(header(2), { cat: "newsletter", lvl: "h" });
    meta.put(header(1), { cat: "people", lvl: "f", snippet: "Only text changed" });
    await vi.advanceTimersByTimeAsync(121); expect(notify).toHaveBeenCalledExactlyOnceWith(true, true);
  });
  it("discards offscreen preview jobs while retaining selected-message and background work", async () => {
    const meta = new MetaCache(); const release = meta.hold();
    meta.request(header(1), "f", 0); meta.request(header(2), "f", 0);
    meta.request(header(3), "f", 1); meta.request(header(4), "h", 2);
    meta.clearVisible(); expect(meta.pending).toBe(2);
    meta.request(header(5), "f", 0); release(); await vi.advanceTimersByTimeAsync(1);
    expect(native.messages.getFull.mock.calls.map(([id]) => id).sort()).toEqual([3, 4, 5]);
    expect(meta.pending).toBe(0);
  });
});
