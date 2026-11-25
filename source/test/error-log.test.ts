import { describe, expect, it, vi } from "vitest";
import { ERROR_LIMIT, ErrorLog, errorLog, mergeErrors } from "../src/lib/error-log";
import { PerfRecorder } from "../src/lib/perf-recorder";

function memoryStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = structuredClone(initial);
  return { data, get: vi.fn(async (key: string) => ({ [key]: structuredClone(data[key]) })), set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(data, structuredClone(items)); }) };
}

describe("error log", () => {
  it("adds up repeats, keeps what other Ember pages saved, and survives a restart", async () => {
    let t = 1000;
    const storage = memoryStorage({ errorLog: [{ text: "background: quota", where: "background", count: 2, first: 10, last: 20 }] });
    const log = new ErrorLog(() => storage, "window", () => t);
    log.add("storage.local.set: DataCloneError", "at save");
    t = 2000; log.add("storage.local.set: DataCloneError");
    t = 3000; log.add("toast: Couldn't move the email");
    const entries = await log.read();
    expect(entries.map((e) => e.text)).toEqual(["toast: Couldn't move the email", "storage.local.set: DataCloneError", "background: quota"]);
    expect(entries[1]).toMatchObject({ where: "window", count: 2, first: 1000, last: 2000, stack: "at save" });

    t = 4000;
    const restarted = new ErrorLog(() => storage, "window", () => t);
    restarted.add("storage.local.set: DataCloneError");
    expect((await restarted.read()).find((e) => e.text.startsWith("storage"))).toMatchObject({ count: 3, first: 1000, last: 4000 });
  });

  it("keeps the newest ERROR_LIMIT distinct failures", () => {
    const many = Array.from({ length: ERROR_LIMIT + 5 }, (_, i) => ({ text: `e${i}`, where: "window", count: 1, first: i, last: i }));
    const merged = mergeErrors([], many);
    expect(merged).toHaveLength(ERROR_LIMIT);
    expect(merged[0].text).toBe(`e${ERROR_LIMIT + 4}`);
    expect(merged.some((e) => e.text === "e0")).toBe(false);
  });

  it("a failed save is dropped quietly (it can't be logged anywhere)", async () => {
    const log = new ErrorLog(() => ({ get: async () => ({}), set: async () => { throw new Error("quota"); } }), "window");
    log.add("x");
    await expect(log.flush()).resolves.toBeUndefined();
  });

  it("the performance recorder sends failures to the log even when it's off, and watches script errors", async () => {
    const add = vi.spyOn(errorLog, "add").mockImplementation(() => {});
    const perf = new PerfRecorder();
    perf.setEnabled(false);
    perf.record("error", { text: "list: boom", stack: "at List" });
    perf.record("frame", { ms: 200 });
    expect(add).toHaveBeenCalledWith("list: boom", "at List");

    const target = new EventTarget();
    perf.watchErrors(target);
    perf.watchErrors(target);
    const rejection = new Event("unhandledrejection") as any;
    rejection.reason = new Error("background: not ready");
    target.dispatchEvent(rejection);
    expect(add).toHaveBeenCalledTimes(2);
    expect(add.mock.calls[1][0]).toBe("background: not ready");
    add.mockRestore();
  });
});
