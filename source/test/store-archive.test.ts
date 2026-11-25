import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageHeader, MessageList } from "../src/lib/types";
// Archive on Exchange: Thunderbird reports a move the server refused as done, and the email came back to the
// Inbox on the next restart. Ember now checks (sparkArchive), tries again, says what failed, and archives again
// an email that comes back.
const backend = vi.hoisted(() => {
  const event = () => ({ addListener: vi.fn() });
  const saved: Record<string, unknown> = {};
  return {
    saved,
    runtime: { getBrowserInfo: vi.fn(async () => ({ version: "158.0.1" })) },
    storage: { local: { get: vi.fn(async (keys: any) => (typeof keys === "string" ? { [keys]: saved[keys] } : keys)), set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(saved, values); }) } },
    accounts: { list: vi.fn(async () => []), onCreated: event(), onDeleted: event() },
    folders: { getFolderInfo: vi.fn(async () => ({ unreadMessageCount: 0 })), onFolderInfoChanged: event(), onCreated: event(), onDeleted: event(), onRenamed: event() },
    messages: { list: vi.fn(), listAttachments: vi.fn(), query: vi.fn(async (): Promise<MessageList> => ({ id: null, messages: [] })), continueList: vi.fn(), abortList: vi.fn(async (_id: string) => {}), update: vi.fn(async () => {}), archive: vi.fn(async () => {}), move: vi.fn(async () => {}), onNewMailReceived: event(), onUpdated: event(), onMoved: event(), onCopied: event(), onDeleted: event() },
    sparkArchive: { archive: vi.fn(async (_ids: number[]) => ({ failed: [] as { id: number; error: string }[] })) },
  };
});
vi.mock("../src/lib/api", async (original) => ({ ...await original<object>(), api: backend, listFolder: (id: string) => backend.messages.list(id), abortList: (id: string) => backend.messages.abortList(id), drain: async (list: MessageList | Promise<MessageList>) => (await list).messages }));
import { Store } from "../src/lib/store.svelte";

const inbox = { id: "account8://Inbox", accountId: "account8", name: "Inbox", path: "/Inbox" };
const archive = { id: "account8://Archive/2026", accountId: "account8", name: "2026", path: "/Archive/2026" };
const message = (id: number, props: Partial<MessageHeader> = {}): MessageHeader => ({ id, date: new Date("2026-11-12T18:19:48Z"), author: "benefits@wellness.example", subject: `Email ${id}`, recipients: [], ccList: [], bccList: [], headerMessageId: `mid-${id}`, size: 1, tags: [], flagged: false, read: false, folder: inbox, ...props });
const view = { kind: "folder", folderId: inbox.id } as const;
const failure = "the mail server didn't answer in time (0x804b000e)";

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); for (const key of Object.keys(backend.saved)) delete backend.saved[key]; backend.sparkArchive.archive.mockImplementation(async () => ({ failed: [] })); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

async function opened(messages: MessageHeader[]) {
  const store = new Store();
  vi.spyOn(store.meta, "init").mockResolvedValue();
  vi.spyOn(store.meta, "request").mockImplementation(() => {});
  await store.init();
  backend.messages.list.mockResolvedValueOnce({ id: null, messages });
  await store.setView(view);
  return store;
}
const shown = (store: Store) => store.conversations.flatMap((c) => c.ids);
const lastToast = (store: Store) => store.toasts[store.toasts.length - 1];

