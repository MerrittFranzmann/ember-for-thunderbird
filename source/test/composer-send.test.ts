import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  const state = { tb: 158, background: true };
  const api = {
    permissions: { request: vi.fn(async () => { state.background = true; return true; }) },
    messages: { sendMessage: vi.fn(async () => ({})), saveMessage: vi.fn(async () => ({})), delete: vi.fn(), query: vi.fn(async () => ({ messages: [] })), get: vi.fn(async () => ({ id: 7, author: "Ada <ada@example.org>", subject: "Plan", recipients: ["me@example.org"], ccList: [], bccList: [], date: new Date(), folder: { accountId: "work" } })), getFull: vi.fn(async () => ({ contentType: "text/plain", body: "Original", headers: {} })) },
    compose: { beginNew: vi.fn(async () => ({ id: 10, windowId: 20 })), beginReply: vi.fn(async () => ({ id: 10, windowId: 20 })), beginForward: vi.fn(async () => ({ id: 10, windowId: 20 })), sendMessage: vi.fn(async () => ({})), saveMessage: vi.fn(async () => ({})), setComposeDetails: vi.fn(async () => {}) },
    windows: { update: vi.fn(async () => ({})) }, tabs: { remove: vi.fn(async () => {}) },
  };
  const store = { settings: { minimizeCompose: true }, identities: [{ id: "identity", accountId: "work", name: "Me", email: "me@example.org" }], me: new Set(["me@example.org"]), toast: vi.fn(), threadPeople: () => [], foldersForRole: () => [{ id: "drafts", name: "Drafts" }], roleOfFolder: (id?: string) => (id === "drafts" ? "drafts" : undefined), signatures: [] };
  return { state, api, store };
});
vi.mock("../src/lib/api", () => ({ api: mocks.api, env: { get tb() { return mocks.state.tb; }, get hasBackgroundSend() { return mocks.state.background; }, hasBackgroundSave: true, hasUserAction: true } }));
vi.mock("../src/lib/store.svelte", () => ({ store: mocks.store }));
import { composer } from "../src/lib/compose.svelte";
import { sendSettings } from "../src/lib/send-settings.svelte";
const to = [{ name: "Recipient", email: "recipient@example.org" }];
beforeEach(() => { vi.clearAllMocks(); mocks.state.tb = 158; mocks.state.background = true; composer.close(); composer.getEditorHtml = () => "<p>Test content</p>"; mocks.api.permissions.request.mockImplementation(async () => { mocks.state.background = true; return true; }); mocks.api.windows.update.mockResolvedValue({}); mocks.api.messages.sendMessage.mockResolvedValue({}); mocks.api.compose.sendMessage.mockResolvedValue({}); });
describe("sending without unnecessary Thunderbird windows", () => {
  it("sends new mail once through the background API without creating a native window", async () => {
    composer.openNew(to); composer.draft!.subject = "A plan";
    expect(await composer.send()).toBe(true);
    expect(mocks.api.messages.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ identityId: "identity", to: ["Recipient <recipient@example.org>"], subject: "A plan", body: expect.stringContaining("Test content") }), { mode: "sendNow" });
    expect(mocks.api.compose.beginNew).not.toHaveBeenCalled(); expect(mocks.api.windows.update).not.toHaveBeenCalled();
  });
  it("requests the optional-only permission before sending and avoids silent native fallback on denial", async () => {
    mocks.state.background = false; mocks.api.permissions.request.mockResolvedValueOnce(false);
    composer.openNew(to); const draft = composer.draft;
    expect(await composer.send()).toBe(false); expect(composer.draft).toBe(draft); expect(composer.open).toBe(true); expect(composer.busy).toBe("");
    expect(mocks.api.permissions.request).toHaveBeenCalledWith({ permissions: ["messages.send"] });
    expect(mocks.api.messages.sendMessage).not.toHaveBeenCalled(); expect(mocks.api.compose.beginNew).not.toHaveBeenCalled();
    expect(await composer.send()).toBe(true); expect(mocks.api.messages.sendMessage).toHaveBeenCalledOnce();
  });
  it("preserves the draft if the permission request fails", async () => {
    mocks.state.background = false; mocks.api.permissions.request.mockRejectedValueOnce(new Error("permission unavailable"));
    composer.openNew(to); expect(await composer.send()).toBe(false);
    expect(composer.error).toContain("permission unavailable"); expect(composer.draft).not.toBeNull(); expect(mocks.api.compose.beginNew).not.toHaveBeenCalled();
  });
  it("does not send a draft closed while permission approval is pending", async () => {
    mocks.state.background = false; let grant!: (ok: boolean) => void;
    mocks.api.permissions.request.mockImplementationOnce(() => new Promise(resolve => grant = resolve));
    composer.openNew(to); const send = composer.send(); composer.close(); mocks.state.background = true; grant(true);
    expect(await send).toBe(false); expect(mocks.api.messages.sendMessage).not.toHaveBeenCalled();
  });
  it("waits for the owned reply window to be minimized before sending, preserving native threading", async () => {
    let minimized!: () => void; mocks.api.windows.update.mockImplementationOnce(() => new Promise(resolve => minimized = () => resolve({})));
    await composer.openReply(7, true); const send = composer.send();
    await vi.waitFor(() => expect(mocks.api.windows.update).toHaveBeenCalledWith(20, { state: "minimized" }));
    expect(mocks.api.compose.sendMessage).not.toHaveBeenCalled(); minimized(); expect(await send).toBe(true);
    expect(mocks.api.compose.beginReply).toHaveBeenCalledWith(7, "replyToAll", expect.objectContaining({ subject: "Re: Plan" }));
    expect(mocks.api.compose.sendMessage).toHaveBeenCalledExactlyOnceWith(10, { mode: "sendNow" }); expect(mocks.api.messages.sendMessage).not.toHaveBeenCalled();
  });
  it("uses native forwarding so original attachments remain included", async () => {
    await composer.openForward(7); composer.draft!.to = to; expect(await composer.send()).toBe(true);
    expect(mocks.api.compose.beginForward).toHaveBeenCalledWith(7, "forwardInline", expect.objectContaining({ subject: "Fwd: Plan" }));
    expect(mocks.api.compose.sendMessage).toHaveBeenCalledOnce();
  });
  it("prevents duplicate sends and retains the user's content after a transport failure", async () => {
    let fail!: (reason: Error) => void; mocks.api.messages.sendMessage.mockImplementationOnce(() => new Promise((_, reject) => fail = reject));
    composer.openNew(to); const send = composer.send(); expect(await composer.send()).toBe(false);
    await vi.waitFor(() => expect(mocks.api.messages.sendMessage).toHaveBeenCalled()); expect(await composer.send()).toBe(false);
    fail(new Error("SMTP rejected")); expect(await send).toBe(false); expect(composer.open).toBe(true); expect(composer.draft!.to).toEqual(to); expect(composer.error).toContain("SMTP rejected"); expect(mocks.api.messages.sendMessage).toHaveBeenCalledOnce();
  });
  it("keeps a reply draft a threaded reply: its own Re: subject, sent through Thunderbird's composer", async () => {
    mocks.api.messages.getFull.mockResolvedValueOnce({ contentType: "text/plain", body: "Draft text", headers: { subject: ["Re: Plan"], "in-reply-to": ["<plan@example.org>"] } } as any);
    await composer.openDraft(7);
    mocks.api.messages.get.mockResolvedValueOnce({ id: 7, folder: { id: "drafts", accountId: "work" } } as any);
    expect(mocks.store.toast.mock.calls).toEqual([]);
    expect(composer.draft).toMatchObject({ mode: "draft", subject: "Re: Plan", threaded: true });
    composer.draft!.to = to;
    expect(await composer.send()).toBe(true);
    expect(mocks.api.compose.beginNew).toHaveBeenCalledWith(7, expect.objectContaining({ subject: "Re: Plan" }));
    expect(mocks.api.compose.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.api.messages.sendMessage).not.toHaveBeenCalled();
    expect(mocks.api.messages.delete).toHaveBeenCalledWith([7], expect.anything()); // the old draft
  });
  it("deletes only a message in Drafts after sending a draft, never the email it answers", async () => {
    mocks.api.messages.getFull.mockResolvedValueOnce({ contentType: "text/plain", body: "Draft text", headers: { subject: ["Re: Plan"], "in-reply-to": ["<plan@example.org>"] } } as any);
    await composer.openDraft(7);
    composer.draft!.to = to;
    expect(await composer.send()).toBe(true); // id 7 is in the work account's Inbox here (the default get)
    expect(mocks.api.messages.delete).not.toHaveBeenCalled();
  });
  it("still sends a new-message draft in the background", async () => {
    mocks.api.messages.getFull.mockResolvedValueOnce({ contentType: "text/plain", body: "Hello", headers: { subject: ["Plan"] } } as any);
    await composer.openDraft(7);
    expect(composer.draft).toMatchObject({ threaded: false });
    composer.draft!.to = to;
    expect(await composer.send()).toBe(true);
    expect(mocks.api.messages.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.api.compose.beginNew).not.toHaveBeenCalled();
  });
  it("saves an agent's reply draft, finding it in Drafts when Thunderbird doesn't hand it back (server Drafts)", async () => {
    mocks.api.compose.saveMessage.mockResolvedValueOnce({ mode: "draft", messages: [] } as any);
    // Before saving, Drafts has the user's own reply to the same email; after, the agent's appears too.
    mocks.api.messages.query.mockResolvedValueOnce({ messages: [{ id: 49, subject: "Plan", date: new Date(), headerMessageId: "users-own@x" }] } as any)
      .mockResolvedValueOnce({ messages: [{ id: 50, subject: "Other", date: new Date() }, { id: 51, subject: "Plan", date: new Date(), headerMessageId: "draft-51@x" }, { id: 49, subject: "Plan", date: new Date(Date.now() + 1000), headerMessageId: "users-own@x" }] } as any);
    const original = mocks.api.messages.getFull.getMockImplementation();
    mocks.api.messages.getFull.mockImplementation(async (id: number) => id === 51 ? { contentType: "text/plain", body: "Sounds good.\n\nSee you then", headers: {} } as any : (original as any)(id));
    const draft = await composer.saveReplyDraft(7, "Sounds good.\n\nSee you then", false);
    mocks.api.messages.getFull.mockImplementation(original as any);
    expect(draft).toMatchObject({ id: 51, headerMessageId: "draft-51@x" });
    expect(mocks.api.compose.beginReply).toHaveBeenCalledWith(7, "replyToSender", expect.objectContaining({ body: expect.stringContaining("<div>Sounds good.</div><div><br></div><div>See you then</div>") }));
    expect(mocks.api.compose.sendMessage).not.toHaveBeenCalled();
    expect(mocks.api.tabs.remove).toHaveBeenCalledWith(10);
  });
  it("returns no draft (not an error) when the saved copy doesn't show up", async () => {
    vi.useFakeTimers();
    try {
      mocks.api.compose.saveMessage.mockResolvedValueOnce({ mode: "draft", messages: [] } as any);
      const pending = composer.saveReplyDraft(7, "Thanks", true);
      await vi.runAllTimersAsync();
      expect(await pending).toBeNull();
      expect(mocks.api.compose.beginReply).toHaveBeenCalledWith(7, "replyToAll", expect.anything());
    } finally { vi.useRealTimers(); }
  });
  it("can enable window-free sending from Settings without sending email", async () => {
    mocks.state.background = false; expect(await sendSettings.enable()).toBe(true); expect(sendSettings.enabled).toBe(true); expect(mocks.api.messages.sendMessage).not.toHaveBeenCalled();
  });
});
