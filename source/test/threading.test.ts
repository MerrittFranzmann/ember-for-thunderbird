import { describe, expect, it } from "vitest";
import { distinctCopies, groupConversations, messageId, relatedConversation } from "../src/lib/threading";
import type { MessageHeader } from "../src/lib/types";

let n = 0;
function m(p: Partial<MessageHeader>): MessageHeader {
  n++;
  return { id: n, date: new Date(2026, 9, n), author: "", subject: "", flagged: false, recipients: [], ccList: [], bccList: [], headerMessageId: `m${n}`, size: 1, tags: [], read: true, ...p } as MessageHeader;
}
const me = new Set(["me@x.org"]);
const opts = (meta: Record<string, string[]> = {}) => ({
  me,
  meta: (x: MessageHeader) => (meta[x.headerMessageId] ? { refs: meta[x.headerMessageId] } : undefined),
  category: () => "people" as const,
  hasAttachment: () => false,
});

describe("groupConversations", () => {
  it("groups by references", () => {
    const a = m({ author: "Ada <ada@x.org>", subject: "Plan", recipients: ["me@x.org"] });
    const b = m({ author: "Bob <bob@y.org>", subject: "Different", recipients: ["me@x.org"] });
    const convs = groupConversations([a, b], opts({ [b.headerMessageId]: [a.headerMessageId] }));
    expect(convs).toHaveLength(1);
    expect(convs[0].count).toBe(2);
    expect(convs[0].ids[0]).toBe(b.id); // newest first
  });
  it("groups same subject + shared participant within the window", () => {
    const a = m({ author: "Ada <ada@x.org>", subject: "Lunch", recipients: ["me@x.org"], read: false });
    const b = m({ author: "Ada <ada@x.org>", subject: "Lunch", recipients: ["me@x.org"] });
    const c = m({ author: "Cy <cy@z.org>", subject: "Lunch", recipients: ["me@x.org"] });
    const convs = groupConversations([a, b, c], opts());
    expect(convs.map((x) => x.count).sort()).toEqual([1, 2]);
    expect(convs.find((x) => x.count === 2)!.unread).toBe(1);
  });
  it("puts everyone's answers to one meeting in one row, even from different people", () => {
    const a = m({ author: "Chris <chris@x.org>", subject: "Accepted: Last day in office", recipients: ["me@x.org"] });
    const b = m({ author: "Karen <karen@y.org>", subject: "Declined: Last day in office", recipients: ["me@x.org"] });
    const c = m({ author: "Mary <mary@z.org>", subject: "Tentative: Last day in office", recipients: ["me@x.org"] });
    const other = m({ author: "Ada <ada@x.org>", subject: "Accepted: Board review", recipients: ["me@x.org"] });
    const plain = m({ author: "Bob <bob@q.org>", subject: "Last day in office", recipients: ["me@x.org"] });
    const late = m({ author: "Cy <cy@q.org>", subject: "Accepted: Last day in office", date: new Date(2027, 5, 1) });
    const convs = groupConversations([a, b, c, other, plain, late], opts());
    expect(convs.map((x) => x.count).sort()).toEqual([1, 1, 1, 3]);
    expect(convs.find((x) => x.count === 3)!.senders).toEqual(["Mary", "Karen", "Chris"]);
  });
  it("does not merge across a long time gap", () => {
    const a = m({ author: "Ada <ada@x.org>", subject: "Weekly sync", date: new Date(2026, 0, 1) });
    const b = m({ author: "Ada <ada@x.org>", subject: "Weekly sync", date: new Date(2026, 5, 1) });
    expect(groupConversations([a, b], opts())).toHaveLength(2);
  });
  it("can be disabled", () => {
    const a = m({ author: "Ada <ada@x.org>", subject: "Lunch" });
    const b = m({ author: "Ada <ada@x.org>", subject: "Lunch" });
    expect(groupConversations([a, b], { ...opts(), enabled: false })).toHaveLength(2);
  });
});

