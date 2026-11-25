import { describe, expect, it, vi } from "vitest";
import { AI_MIN_CONFIDENCE, aiCategory, aiKey, aiSignal, clefAnswer, clefError, clefRequest, savedAnswer, unsorted } from "../src/lib/ai-sort";
import { AiSorter } from "../src/lib/ai-sorter";
import source from "../public/experiments/ai/implementation.js?raw";
import type { MessageHeader } from "../src/lib/types";

const inbox = { id: "in", name: "Inbox", path: "/INBOX", specialUse: ["inbox"] };
const mail = (p: Partial<MessageHeader>): MessageHeader => ({ id: 1, date: new Date("2026-10-28T12:00:00Z"), author: "Ada <hello@acme.com>", subject: "Lunch?", flagged: false, recipients: ["me@northwind.example"], ccList: [], bccList: [], headerMessageId: "<a1@acme.com>", size: 1, tags: [], folder: inbox, ...p });

describe("Clef requests and answers", () => {
  it("sends the sender, subject, header signals and the start of the text, nothing more", () => {
    const html = `<p>Hi! Are you free for lunch?</p>${"<p>More words here.</p>".repeat(100)}`;
    const request = clefRequest(mail({}), { contentType: "text/html", body: html, headers: { "list-unsubscribe": ["<mailto:x>"], "precedence": ["bulk"] } } as any);
    expect(request.state).toMatchObject({ from: "Ada <hello@acme.com>", subject: "Lunch?", recipients: 1, mailing_list: false, unsubscribe_link: true, automated: true });
    expect(request.state.text.startsWith("Hi! Are you free for lunch?")).toBe(true);
    expect(request.state.text.length).toBeLessThanOrEqual(600);
    expect(Object.keys(request.questions.kind.criteria)).toEqual(["people", "calendar", "updates", "newsletter"]);
    // The signals ride along as yes/no questions in the same request.
    expect(Object.entries(request.questions).filter(([, q]) => q.type === "noul").map(([id]) => id)).toEqual(["reply", "important", "receipt", "promotion"]);
    expect(clefRequest(mail({}), undefined).state.text).toBe("");
  });
  it("reads Cloudflare's answer (REST envelope or bare) and explains refusals", () => {
    const full = { success: true, result: { answers: { kind: { type: "choice", choice: "people", confidence: 0.91, probabilities: { people: 0.91 } }, reply: { type: "noul", noul: 0.83 }, important: { type: "noul", noul: 0.2 }, receipt: { type: "noul", noul: 0.01 }, promotion: { type: "noul", noul: 0 } } } };
    expect(clefAnswer(full)).toEqual({ cat: "people", confidence: 0.91, signals: { reply: 0.83, important: 0.2, receipt: 0.01, promotion: 0, spam: null } });
    expect(clefAnswer({ answers: { kind: { choice: "updates", probabilities: { updates: 0.8 } } } })).toEqual({ cat: "notification", confidence: 0.8, signals: { reply: null, important: null, receipt: null, promotion: null, spam: null } });
    expect(clefAnswer({ answers: { kind: { choice: "calendar", confidence: 0.9 } } })?.cat).toBe("calendar");
    expect(savedAnswer(clefAnswer(full)!, 60000 * 5)).toEqual(["people", 91, 5, 83, 20, 1, 0, -1]);
    expect(clefAnswer({ result: { answers: { kind: { choice: "spam", confidence: 1 } } } })).toBeNull();
    expect(clefAnswer(null)).toBeNull();
    expect(clefError(401, null)).toContain("token");
    expect(clefError(500, { errors: [{ message: "Internal" }] })).toBe("Cloudflare: Internal");
  });
  it("uses an answer only when Clef was sure enough", () => {
    const answers = { "a1@acme.com": ["people", 90, 1, 85, 10, 0, 0] as any, "b@x": ["newsletter", Math.round(AI_MIN_CONFIDENCE * 100) - 1, 1, 0, 0, 0, 90] as any, "old@x": ["people", 90, 1] as any };
    expect(aiKey(mail({}))).toBe("a1@acme.com");
    expect(aiCategory(answers, mail({}))).toBe("people");
    expect(aiCategory(answers, mail({ headerMessageId: "b@x" }))).toBeNull();
    expect(aiCategory(answers, mail({ headerMessageId: "c@x" }))).toBeNull();
    // Signals: from 70%, and only from answers that have them.
    expect(aiSignal(answers, mail({}), "reply")).toBe(true);
    expect(aiSignal(answers, mail({}), "important")).toBe(false);
    expect(aiSignal(answers, mail({ headerMessageId: "b@x" }), "promotion")).toBe(true);
    expect(aiSignal(answers, mail({ headerMessageId: "old@x" }), "reply")).toBe(false);
  });
  it("asks only about unsorted Inbox mail, newest first, never the user's own or junk", () => {
    const list = [
      mail({ id: 1, headerMessageId: "old@x", date: new Date("2026-10-01") }),
      mail({ id: 2, headerMessageId: "new@x", date: new Date("2026-10-28") }),
      mail({ id: 3, headerMessageId: "done@x" }),
      mail({ id: 4, headerMessageId: "mine@x", author: "Me <me@northwind.example>" }),
      mail({ id: 5, headerMessageId: "junk@x", junk: true }),
      mail({ id: 6, headerMessageId: "sent@x", folder: { id: "s", name: "Sent", path: "/Sent", specialUse: ["sent"] } }),
      mail({ id: 7, headerMessageId: "new@x" }), // the same email in another place
    ];
    expect(unsorted(list, { "done@x": ["people", 99, 1, 0, 0, 0, 0] }, new Set(["me@northwind.example"])).map((m) => m.id)).toEqual([2, 1]);
    // Answers saved before Calendar and the signals (3 items) are asked again.
    expect(unsorted(list, { "done@x": ["people", 99, 1], "new@x": ["people", 90, 1], "old@x": ["people", 90, 1] }, new Set(["me@northwind.example"])).map((m) => m.id)).toEqual([3, 2, 1]);
  });
});

