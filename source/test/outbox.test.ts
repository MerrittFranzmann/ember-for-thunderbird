import "fake-indexeddb/auto";
import { describe, expect, it, vi } from "vitest";
import { countdown, queuedStatus, sendLaterChoices, sendTimeText, type QueuedEmail } from "../src/lib/outbox";
import { OutboxStore } from "../src/lib/outbox-store";
import { OutboxService } from "../src/lib/outbox-service";

const local = (y: number, m: number, d: number, h: number, min = 0) => +new Date(y, m - 1, d, h, min);
const email = (props: Partial<QueuedEmail> = {}): QueuedEmail => ({
  id: `q-${Math.random().toString(36).slice(2)}`, sendAt: Date.now() - 1000, queuedAt: Date.now() - 120000, kind: "undo", state: "waiting",
  subject: "Plan", to: ["Ada <ada@example.org>"], mode: "new", details: { to: ["Ada <ada@example.org>"], subject: "Plan", body: "<p>Hi</p>", isPlainText: false },
  followUp: 0, draft: { mode: "new", to: [{ name: "Ada", email: "ada@example.org" }], subject: "Plan", html: "<p>Hi</p>", files: [] }, ...props,
});
function native() {
  const set = vi.fn(async (_: any) => {});
  return {
    storage: { local: { set, get: vi.fn(async (defaults: any) => defaults) } },
    alarms: { create: vi.fn(async () => {}), clear: vi.fn(async () => true) },
    notifications: { create: vi.fn(async () => "") },
    messages: { sendMessage: vi.fn(async (_det: any, _opts: any) => ({ headerMessageId: "sent-1@example.org" })), query: vi.fn(async (_q: any) => ({ messages: [] as any[] })), delete: vi.fn(async () => {}) },
    compose: { beginNew: vi.fn(async () => ({ id: 10, windowId: 20 })), beginReply: vi.fn(async () => ({ id: 10, windowId: 20 })), beginForward: vi.fn(async () => ({ id: 10, windowId: 20 })), sendMessage: vi.fn(async () => ({ headerMessageId: "sent-2@example.org" })), setComposeDetails: vi.fn(async () => {}) },
    windows: { update: vi.fn(async () => ({})) }, tabs: { remove: vi.fn(async () => {}) },
  };
}
const fresh = (n: any) => new OutboxStore(n, new IDBFactory());

describe("send later times", () => {
  it("offers later today, this evening, tomorrow and Monday from a weekday morning", () => {
    const choices = sendLaterChoices(local(2026, 10, 28, 10, 5)); // Wednesday
    expect(choices.map((c) => c.label)).toEqual(["Later today", "This evening", "Tomorrow morning", "Tomorrow afternoon", "Monday morning"]);
    expect(choices[0].at).toBe(local(2026, 10, 28, 13, 15));
    expect(choices[1].at).toBe(local(2026, 10, 28, 18));
    expect(choices[2].at).toBe(local(2026, 10, 29, 8));
    expect(choices[4].at).toBe(local(2026, 11, 2, 8));
  });
  it("leaves out today's times in the evening, and Monday when that's tomorrow", () => {
    const choices = sendLaterChoices(local(2026, 11, 1, 20)); // Sunday evening
    expect(choices.map((c) => c.label)).toEqual(["Tomorrow morning", "Tomorrow afternoon"]);
  });
  it("describes when an email goes", () => {
    const now = local(2026, 10, 28, 10);
    expect(sendTimeText(local(2026, 10, 28, 18), now)).toMatch(/^Today, 6:00/);
    expect(sendTimeText(local(2026, 10, 29, 8), now)).toMatch(/^Tomorrow, 8:00/);
    expect(countdown(103000)).toBe("1:43");
    expect(countdown(-5)).toBe("0:00");
    expect(queuedStatus({ state: "waiting", kind: "undo", sendAt: now + 61000 }, now)).toBe("Sending in 1:01");
    expect(queuedStatus({ state: "waiting", kind: "later", sendAt: local(2026, 10, 29, 8) }, now)).toMatch(/^Sends tomorrow at 8:00/);
    expect(queuedStatus({ state: "failed", kind: "later", sendAt: now, error: "SMTP said no" }, now)).toBe("Couldn't send: SMTP said no");
  });
});