describe("archive that stays archived", () => {
  it("tries again when the server didn't take the move, and says Archived once it did", async () => {
    const store = await opened([message(1)]);
    backend.sparkArchive.archive.mockResolvedValueOnce({ failed: [{ id: 1, error: failure }] });
    const done = store.archive([store.conversations[0]]);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown(store)).toEqual([]);
    await vi.advanceTimersByTimeAsync(4000);
    await done;
    expect(backend.sparkArchive.archive).toHaveBeenCalledTimes(2);
    expect(lastToast(store)).toMatchObject({ text: "Archived", kind: "info" });
    expect(backend.messages.archive).not.toHaveBeenCalled(); // Thunderbird's own call can't tell a failure
  });

  it("brings it back and says why when the move keeps failing", async () => {
    const store = await opened([message(1), message(2)]);
    backend.sparkArchive.archive.mockImplementation(async (ids: number[]) => ({ failed: ids.map((id) => ({ id, error: failure })) }));
    const done = store.archive([store.conversations.find((c) => c.ids.includes(1))!]);
    await vi.advanceTimersByTimeAsync(20000);
    await done;
    expect(backend.sparkArchive.archive).toHaveBeenCalledTimes(3);
    expect(shown(store).sort()).toEqual([1, 2]);
    expect(lastToast(store)).toMatchObject({ kind: "error", text: `Couldn't archive this email: ${failure}. It's back in the inbox, and Ember will archive it when the server answers.` });
    expect(backend.saved.archiveIntents).toMatchObject({ "mid-1": { settled: false, pending: expect.any(Number) } });
  });

  it("archives it once the server is back (an Exchange outage), and stops trying after a while", async () => {
    const store = await opened([message(1), message(2)]);
    backend.sparkArchive.archive.mockImplementation(async (ids: number[]) => ({ failed: ids.map((id) => ({ id, error: failure })) }));
    const done = store.archive([store.conversations.find((c) => c.ids.includes(1))!]);
    await vi.advanceTimersByTimeAsync(20000);
    await done;
    backend.sparkArchive.archive.mockClear();
    await vi.advanceTimersByTimeAsync(3 * 60_000); // still down
    expect(backend.sparkArchive.archive).toHaveBeenCalledWith([1]);
    backend.sparkArchive.archive.mockImplementation(async () => ({ failed: [] }));
    const toast = vi.spyOn(store, "toast");
    await vi.advanceTimersByTimeAsync(3 * 60_000); // back
    expect(toast).toHaveBeenCalledWith({ kind: "success", text: "Archived “Email 1”: the server took it this time" });
    expect(backend.saved.archiveIntents).toMatchObject({ "mid-1": { settled: true } });
    backend.sparkArchive.archive.mockClear();
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(backend.sparkArchive.archive).not.toHaveBeenCalled(); // nothing left waiting
  });

  it("archives again an email the server put back in the Inbox, with a note", async () => {
    const store = await opened([message(1)]);
    await store.archive([store.conversations[0]]);
    expect(backend.saved.archiveIntents).toMatchObject({ "mid-1": { folderId: inbox.id, settled: true, again: 0 } });
    const moved = backend.messages.onMoved.addListener.mock.calls[0][0];
    await moved({ id: null, messages: [message(1)] }, { id: null, messages: [message(10, { headerMessageId: "mid-1", folder: archive })] });
    // Exchange's next sync puts it back (a new Thunderbird id, the same Message-ID).
    const copied = backend.messages.onCopied.addListener.mock.calls[0][0];
    await copied({ id: null, messages: [] }, { id: null, messages: [message(11, { headerMessageId: "mid-1" })] });
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.sparkArchive.archive).toHaveBeenLastCalledWith([11]);
    expect(shown(store)).toEqual([]);
    expect(lastToast(store)).toMatchObject({ kind: "info", text: "Archived “Email 11” again: it came back to the inbox" });
    expect(backend.saved.archiveIntents).toMatchObject({ "mid-1": { settled: true, again: 1 } });
  });

  it("a try that never answers doesn't hold up the next ones (seen during the Exchange outage)", async () => {
    const store = await opened([message(1), message(2)]);
    backend.sparkArchive.archive.mockImplementation(async (ids: number[]) => ({ failed: ids.map((id) => ({ id, error: failure })) }));
    const done = store.archive([store.conversations.find((c) => c.ids.includes(1))!]);
    await vi.advanceTimersByTimeAsync(20000);
    await done;
    backend.sparkArchive.archive.mockReset();
    backend.sparkArchive.archive.mockImplementationOnce(() => new Promise(() => {})); // stuck, like a lookup that never came back
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(backend.sparkArchive.archive).toHaveBeenCalledTimes(1);
    backend.sparkArchive.archive.mockImplementation(async () => ({ failed: [] }));
    const toast = vi.spyOn(store, "toast");
    await vi.advanceTimersByTimeAsync(2 * 3 * 60_000);
    expect(backend.sparkArchive.archive).toHaveBeenCalledTimes(2);
    expect(toast).toHaveBeenCalledWith({ kind: "success", text: "Archived “Email 1”: the server took it this time" });
  });

  it("a first try that never answers counts as a failure and waits for the server", async () => {
    const store = await opened([message(1)]);
    backend.sparkArchive.archive.mockImplementation(() => new Promise(() => {}));
    const done = store.archive([store.conversations[0]]);
    await vi.advanceTimersByTimeAsync(3 * 120_000 + 20_000);
    await done;
    expect(shown(store)).toEqual([1]);
    expect(lastToast(store)).toMatchObject({ kind: "error", text: "Couldn't archive this email: Thunderbird didn't finish archiving in time. It's back in the inbox, and Ember will archive it when the server answers." });
    expect(backend.saved.archiveIntents).toMatchObject({ "mid-1": { pending: expect.any(Number) } });
  });

  it("an email already in an archive folder isn't remembered, nor 'archived again' from there", async () => {
    const inArchives = { ...archive, specialUse: ["archives"] };
    backend.saved.archiveIntents = { "mid-9": { folderId: archive.id, at: Date.now() - 60_000, settled: true, again: 0 } }; // left by 0.1.116
    const store = await opened([message(9, { folder: inArchives }), message(8, { folder: inArchives })]);
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.sparkArchive.archive).not.toHaveBeenCalled();
    await store.archive([store.conversations.find((c) => c.ids.includes(8))!]);
    expect((backend.saved.archiveIntents as any)["mid-8"]).toBeUndefined();
  });

  it("remembers across a restart: an email back in the Inbox at start-up is archived again", async () => {
    backend.saved.archiveIntents = { "mid-5": { folderId: inbox.id, at: Date.now() - 3600_000, settled: true, again: 0 } };
    const store = await opened([message(7, { headerMessageId: "mid-5" }), message(8)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.sparkArchive.archive).toHaveBeenCalledWith([7]);
    expect(shown(store)).toEqual([8]);
  });

  it("doesn't fight Undo, or an email the user moves back", async () => {
    const store = await opened([message(1), message(2)]);
    await store.archive([store.conversations.find((c) => c.ids.includes(1))!]);
    lastToast(store).action!.run();
    expect(backend.saved.archiveIntents).toEqual({});
    await store.archive([store.conversations.find((c) => c.ids.includes(2))!]);
    backend.messages.list.mockResolvedValueOnce({ id: null, messages: [message(12, { headerMessageId: "mid-2", folder: archive })] });
    await store.setView({ kind: "folder", folderId: archive.id });
    await store.moveTo([store.conversations[0]], inbox.id);
    expect(backend.saved.archiveIntents).toEqual({});
  });
});