describe("the background sorter", () => {
  function fakeNative(replies: (n: number) => { status: number; body: any }, settings: Record<string, any> = {}) {
    const store: Record<string, any> = { aiSort: true, clefAccount: "a".repeat(32), clefToken: "t".repeat(40), clefModel: "clef-flash", ...settings };
    let calls = 0;
    return {
      store,
      calls: () => calls,
      storage: { local: { get: vi.fn(async (d: any) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, k in store ? store[k] : v]))), set: vi.fn(async (v: any) => { Object.assign(store, v); }) } },
      accounts: { list: vi.fn(async () => [{ identities: [{ email: "me@northwind.example" }] }]) },
      sparkAI: { clef: vi.fn(async () => replies(++calls)) },
    };
  }
  const ok = (cat: string, confidence = 0.9) => ({ status: 200, body: { result: { answers: { kind: { choice: cat === "notification" ? "updates" : cat, confidence } } } } });
  const headers = Array.from({ length: 30 }, (_, i) => mail({ id: i + 1, headerMessageId: `m${i}@x`, date: new Date(2026, 9, 1 + i) }));

  it("sorts every unsorted Inbox email once and records progress", async () => {
    const native = fakeNative(() => ok("notification"));
    await new AiSorter(native, { headers: async () => headers, full: async () => undefined }).run();
    expect(native.calls()).toBe(30);
    expect(Object.keys(native.store.aiCategories)).toHaveLength(30);
    expect(native.store.aiCategories["m29@x"]).toEqual(["notification", 90, expect.any(Number), -1, -1, -1, -1, -1]);
    expect(native.store.aiSortStatus).toMatchObject({ state: "idle", sorted: 30, total: 30 });
    await new AiSorter(native, { headers: async () => headers, full: async () => undefined }).run();
    expect(native.calls()).toBe(30); // nothing new to ask
  });
  it("stops on a refused token and says why; does nothing while off", async () => {
    const refused = fakeNative(() => ({ status: 401, body: null }));
    await new AiSorter(refused, { headers: async () => headers, full: async () => undefined }).run();
    expect(refused.calls()).toBeLessThanOrEqual(2);
    expect(refused.store.aiSortStatus).toMatchObject({ state: "error", error: expect.stringContaining("token") });
    const off = fakeNative(() => ok("people"), { aiSort: false });
    await new AiSorter(off, { headers: async () => headers, full: async () => undefined }).run();
    expect(off.calls()).toBe(0);
    expect(off.store.aiSortStatus).toMatchObject({ state: "off" });
  });
  it("keeps what it sorted when Cloudflare's rate limit hits, to continue later", async () => {
    vi.useFakeTimers();
    try {
      const native = fakeNative((n) => (n <= 10 ? ok("people") : { status: 429, body: null }));
      await new AiSorter(native, { headers: async () => headers, full: async () => undefined }).run();
      expect(Object.keys(native.store.aiCategories).length).toBe(10);
      expect(native.store.aiSortStatus).toMatchObject({ state: "error", sorted: 10, total: 30, error: expect.stringContaining("limit") });
    } finally { vi.useRealTimers(); }
  });
  it("tests the connection with a made-up email", async () => {
    const native = fakeNative(() => ok("people", 0.97));
    const result = await new AiSorter(native, { headers: async () => [], full: async () => undefined }).test({ clefAccount: " " + "b".repeat(32) + " ", clefToken: "t".repeat(40) });
    expect(result).toMatchObject({ ok: true, answer: "people", confidence: 0.97 });
    expect(native.sparkAI.clef).toHaveBeenCalledWith("b".repeat(32), "t".repeat(40), "clef-flash", expect.objectContaining({ state: expect.objectContaining({ from: "Ada Lovelace <ada@example.org>" }) }));
  });
});

describe("the Cloudflare endpoint (Experiment)", () => {
  const module = { exports: {} as any };
  new Function("module", "ExtensionCommon", source).call({}, module, { ExtensionAPI: class {} });
  const { clefEndpoint } = module.exports;
  it("builds Cloudflare's address only for a valid account and model, and a local mock only on 127.0.0.1", () => {
    expect(clefEndpoint("0123456789abcdef0123456789ABCDEF", "clef-flash", "")).toBe("https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789ABCDEF/ai/run/@cf/cloudflare/clef-flash");
    expect(clefEndpoint("not-an-id", "clef", "")).toBeNull();
    expect(clefEndpoint("0".repeat(32), "gpt", "")).toBeNull();
    expect(clefEndpoint("", "clef", "http://127.0.0.1:8123/run/")).toBe("http://127.0.0.1:8123/run/clef");
    expect(clefEndpoint("", "clef", "https://evil.test/")).toBeNull();
  });
});
