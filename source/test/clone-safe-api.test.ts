import { afterEach, describe, expect, it, vi } from "vitest";

// What Svelte's $state hands out: proxies of plain objects and arrays, which structured cloning refuses.
const reactive = <T extends object>(value: T): T => new Proxy(value, {});

afterEach(() => { delete (globalThis as any).messenger; vi.resetModules(); });

async function load(native: any) {
  (globalThis as any).messenger = native;
  vi.resetModules();
  return import("../src/lib/api");
}

describe("values Ember saves or sends are plain (structured cloning refuses reactive proxies)", () => {
  it("copies plain objects and arrays, nested, and keeps everything else as it is", async () => {
    const { plain } = await load(undefined);
    const date = new Date(0);
    const blob = new Blob(["x"]);
    const value = reactive({ path: "/tmp/a.sock", list: reactive([reactive({ a: 1 }), 2]), date, blob, none: null });
    expect(() => structuredClone(value)).toThrow();
    const copy = plain(value);
    expect(() => structuredClone(copy)).not.toThrow();
    expect(copy).toEqual({ path: "/tmp/a.sock", list: [{ a: 1 }, 2], date, blob, none: null });
    expect(copy.date).toBe(date);
    expect(copy.blob).toBe(blob);
    const cyclic: any = { name: "loop" }; cyclic.self = cyclic;
    const loop = plain(cyclic);
    expect(loop.self).toBe(loop);
  });

  it("storage.local.set and runtime.sendMessage get plain copies; a failed save is logged, then thrown", async () => {
    const set = vi.fn(async (items: any) => { structuredClone(items); });
    const sendMessage = vi.fn(async (message: any) => { structuredClone(message); return "ok"; });
    const native = { messages: {}, storage: { local: { set, get: vi.fn(async () => ({})) } }, runtime: { sendMessage, getURL: (p: string) => `moz-extension://x/${p}` } };
    const { api } = await load(native);
    const { perf } = await import("../src/lib/perf-recorder");
    await api.storage.local.set({ agentStatus: reactive({ path: "/tmp/a.sock" }) });
    expect(set).toHaveBeenCalledWith({ agentStatus: { path: "/tmp/a.sock" } });
    expect(await api.runtime.sendMessage(reactive({ type: "spark:settings", list: reactive([1]) }))).toBe("ok");
    expect(api.runtime.getURL("app.html")).toBe("moz-extension://x/app.html");
    const record = vi.spyOn(perf, "record");
    set.mockRejectedValueOnce(new Error("quota exceeded"));
    await expect(api.storage.local.set({ big: 1 })).rejects.toThrow("quota exceeded");
    expect(record).toHaveBeenCalledWith("error", { text: "storage.local.set: quota exceeded" });
    // No page listening is normal for a message: not logged.
    record.mockClear();
    sendMessage.mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."));
    await expect(api.runtime.sendMessage({ type: "x" })).rejects.toThrow();
    expect(record).not.toHaveBeenCalledWith("error", expect.anything());
  });
});