describe("the outbox store", () => {
  it("keeps emails with their attachments, soonest first, and says when it changed", async () => {
    const n = native(); const store = fresh(n);
    const file = new File(["report"], "report.pdf", { type: "application/pdf" });
    await store.put(email({ id: "b", sendAt: 2000 }));
    await store.put(email({ id: "a", sendAt: 1000, details: { attachments: [{ file, name: "report.pdf" }] } }));
    const all = await store.all();
    expect(all.map((e) => e.id)).toEqual(["a", "b"]);
    expect(all[0].details.attachments[0].name).toBe("report.pdf");
    expect(await (all[0].details.attachments[0].file as Blob).text()).toBe("report");
    expect(n.storage.local.set).toHaveBeenCalledWith({ outboxRev: expect.any(Number) });
  });
  it("never both sends an email and gives it back: claim and take exclude each other", async () => {
    const store = fresh(native());
    await store.put(email({ id: "x" }));
    expect(await store.claim("x")).toMatchObject({ id: "x", state: "sending" });
    expect(await store.take("x")).toBeNull();
    expect(await store.claim("x")).toBeNull();
    await store.put(email({ id: "y" }));
    expect(await store.take("y")).toMatchObject({ id: "y" });
    expect(await store.claim("y")).toBeNull();
    expect((await store.all()).map((e) => e.id)).toEqual(["x"]);
  });
  it("claims only emails whose time has come", async () => {
    const store = fresh(native());
    await store.put(email({ id: "later", sendAt: Date.now() + 60000 }));
    expect(await store.claim("later")).toBeNull();
  });
});

