import { describe, expect, it, vi } from "vitest";
import { emptyFeedback, isSpamSender, markedNotSpam, markedSpam, readFeedback, spamQuestion, spamVerdict, unmarkedSpam, SPAM_MOVE_WITHIN_MS } from "../src/lib/spam";
import { SpamService } from "../src/lib/spam-service";
import { clefAnswer, clefRequest, savedAnswer, aiSpam } from "../src/lib/ai-sort";
import source from "../public/experiments/junk/implementation.js?raw";

const NOW = Date.parse("2026-11-16T12:00:00Z");
const mail = (o: any = {}) => ({ id: 1, author: "Prize Desk <win@prizes.example>", subject: "You won a cruise", headerMessageId: "<a1@prizes.example>", date: new Date(NOW - 3600000), flagged: false, recipients: ["me@x.org"], ccList: [], bccList: [], tags: [], size: 1, folder: { id: "inbox1", accountId: "acc1", specialUse: ["inbox"] }, ...o });
const me = new Set(["me@x.org"]);

describe("spam you teach Ember", () => {
  it("remembers the sender and the email as an example (domain and subject only), never your own", () => {
    const f = markedSpam(emptyFeedback(), [mail(), mail({ author: "Me <me@x.org>", subject: "my own" })], me, NOW);
    expect(f.senders).toEqual({ "win@prizes.example": NOW });
    expect(f.examples).toEqual([{ spam: true, domain: "prizes.example", subject: "You won a cruise", at: NOW }]);
    expect(isSpamSender(f, "WIN@Prizes.example")).toBe(true);
    expect(isSpamSender(f, "other@prizes.example")).toBe(false); // exact address only, never the whole domain
  });

  it("Not spam forgets the sender, keeps a counter-example, and clears the email", () => {
    const marked = markedSpam(emptyFeedback(), [mail()], me, NOW);
    const f = markedNotSpam(marked, [mail()], NOW + 1);
    expect(f.senders).toEqual({});
    expect(f.examples).toEqual([{ spam: false, domain: "prizes.example", subject: "You won a cruise", at: NOW + 1 }]);
    expect(f.cleared).toEqual(["a1@prizes.example"]);
    // Marked spam again later: no longer cleared, the example flips back.
    const again = markedSpam(f, [mail()], me, NOW + 2);
    expect(again.cleared).toEqual([]);
    expect(again.examples.map((e) => e.spam)).toEqual([true]);
  });

  it("Undo takes a mark back entirely", () => {
    const f = unmarkedSpam(markedSpam(emptyFeedback(), [mail()], me, NOW), [mail()]);
    expect(f).toEqual(emptyFeedback());
  });

  it("keeps at most 20 spam and 10 not-spam examples, newest first", () => {
    let f = emptyFeedback();
    for (let i = 0; i < 25; i++) f = markedSpam(f, [mail({ author: `x${i}@s${i}.example`, subject: `spam ${i}` })], me, NOW + i);
    for (let i = 0; i < 12; i++) f = markedNotSpam(f, [mail({ author: `y${i}@g.example`, subject: `good ${i}`, headerMessageId: `<g${i}@x>` })], NOW + 100 + i);
    expect(f.examples.filter((e) => e.spam)).toHaveLength(20);
    expect(f.examples.filter((e) => !e.spam)).toHaveLength(10);
    expect(f.examples[0].subject).toBe("good 11");
    expect(Object.keys(f.senders)).toHaveLength(25); // senders aren't capped: each is a rule you made
  });

  it("reads stored feedback defensively", () => {
    expect(readFeedback(undefined)).toEqual(emptyFeedback());
    expect(readFeedback({ senders: { "A@B.org": 5, junk: 1 }, examples: [{ spam: 1, domain: "b.org", subject: "s", at: 2 }, null], cleared: ["k", 3] }))
      .toEqual({ senders: { "a@b.org": 5 }, examples: [{ spam: true, domain: "b.org", subject: "s", at: 2 }], cleared: ["k"] });
  });

  it("asks Clef about spam with your marks as examples", () => {
    expect(spamQuestion(emptyFeedback()).instructions).not.toContain("marked");
    const f = markedNotSpam(markedSpam(emptyFeedback(), [mail({ subject: 'Claim your "free" gift' })], me, NOW), [mail({ author: "news@good.example", subject: "Weekly digest", headerMessageId: "<d@x>" })], NOW + 1);
    const q = spamQuestion(f);
    expect(q.type).toBe("noul");
    expect(q.instructions).toContain(`marked emails like these as spam: "Claim your 'free' gift" (from prizes.example)`);
    expect(q.instructions).toContain(`NOT spam: "Weekly digest" (from good.example)`);
    expect(q.instructions).not.toContain("win@"); // no addresses
  });

  it("moves only what Clef is sure of, on recent mail, never from people you've written to or pinned", () => {
    const o = { me, written: new Set(["friend@x.org"]), feedback: emptyFeedback(), now: NOW };
    expect(spamVerdict(0.95, mail(), o)).toBe("move");
    expect(spamVerdict(0.8, mail(), o)).toBe("ask");
    expect(spamVerdict(0.5, mail(), o)).toBe(null);
    expect(spamVerdict(null, mail(), o)).toBe(null);
    expect(spamVerdict(0.99, mail({ author: "friend@x.org" }), o)).toBe("ask");
    expect(spamVerdict(0.99, mail({ flagged: true }), o)).toBe("ask");
    expect(spamVerdict(0.99, mail({ date: new Date(NOW - SPAM_MOVE_WITHIN_MS - 1) }), o)).toBe("ask");
    expect(spamVerdict(0.99, mail({ author: "me@x.org" }), o)).toBe(null);
    expect(spamVerdict(0.99, mail(), { ...o, feedback: { ...emptyFeedback(), cleared: ["a1@prizes.example"] } })).toBe(null);
  });

  it("rides along on the Clef request and is saved with the answer", () => {
    const q = spamQuestion(emptyFeedback());
    expect(clefRequest(mail() as any, undefined, undefined, q).questions.spam).toEqual(q);
    expect("spam" in clefRequest(mail() as any, undefined).questions).toBe(false);
    const answer = clefAnswer({ result: { answers: { kind: { choice: "newsletter", confidence: 0.9 }, spam: { type: "noul", noul: 0.93 } } } })!;
    expect(answer.signals.spam).toBe(0.93);
    const saved = savedAnswer(answer, 60000);
    expect(saved[7]).toBe(93);
    expect(aiSpam({ "a1@prizes.example": saved }, mail())).toBe(0.93);
    expect(aiSpam({ "a1@prizes.example": ["people", 90, 1, 1, 1, 1, 1] }, mail())).toBe(null); // answered before spam
  });
});

