import { afterEach, describe, expect, it, vi } from "vitest";
import { CacheClient } from "../src/lib/cache-client";
import { CACHE_CHANNEL } from "../src/lib/cache-channel";

// A stand-in background on the real (Node) BroadcastChannel: answers pings, and read requests unless `silent`.
function background(answer: (message: any) => any) {
  const channel = new BroadcastChannel(CACHE_CHANNEL);
  const state = { silent: false, requests: [] as any[] };
  channel.onmessage = (event: MessageEvent) => {
    const data = event.data;
    if (data?.kind === "ping") channel.postMessage({ kind: "pong", to: data.from });
    if (data?.kind === "request" && !state.silent) { state.requests.push(data.message); channel.postMessage({ kind: "response", id: data.id, response: { ok: true, value: answer(data.message) } }); }
  };
  return { state, close: () => channel.close() };
}
const status = { phase: "ready", total: 0, done: 0, failed: 0, saved: 0 };
const page = (headers: any[] = []) => ({ epoch: "e", revision: 1, reset: true, headers, removed: [], next: null, status });
const native = () => ({
  runtime: { sendMessage: vi.fn(async (message: any) => ({ ok: true, value: message.command === "snapshot" || message.command === "changes" ? page() : undefined })), onMessage: { addListener: vi.fn() }, connect: vi.fn(() => ({ disconnect: vi.fn() })) },
  storage: { onChanged: { addListener: vi.fn() } },
});
let cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); vi.useRealTimers(); });

describe("cache reads over the direct channel", () => {
  it("uses runtime messaging until the background answers a ping, then the channel", async () => {
    const bg = background((m) => (m.command === "headersFor" ? [{ id: -1, subject: "via channel" }] : page()));
    cleanup.push(bg.close);
    const api = native();
    const client = new CacheClient(api);
    await client.init(); // first snapshot: runtime messaging, and a ping goes out
    expect(api.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ command: "snapshot" }));
    await vi.waitFor(() => expect((client as any).direct).toBe(true));
    api.runtime.sendMessage.mockClear();
    const value = await (client as any).call("headersFor", { keys: ["k"] });
    expect(value).toEqual([{ id: -1, subject: "via channel" }]);
    expect(api.runtime.sendMessage).not.toHaveBeenCalled();
    expect(bg.state.requests.at(-1)).toMatchObject({ type: "spark:cache", command: "headersFor" });
  });
  it("never sends changes (non-read requests) over the channel", async () => {
    const bg = background(() => page());
    cleanup.push(bg.close);
    const api = native();
    const client = new CacheClient(api);
    await client.init();
    await vi.waitFor(() => expect((client as any).direct).toBe(true));
    await (client as any).call("refresh");
    expect(api.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ command: "refresh" }));
    expect(bg.state.requests.some((m) => m.command === "refresh")).toBe(false);
  });
  it("falls back to runtime messaging when the channel doesn't answer (background restarting)", async () => {
    const bg = background(() => page());
    cleanup.push(bg.close);
    const api = native();
    const client = new CacheClient(api);
    await client.init();
    await vi.waitFor(() => expect((client as any).direct).toBe(true));
    bg.state.silent = true;
    vi.useFakeTimers();
    api.runtime.sendMessage.mockClear();
    const pending = (client as any).call("headersFor", { keys: ["k"] });
    await vi.advanceTimersByTimeAsync(6100);
    await pending;
    expect(api.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ command: "headersFor" }));
    expect((client as any).direct).toBe(false);
  });
  it("keeps the channel when a slow body fetch answers on it after the timeout, before the slow way", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const channel = new BroadcastChannel(CACHE_CHANNEL);
    channel.onmessage = async (event: MessageEvent) => {
      const data = event.data;
      if (data?.kind === "ping") channel.postMessage({ kind: "pong", to: data.from });
      if (data?.kind === "request") { if (data.message.command === "message") await gate; channel.postMessage({ kind: "response", id: data.id, response: { ok: true, value: data.message.command === "message" ? { full: "body", atts: [] } : page() } }); }
    };
    cleanup.push(() => channel.close());
    const api = native();
    const client = new CacheClient(api);
    await client.init();
    await vi.waitFor(() => expect((client as any).direct).toBe(true));
    vi.useFakeTimers();
    let slowAnswer!: (value: any) => void;
    api.runtime.sendMessage.mockImplementation(() => new Promise((r) => { slowAnswer = r; })); // the slow way is slower still
    const pending = (client as any).call("message", { ref: { id: 5 } });
    await vi.advanceTimersByTimeAsync(6100); // an email downloading from the server: past the timeout
    expect(api.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ command: "message" }));
    vi.useRealTimers();
    release(); // the channel answers first
    expect(await pending).toEqual({ full: "body", atts: [] });
    slowAnswer({ ok: true, value: { full: "late", atts: [] } });
    expect((client as any).direct).toBe(true);
  });
  it("works without any background on the channel (unit tests, older backgrounds): no waiting", async () => {
    const api = native();
    const client = new CacheClient(api);
    const started = Date.now();
    await client.init();
    await (client as any).call("headersFor", { keys: ["k"] });
    expect(Date.now() - started).toBeLessThan(500);
  });
});
