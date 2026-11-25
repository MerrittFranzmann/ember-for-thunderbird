import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  const api = {
    runtime: { sendMessage: vi.fn(async (_m: any) => undefined) },
    storage: { local: { set: vi.fn(async () => {}) }, onChanged: { addListener: vi.fn() } },
    permissions: { request: vi.fn(async () => true) },
    messages: { sendMessage: vi.fn(async () => ({})), saveMessage: vi.fn(async () => ({})), delete: vi.fn(), query: vi.fn(async (_q: any) => ({ messages: [] as any[] })), get: vi.fn(async (id: number) => ({ id, headerMessageId: `orig-${id}@example.org`, author: "Ada <ada@example.org>", subject: "Plan", recipients: ["me@example.org"], ccList: [], bccList: [], date: new Date(), folder: { accountId: "work" } })), getFull: vi.fn(async () => ({ contentType: "text/plain", body: "Original", headers: {} })) },
    compose: { beginNew: vi.fn(), beginReply: vi.fn(), beginForward: vi.fn(), sendMessage: vi.fn(), saveMessage: vi.fn(), setComposeDetails: vi.fn() },
    windows: { update: vi.fn() }, tabs: { remove: vi.fn() },
  };
  const undo: { label: string; run: () => Promise<unknown> }[] = [];
  const store = {
    settings: { minimizeCompose: true, undoSend: 120, signatures: [] as any[] }, identities: [{ id: "identity", accountId: "work", name: "Me", email: "me@example.org" }],
    me: new Set(["me@example.org"]), toast: vi.fn(), threadPeople: () => [], foldersForRole: () => [], roleOfFolder: () => null,
    rememberUndo: vi.fn((label: string, run: () => Promise<unknown>) => { undo.push({ label, run }); return () => void run(); }),
  };
  return { api, store, undo };
});
vi.mock("../src/lib/api", () => ({ api: mocks.api, env: { tb: 158, hasBackgroundSend: true, hasBackgroundSave: true, hasUserAction: true } }));
vi.mock("../src/lib/store.svelte", () => ({ store: mocks.store }));
import { composer } from "../src/lib/compose.svelte";
import { OutboxStore } from "../src/lib/outbox-store";

const to = [{ name: "Recipient", email: "recipient@example.org" }];
const outbox = new OutboxStore(mocks.api);
beforeEach(async () => {
  vi.clearAllMocks(); mocks.undo.length = 0; mocks.store.settings.undoSend = 120;
  composer.close(); composer.getEditorHtml = () => "<p>Test content</p><div class=\"moz-signature\">-- <br>Edited sig</div>";
  for (const e of await outbox.all()) await outbox.remove(e.id);
});

describe("undo send and send later", () => {
  it("puts a sent email in the outbox for two minutes instead of sending it, with Undo", async () => {
    composer.openNew(to); composer.draft!.subject = "A plan"; composer.draft!.followUp = 3;
    const before = Date.now();
    expect(await composer.send()).toBe(true);
    expect(mocks.api.messages.sendMessage).not.toHaveBeenCalled();
    expect(composer.open).toBe(false);
    const [queued] = await outbox.all();
    expect(queued).toMatchObject({ kind: "undo", state: "waiting", subject: "A plan", to: ["Recipient <recipient@example.org>"], mode: "new", followUp: 3 });
    expect(queued.sendAt).toBeGreaterThanOrEqual(before + 120000);
    expect(queued.details).toMatchObject({ subject: "A plan", body: expect.stringContaining("Test content") });
    expect(mocks.api.runtime.sendMessage).toHaveBeenCalledWith({ type: "spark:outbox", action: "schedule" });
    expect(mocks.store.toast).toHaveBeenCalledWith(expect.objectContaining({ text: "Sending in 2 min", action: expect.objectContaining({ label: "Undo" }) }));
    expect(mocks.undo[0].label).toBe("Send");
  });
  it("Undo puts the email back in the composer as written (signature included), and closing it asks first", async () => {
    await composer.openReply(7, false);
    composer.draft!.followUp = 2;
    expect(await composer.send()).toBe(true);
    const [queued] = await outbox.all();
    expect(queued.related).toEqual({ id: 7, mid: "orig-7@example.org" });
    mocks.api.messages.query.mockResolvedValueOnce({ messages: [{ id: 70, headerMessageId: "orig-7@example.org" }] });
    expect(await composer.takeBack(queued.id)).toBe(true);
    expect(await outbox.all()).toEqual([]);
    expect(composer.draft).toMatchObject({ mode: "reply", relatedId: 70, subject: "Re: Plan", followUp: 2, restored: true, keepSignature: true });
    expect(composer.draft!.html).toContain("Edited sig");
    expect(composer.draft!.quoteHtml).toContain("Original");
  });
  it("Undo is too late once the background is sending it", async () => {
    composer.openNew(to);
    await composer.send();
    const [queued] = await outbox.all();
    await outbox.update(queued.id, { state: "sending" });
    expect(await composer.takeBack(queued.id)).toBe(false);
    expect(composer.open).toBe(false);
    expect(mocks.store.toast).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining("Too late") }));
  });
  it("sends right away when Undo send is off", async () => {
    mocks.store.settings.undoSend = 0;
    composer.openNew(to);
    expect(await composer.send()).toBe(true);
    expect(mocks.api.messages.sendMessage).toHaveBeenCalledOnce();
    expect(await outbox.all()).toEqual([]);
  });
  it("Send later schedules the email for the chosen time, even with Undo send off", async () => {
    mocks.store.settings.undoSend = 0;
    const at = Date.now() + 86400000;
    composer.openNew(to);
    expect(await composer.send(false, at)).toBe(true);
    expect(mocks.api.messages.sendMessage).not.toHaveBeenCalled();
    expect(await outbox.all()).toEqual([expect.objectContaining({ kind: "later", sendAt: at })]);
    expect(mocks.undo[0].label).toBe("Send later");
  });
});