describe("the background's spam moves", () => {
  function native(feedback: any, folders: Record<string, string | null> = { acc1: "junk1" }) {
    const store: any = { spamFeedback: feedback };
    return {
      store,
      storage: { local: { get: vi.fn(async (d: any) => ({ ...d, ...store })), set: vi.fn(async (v: any) => Object.assign(store, v)) } },
      accounts: { list: vi.fn(async () => [{ identities: [{ email: "me@x.org" }] }]) },
      folders: { query: vi.fn(async ({ accountId }: any) => (folders[accountId] ? [{ id: folders[accountId] }] : [])) },
      messages: { move: vi.fn(async () => {}) },
    };
  }
  const headers = (list: any[] = []) => ({ headers: async () => list });

  it("sends new Inbox mail from a sender you marked straight to Spam, and says so", async () => {
    const n = native(markedSpam(emptyFeedback(), [mail()], me, NOW));
    const service = new SpamService(n, headers());
    const moved = await service.received([mail({ id: 7 }), mail({ id: 8, author: "ok@fine.example" }), mail({ id: 9, folder: { id: "junk1", accountId: "acc1", specialUse: ["junk"] } })] as any);
    expect(moved).toBe(1);
    expect(n.messages.move).toHaveBeenCalledWith([7], "junk1");
    expect(n.store.spamMoved).toMatchObject({ reason: "sender", items: [{ subject: "You won a cruise", from: "Prize Desk <win@prizes.example>" }] });
  });

  it("does nothing without marked senders, and leaves mail where it is on an account without Spam", async () => {
    const none = native(null);
    expect(await new SpamService(none, headers()).received([mail()] as any)).toBe(0);
    const noFolder = native(markedSpam(emptyFeedback(), [mail()], me, NOW), { acc1: null });
    expect(await new SpamService(noFolder, headers()).received([mail()] as any)).toBe(0);
    expect(noFolder.messages.move).not.toHaveBeenCalled();
  });

  it("moves what Clef is sure of, except mail from people you've written to", async () => {
    const n = native(null);
    const sent = [{ ...mail({ id: 50, author: "me@x.org", recipients: ["Pal <pal@x.org>"] }), folder: { id: "sent1", accountId: "acc1", specialUse: ["sent"] } }];
    const service = new SpamService(n, headers(sent));
    const moved = await service.answered([
      { message: mail({ id: 1, date: new Date() }), spam: 0.95 },
      { message: mail({ id: 2, author: "pal@x.org", date: new Date() }), spam: 0.99 },
      { message: mail({ id: 3, date: new Date() }), spam: 0.8 },
      { message: mail({ id: 4, date: new Date() }), spam: null },
    ] as any);
    expect(moved).toBe(1);
    expect(n.messages.move).toHaveBeenCalledWith([1], "junk1");
    expect(n.store.spamMoved.reason).toBe("ai");
  });
});

describe("the junk Experiment", () => {
  const experiment: { exports: any } = { exports: {} };
  new Function("module", "ExtensionCommon", source)(experiment, { ExtensionAPI: class {} });
  const { junkClassification, userClassification } = experiment.exports;
  const P = { UNCLASSIFIED: 0, GOOD: 1, JUNK: 2 };
  it("trains with the user's verdict, from their earlier one", () => {
    expect([junkClassification("spam", P), junkClassification("good", P), junkClassification("unknown", P)]).toEqual([2, 1, 0]);
    expect(userClassification("user", "100", P)).toBe(2);
    expect(userClassification("user", "0", P)).toBe(1);
    expect(userClassification("plugin", "100", P)).toBe(0); // the filter's own guess isn't a user verdict
    expect(userClassification("", "", P)).toBe(0);
    // A verdict taken back isn't the user's: marking it again later trains from nothing (not from "good").
    const { junkOrigin } = experiment.exports;
    expect([junkOrigin("spam"), junkOrigin("good"), junkOrigin("unknown")]).toEqual(["user", "user", "plugin"]);
    expect(userClassification(junkOrigin("unknown"), "0", P)).toBe(0);
  });
  it("tells the filter's own guess from a verdict, a rule or the server's flag (only a guess stays in the Inbox)", () => {
    const { isFilterGuess } = experiment.exports;
    expect(isFilterGuess("100", "plugin")).toBe(true);
    expect(isFilterGuess("100", "")).toBe(true);
    expect(isFilterGuess("100", "user")).toBe(false);
    expect(isFilterGuess("100", "filter")).toBe(false);
    expect(isFilterGuess("100", "imapflag")).toBe(false);
    expect(isFilterGuess("0", "plugin")).toBe(false);
  });
});
