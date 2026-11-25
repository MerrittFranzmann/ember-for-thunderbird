import { afterEach, describe, expect, it, vi } from "vitest";
import { collectAttachments } from "../src/lib/attachments";
import { withDeadline } from "../src/lib/async";
import type { MessageHeader } from "../src/lib/types";
const messages = [1, 2, 3, 4, 5].map((id) => ({ id } as MessageHeader));
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("stalled attachment recovery", () => {
  it("ends when both server streams hang, defers remaining messages and starts no more requests", async () => {
    vi.useFakeTimers();
    const list = vi.fn(() => new Promise<never>(() => {}));
    const failures: number[] = [];
    let deferred = 0;
    const scan = collectAttachments(messages, { list, active: () => true, timeoutMs: 100, onMessage: () => {}, onError: (message) => failures.push(message.id), onDeferred: (count) => deferred = count });
    await vi.advanceTimersByTimeAsync(101);
    await scan;
    expect(list).toHaveBeenCalledTimes(2);
    expect(failures).toEqual([1, 2]);
    expect(deferred).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("delivers completed files before a slow stream ends and stops immediately when requested", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const delivered: number[] = [];
    const scan = collectAttachments(messages, { active: () => true, signal: controller.signal, list: async (id) => { if (id !== 1) return new Promise<never>(() => {}); return [{ name: "file.pdf", contentType: "application/pdf", size: 1, partName: "1.2" }]; }, onMessage: (message) => delivered.push(message.id), onError: () => { throw new Error("Canceled work must not be reported as a server failure"); } });
    await vi.advanceTimersByTimeAsync(1);
    expect(delivered).toEqual([1]);
    controller.abort();
    await scan;
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds a hung query and handles a late rejection without an unhandled error", async () => {
    vi.useFakeTimers();
    let rejectWork!: (error: Error) => void;
    const work = new Promise<never>((_, reject) => rejectWork = reject);
    const checked = expect(withDeadline(work, 50, undefined, "Finding files")).rejects.toThrow("took too long");
    await vi.advanceTimersByTimeAsync(51);
    await checked;
    rejectWork(new Error("Late server failure"));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
});