describe("conversation regressions", () => {
  it("groups replies sharing an absent parent, including bracketed IDs", () => {
    const a = m({ author: "a@x.org", subject: "One", headerMessageId: "<a>" });
    const b = m({ author: "b@x.org", subject: "Two", headerMessageId: "b" });
    expect(groupConversations([a, b], opts({ "<a>": ["<missing>"], b: ["missing"] }))).toHaveLength(1);
  });
  it("keeps explicit unrelated chains with reused subjects separate", () => {
    const a = m({ author: "ada@x.org", subject: "Weekly update", date: new Date(2026, 9, 1) });
    const b = m({ author: "ada@x.org", subject: "Weekly update", date: new Date(2026, 9, 2) });
    expect(groupConversations([a, b], opts({ [a.headerMessageId]: ["root-a"], [b.headerMessageId]: ["root-b"] }))).toHaveLength(2);
  });
  it("includes sent replies across folders and removes copies by Message-ID", () => {
    const a = m({ author: "ada@x.org", subject: "Plan", date: new Date(2026, 9, 1) });
    const b = m({ author: "me@x.org", recipients: ["ada@x.org"], subject: "Re: Plan", date: new Date(2026, 9, 2) });
    const copy = { ...b, id: b.id + 1000 };
    expect(relatedConversation([a], [b, copy], opts({ [b.headerMessageId]: [a.headerMessageId] })).map((x) => x.id)).toEqual([b.id, a.id]);
  });
  it("keeps missing Message-IDs distinct and uses deterministic date ties", () => {
    const a = m({ author: "ada@x.org", subject: "Plan", headerMessageId: "", date: new Date(2026, 9, 1) });
    const b = m({ author: "ada@x.org", subject: "Plan", headerMessageId: "", date: a.date });
    expect(relatedConversation([a], [b], opts()).map((x) => x.id)).toEqual([b.id, a.id]);
  });
  it("includes changed subjects with explicit references and excludes strangers", () => {
    const a = m({ author: "ada@x.org", subject: "Plan" });
    const b = m({ author: "bob@x.org", subject: "New title" });
    const c = m({ author: "stranger@x.org", subject: "Plan" });
    expect(relatedConversation([a], [b, c], opts({ [b.headerMessageId]: [a.headerMessageId] })).map((x) => x.id)).toEqual([b.id, a.id]);
  });
});

describe("messageId", () => {
  it("matches trim + strip one leading < and trailing >", () => {
    const reference = (v: string) => v.trim().replace(/^<|>$/g, "");
    for (const v of ["<a@b>", "a@b", " <a@b> ", "<a@b", "a@b>", "<", ">", "<>", "", "  ", "<<a@b>>", "\t<x@y>\n"]) expect(messageId(v)).toBe(reference(v));
  });
});

describe("Gmail label copies", () => {
  const folder = (path: string, specialUse: string[] = []) => ({ id: `gmail:/${path}`, path: `/${path}`, specialUse }) as any;
  it("keeps one copy per email: Inbox, else Sent, else All Mail, else the first", () => {
    const starred = m({ headerMessageId: "<same@x>", folder: folder("[Gmail]/Starred"), flagged: true });
    const all = m({ headerMessageId: "same@x", folder: folder("[Gmail]/All Mail", ["archives"]), flagged: true });
    const inbox = m({ headerMessageId: "same@x", folder: folder("INBOX", ["inbox"]), flagged: true });
    const other = m({ headerMessageId: "other@x", folder: folder("[Gmail]/Important") });
    const noId = m({ headerMessageId: "" });
    expect(distinctCopies([starred, all, inbox, other, noId]).map((x) => x.id)).toEqual([inbox.id, other.id, noId.id]);
    expect(distinctCopies([starred, all]).map((x) => x.id)).toEqual([all.id]);
  });
  it("never gives two conversations the same key (a duplicate key stops the list rendering)", () => {
    // Copies without references aren't joined, and ungrouped lists key each message by its Message-ID.
    const a = m({ headerMessageId: "dup@x", author: "News <n@news.com>", subject: "A" });
    const b = m({ headerMessageId: "dup@x", author: "News <n@news.com>", subject: "B" });
    for (const enabled of [true, false]) {
      const keys = groupConversations([a, b], { ...opts(), category: () => "newsletter" as const, enabled }).map((c) => c.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