describe("the background outbox", () => {
  it("sends a due new email without a window, removes it and adds its follow-up reminder", async () => {
    const n = native(); const store = fresh(n); const followUp = vi.fn(async () => {});
    const service = new OutboxService(n, followUp, store);
    await store.put(email({ id: "e1", followUp: 3 }));
    await service.send("e1");
    expect(n.messages.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ subject: "Plan" }), { mode: "sendNow" });
    expect(n.compose.beginNew).not.toHaveBeenCalled();
    expect(await store.all()).toEqual([]);
    expect(followUp).toHaveBeenCalledWith(expect.objectContaining({ mid: "sent-1@example.org", subject: "Plan" }));
    expect(n.storage.local.set).toHaveBeenCalledWith({ outboxEvent: expect.objectContaining({ id: "e1", ok: true, text: expect.stringContaining("reminder in 3 days") }) });
  });
  it("sends a reply through Thunderbird's composer, finding the answered email again by Message-ID", async () => {
    const n = native(); const store = fresh(n);
    n.messages.query.mockResolvedValueOnce({ messages: [{ id: 99, headerMessageId: "orig@example.org", folder: { specialUse: ["archives"] } }] });
    const service = new OutboxService(n, vi.fn(), store);
    await store.put(email({ id: "r", mode: "replyAll", related: { id: 7, mid: "orig@example.org" } }));
    await service.send("r");
    expect(n.messages.query).toHaveBeenCalledWith({ headerMessageId: "orig@example.org" });
    expect(n.compose.beginReply).toHaveBeenCalledWith(99, "replyToAll", expect.objectContaining({ subject: "Plan" }));
    expect(n.windows.update).toHaveBeenCalledWith(20, { state: "minimized" });
    expect(n.compose.sendMessage).toHaveBeenCalledWith(10, { mode: "sendNow" });
    expect(await store.all()).toEqual([]);
  });
  it("sends a threaded draft from its Drafts copy, then deletes that draft", async () => {
    const n = native(); const store = fresh(n);
    n.messages.query.mockResolvedValueOnce({ messages: [{ id: 5, folder: { specialUse: ["sent"] } }, { id: 6, folder: { specialUse: ["drafts"] } }] });
    const service = new OutboxService(n, vi.fn(), store);
    await store.put(email({ id: "d", mode: "draft", threaded: true, related: { id: 3, mid: "draft@example.org" } }));
    await service.send("d");
    expect(n.compose.beginNew).toHaveBeenCalledWith(6, expect.anything());
    expect(n.messages.delete).toHaveBeenCalledWith([6], { deletePermanently: true });
  });
  it("deletes nothing when the draft's only copies left aren't in Drafts (a sent draft keeps its Message-ID)", async () => {
    const n = native(); const store = fresh(n);
    n.messages.query.mockResolvedValueOnce({ messages: [{ id: 5, folder: { specialUse: ["sent"] } }] });
    const service = new OutboxService(n, vi.fn(), store);
    await store.put(email({ id: "d", mode: "draft", threaded: true, related: { id: 3, mid: "draft@example.org" } }));
    await service.send("d");
    expect(n.messages.delete).not.toHaveBeenCalled();
  });
  it("keeps an email Thunderbird couldn't send, marked, with a notification", async () => {
    const n = native(); const store = fresh(n);
    n.messages.sendMessage.mockRejectedValueOnce(new Error("SMTP server refused"));
    const service = new OutboxService(n, vi.fn(), store);
    await store.put(email({ id: "f" }));
    await service.send("f");
    expect(await store.all()).toEqual([expect.objectContaining({ id: "f", state: "failed", error: "SMTP server refused" })]);
    expect(n.notifications.create).toHaveBeenCalledWith("spark-send:f", expect.objectContaining({ message: expect.stringContaining("SMTP server refused") }));
    // Try again sends it.
    await service.request({ action: "send-now", id: "f" });
    expect(n.messages.sendMessage).toHaveBeenCalledTimes(2);
    expect(await store.all()).toEqual([]);
  });
  it("won't forward without the forwarded email (its files would be missing)", async () => {
    const n = native(); const store = fresh(n);
    const service = new OutboxService(n, vi.fn(), store);
    await store.put(email({ id: "fw", mode: "forward", related: { id: 7, mid: "gone@example.org" } }));
    await service.send("fw");
    expect(n.compose.beginForward).not.toHaveBeenCalled();
    expect((await store.all())[0]).toMatchObject({ state: "failed" });
  });
  it("at start: never resends one cut off mid-send, sends the overdue, schedules the rest", async () => {
    const n = native(); const store = fresh(n);
    await store.put(email({ id: "cut", state: "sending" }));
    await store.put(email({ id: "due", sendAt: Date.now() - 5000 }));
    const at = Date.now() + 3600000;
    await store.put(email({ id: "later", kind: "later", sendAt: at }));
    const service = new OutboxService(n, vi.fn(), store);
    await service.start();
    await service.send("noop"); // waits for the queued sends
    const all = await store.all();
    expect(all.find((e) => e.id === "cut")).toMatchObject({ state: "failed", error: expect.stringContaining("Check Sent") });
    expect(all.find((e) => e.id === "due")).toBeUndefined();
    expect(n.messages.sendMessage).toHaveBeenCalledOnce();
    expect(n.alarms.create).toHaveBeenCalledWith("spark-send:later", { when: at });
    expect(await service.busy()).toBe(false);
    await store.put(email({ id: "soon", sendAt: Date.now() + 60000 }));
    expect(await service.busy()).toBe(true);
  });
  it("sends one email at a time, and a second alarm for the same email sends nothing", async () => {
    const n = native(); const store = fresh(n);
    let release!: () => void;
    n.messages.sendMessage.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ headerMessageId: "x@y" }); }));
    const service = new OutboxService(n, vi.fn(), store);
    await store.put(email({ id: "one" }));
    const first = service.send("one"); const again = service.send("one");
    await vi.waitFor(() => expect(n.messages.sendMessage).toHaveBeenCalledOnce());
    release(); await first; await again;
    expect(n.messages.sendMessage).toHaveBeenCalledOnce();
  });
});
