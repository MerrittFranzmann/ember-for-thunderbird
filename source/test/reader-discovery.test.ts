import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, MessageHeader } from "../src/lib/types";
const mock = vi.hoisted(() => {
  const event = () => ({ addListener: vi.fn() });
  return {
    saved: [] as MessageHeader[],
    version: undefined as number | undefined,
    messages: { query: vi.fn(), getHeaders: vi.fn(), getFull: vi.fn(), onNewMailReceived: event(), onUpdated: event(), onMoved: event(), onDeleted: event() },
    folders: {}, accounts: {},
    register: vi.fn(), remove: vi.fn(), changed: vi.fn(),
  };
});
vi.mock("../src/lib/api", async original => ({ ...await original<object>(), api: mock, env: { hasGetHeaders: true }, drain: async (page: any) => (await page).messages, mailCache: { all: () => mock.saved, get version() { return mock.version; }, register: mock.register, remove: mock.remove, changed: mock.changed } }));
import { Store } from "../src/lib/store.svelte";
const folder = (id: string, role: string) => ({ id, accountId: "work", name: role, path: `/${role}`, specialUse: [role] });
const header = (id: number, props: Partial<MessageHeader> = {}): MessageHeader => ({ id, date: new Date("2026-10-27T14:00:00Z"), author: "ada@example.org", subject: "Plan", recipients: ["me@example.org"], ccList: [], bccList: [], headerMessageId: `message-${Math.abs(id)}`, size: 10, tags: [], flagged: false, read: true, folder: folder("inbox", "inbox"), ...props });
const root = header(1);
function setup() {
  const store = new Store(); store.me.add("me@example.org");
  for (const role of ["inbox", "sent", "archives", "trash", "junk", "drafts"]) store.folderById.set(role, folder(role, role));
  (store as any).dataset.set(root.id, root);
  vi.spyOn(store.meta, "has").mockReturnValue(true);
  const conv = { key: "message-1", ids: [1], latest: root, count: 1, unread: 0, flagged: false, hasAttachment: false, cat: "people", senders: ["Ada"] } as Conversation;
  return { store, conv };
}
beforeEach(() => { vi.clearAllMocks(); mock.saved = []; mock.version = undefined; });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe("local-first conversation discovery", () => {
  it("indexed opens match the full grouping and refresh when cached headers change", async () => {
    const reply = header(-2, { author: "me@example.org", recipients: ["ada@example.org"], folder: folder("sent", "sent") });
    const saved = [header(-1), reply, header(-3, { folder: folder("archives", "archives") }), header(-4, { folder: folder("trash", "trash") }), header(-5, { subject: "Unrelated budget", headerMessageId: "message-5" })];
    const ids = async (version: number | undefined) => { mock.version = version; mock.saved = saved; const { store, conv } = setup(); return (await store.relatedMessages(conv)).map(m => m.id).sort((a, b) => a - b); };
    const full = await ids(undefined);
    expect(full).toEqual([-3, -2, 1]);
    expect(await ids(1)).toEqual(full);
    const { store, conv } = setup(); mock.version = 1; mock.saved = saved;
    expect(await store.relatedMessages(conv)).toHaveLength(3);
    expect(await store.relatedMessages(conv)).toHaveLength(3); // reopening uses the index too
    mock.saved = [...saved, header(-6, { date: new Date("2026-10-27T15:00:00Z"), headerMessageId: "message-6", folder: folder("archives", "archives") })]; mock.version = 2;
    expect((await store.relatedMessages(conv)).map(m => m.id)).toContain(-6);
  });
  it("includes saved Sent/archive replies on repeated opens without any native query or header download", async () => {
    const { store, conv } = setup();
    mock.saved = [header(-2, { author: "me@example.org", recipients: ["ada@example.org"], folder: folder("sent", "sent") }), header(-3, { folder: folder("archives", "archives") }), header(-4, { folder: folder("trash", "trash") })];
    expect((await store.relatedMessages(conv)).map(m => m.id).sort((a, b) => a - b)).toEqual([-3, -2, 1]);
    expect(await store.relatedMessages(conv)).toHaveLength(3);
    expect(mock.messages.query).not.toHaveBeenCalled(); expect(mock.messages.getHeaders).not.toHaveBeenCalled(); expect(mock.messages.getFull).not.toHaveBeenCalled();
  });
  it("sees newly saved replies without a stale thread memo", async () => {
    const { store, conv } = setup(); expect(await store.relatedMessages(conv)).toHaveLength(1);
    mock.saved = [header(-2, { folder: folder("sent", "sent") })];
    expect(await store.relatedMessages(conv)).toHaveLength(2); expect(mock.messages.query).not.toHaveBeenCalled();
  });
  it("finds uncached older replies only on explicit discovery and retains them on reopening", async () => {
    const { store, conv } = setup(); const old = header(2, { date: new Date("2025-01-01"), folder: folder("sent", "sent") });
    store.meta.put(old, { cat: "people", lvl: "h", refs: [root.headerMessageId] });
    mock.messages.query.mockResolvedValue({ id: null, messages: [old] });
    expect(await store.relatedMessages(conv)).toHaveLength(1); expect(mock.messages.query).not.toHaveBeenCalled();
    expect(await store.discoverRelatedMessages(conv)).toHaveLength(2); expect(mock.messages.query).toHaveBeenCalledWith({ subject: "Plan" });
    mock.messages.query.mockClear(); expect(await store.relatedMessages(conv)).toHaveLength(2); expect(mock.messages.query).not.toHaveBeenCalled();
  });
  it("takes referenced ancestors from saved mail instead of searching every folder for each Message-ID", async () => {
    const { store, conv } = setup();
    const parent = header(3, { subject: "Different subject", headerMessageId: "parent-3", folder: folder("archives", "archives") });
    mock.saved = [root, parent];
    store.meta.put(root, { cat: "people", lvl: "h", refs: ["parent-3", "missing-4"] });
    mock.messages.query.mockResolvedValue({ id: null, messages: [] });
    const found = await store.discoverRelatedMessages(conv);
    expect(found.map((m) => m.headerMessageId)).toContain("parent-3");
    const asked = mock.messages.query.mock.calls.map(([q]: any[]) => q);
    expect(asked).toContainEqual({ headerMessageId: "missing-4" }); // not saved: Thunderbird is asked
    expect(asked).not.toContainEqual({ headerMessageId: "parent-3" }); // saved: no search
  });
  it("does not retain a late discovery after the reader selection changes", async () => {
    const { store, conv } = setup(); let resolve!: (page: any) => void; let active = true;
    mock.messages.query.mockReturnValue(new Promise(r => resolve = r));
    const result = store.discoverRelatedMessages(conv, () => active); await vi.waitFor(() => expect(mock.messages.query).toHaveBeenCalled());
    active = false; resolve({ id: null, messages: [header(2)] }); await result;
    expect(await store.relatedMessages(conv)).toHaveLength(1);
  });
  it("reports discovery errors for Retry while normal reopening still works locally", async () => {
    const { store, conv } = setup(); mock.messages.query.mockRejectedValue(new Error("offline"));
    await expect(store.discoverRelatedMessages(conv)).rejects.toThrow("offline");
    expect(await store.relatedMessages(conv)).toHaveLength(1);
    mock.messages.query.mockResolvedValue({ id: null, messages: [] }); await expect(store.discoverRelatedMessages(conv)).resolves.toHaveLength(1);
  });
  it("removes a retained cached handle when Thunderbird deletes the same message under a live ID", async () => {
    vi.useFakeTimers(); const { store, conv } = setup(); const saved = header(-2); mock.saved = [saved]; await store.relatedMessages(conv);
    (store as any).listen(); mock.saved = [];
    const deleted = mock.messages.onDeleted.addListener.mock.calls[0][0]; await deleted({ id: null, messages: [{ ...saved, id: 500 }] });
    expect(await store.relatedMessages(conv)).toHaveLength(1);
  });
});
