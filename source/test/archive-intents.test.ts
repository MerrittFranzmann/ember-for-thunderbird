import { describe, expect, it } from "vitest";
import { again, cameBack, defer, failureText, forget, KEEP_MS, MAX_AGAIN, prune, remember, RETRY_FOR_MS, settle, waiting } from "../src/lib/archive-intents";
import { calendarErrorText, mergeAgenda, type CalendarEvent } from "../src/lib/meeting-status";
import source from "../public/experiments/archive/implementation.js?raw";

const experiment: { exports: { archiveStatusText: (status: number) => string } } = { exports: {} as any };
new Function("module", "ExtensionCommon", source).call({}, experiment, { ExtensionAPI: class {} });
const { archiveStatusText } = experiment.exports;

const inbox = { id: "account8://Inbox" };
const archive = { id: "account8://Archive/2026" };
const mail = (id: string, folder = inbox) => ({ headerMessageId: id, folder });
const t = Date.parse("2026-11-12T18:30:00Z");

describe("archives that stay archived", () => {
  it("an archived email back in the folder it was archived from is archived again, once Thunderbird had confirmed it", () => {
    let intents = remember({}, [mail("wellness")], t);
    // Not confirmed yet (the move is still under way): a list loaded meanwhile still has it in the Inbox.
    expect(cameBack(intents, [mail("wellness")], t + 1000)).toEqual([]);
    intents = settle(intents, ["wellness"]);
    expect(cameBack(intents, [mail("wellness", archive)], t + 60_000)).toEqual([]);
    expect(cameBack(intents, [mail("other")], t + 60_000)).toEqual([]);
    expect(cameBack(intents, [mail("wellness"), mail("wellness")], t + 60_000)).toEqual([mail("wellness")]);
  });

  it("gives up after a few times, and after a few days", () => {
    let intents = settle(remember({}, [mail("a")], t), ["a"]);
    for (let n = 0; n < MAX_AGAIN; n++) intents = settle(again(intents, ["a"], t + n), ["a"]);
    expect(intents.a.again).toBe(MAX_AGAIN);
    expect(cameBack(intents, [mail("a")], t + 10)).toEqual([]);
    const old = settle(remember({}, [mail("b")], t), ["b"]);
    expect(cameBack(old, [mail("b")], t + KEEP_MS)).toEqual([]);
    expect(prune(old, t + KEEP_MS)).toEqual({});
  });

  it("archiving again starts unconfirmed, and Undo or a move in Ember forgets it", () => {
    const intents = again(settle(remember({}, [mail("a"), mail("b")], t), ["a", "b"]), ["a"], t + 5);
    expect(intents.a).toMatchObject({ settled: false, again: 1, at: t + 5 });
    expect(Object.keys(forget(intents, ["a"]))).toEqual(["b"]);
  });

  it("ignores mail without a Message-ID or folder, and keeps the newest when there are too many", () => {
    expect(remember({}, [{ headerMessageId: "", folder: inbox }, { headerMessageId: "x", folder: null }], t)).toEqual({});
    const many = Object.fromEntries(Array.from({ length: 2100 }, (_, i) => [`m${i}`, { folderId: inbox.id, at: t + i, settled: true, again: 0 }]));
    const kept = prune(many, t + 2100);
    expect(Object.keys(kept)).toHaveLength(2000);
    expect(kept.m2099).toBeDefined();
    expect(kept.m0).toBeUndefined();
  });

  it("an archive the server refused waits for it, for a while, then is let go", () => {
    let intents = defer(remember({}, [mail("down"), mail("fine")], t), ["down"], t + 1000);
    expect(waiting(intents, [mail("down"), mail("fine"), mail("down", archive)], t + 60_000)).toEqual([mail("down")]);
    // Refused again later: the clock keeps its start.
    intents = defer(intents, ["down"], t + 600_000);
    expect(intents.down.pending).toBe(t + 1000);
    expect(waiting(intents, [mail("down")], t + 1000 + RETRY_FOR_MS)).toEqual([]);
    expect(prune(intents, t + 1000 + RETRY_FOR_MS).down).toBeUndefined();
    // Taken at last: archived, and watched like any other.
    const taken = settle(intents, ["down"]);
    expect(taken.down).toEqual({ folderId: inbox.id, at: t, settled: true, again: 0 });
    expect(cameBack(taken, [mail("down")], t + 120_000)).toEqual([mail("down")]);
  });

  it("says what didn't archive and where it is", () => {
    expect(failureText(1, 1, "the mail server didn't answer in time (0x804b000e)")).toBe("Couldn't archive this email: the mail server didn't answer in time (0x804b000e). It's back in the inbox.");
    expect(failureText(2, 5, "x")).toBe("Couldn't archive 2 of 5 emails: x. They're back in the inbox.");
    expect(failureText(3, 3, "x")).toBe("Couldn't archive 3 emails: x. They're back in the inbox.");
    expect(failureText(1, 1, "x", true)).toBe("Couldn't archive this email: x. It's back in the inbox, and Ember will archive it when the server answers.");
    expect(failureText(2, 2, "x", true)).toBe("Couldn't archive 2 emails: x. They're back in the inbox, and Ember will archive them when the server answers.");
  });

  it("turns Thunderbird's copy results into words", () => {
    expect(archiveStatusText(0x804b000e)).toBe("the mail server didn't answer in time (0x804b000e)");
    expect(archiveStatusText(0x804b0010)).toBe("Thunderbird is offline (0x804b0010)");
    expect(archiveStatusText(-2147467259)).toBe("the mail server didn't accept the move (0x80004005)");
    expect(archiveStatusText(0)).toBe("the mail server didn't accept the move");
  });
});

describe("calendar reads that fail", () => {
  const event = (accountId: string, id: string) => ({ accountId, id, subject: id, start: "2026-11-12T19:00:00Z", end: "2026-11-12T19:30:00Z" }) as CalendarEvent;
  it("keeps the meetings of a calendar that couldn't be read this time", () => {
    const before = [event("account6", "kept"), event("account8", "old")];
    const fresh = [event("account8", "new")];
    expect(mergeAgenda(before, fresh, [{ accountId: "account6", message: "Exchange didn't answer in time." }]).map((e) => e.id)).toEqual(["new", "kept"]);
    expect(mergeAgenda(before, fresh, []).map((e) => e.id)).toEqual(["new"]);
  });
  it("names the calendar and what Exchange said", () => {
    expect(calendarErrorText([{ accountId: "account8", name: "alex.morgan@northwind.example", message: "Exchange didn't answer in time." }, { accountId: "account6", message: "x" }]))
      .toBe("alex.morgan@northwind.example: Exchange didn't answer in time. · account6: x");
  });
});
