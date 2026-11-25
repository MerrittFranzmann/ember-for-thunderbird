import { describe, expect, it } from "vitest";
import { ignoredSenders, isBulk, parseUnsubscribe, writtenTo } from "../src/lib/ignored-senders";
import type { MessageHeader } from "../src/lib/types";

const NOW = +new Date(2026, 9, 29, 12);
const DAY = 86400000;
let seq = 0;
const mail = (author: string, { daysAgo = 1, folder = "inbox", ...props }: Partial<Omit<MessageHeader, "folder">> & { daysAgo?: number; folder?: string } = {}): MessageHeader => ({
  id: ++seq, author, subject: `News ${seq}`, date: new Date(NOW - daysAgo * DAY), read: false, flagged: false, recipients: [], ccList: [], bccList: [],
  headerMessageId: `m${seq}@x`, folder: { id: folder, accountId: "a", name: "", path: "" }, ...props,
} as MessageHeader);
const roles: Record<string, string> = { inbox: "inbox", sent: "sent", trash: "trash", archive: "archives", junk: "junk" };
const roleOf = (id?: string) => (id && roles[id]) || null;
const many = (author: string, n: number, props: Parameters<typeof mail>[1] = {}) => Array.from({ length: n }, (_, i) => mail(author, { daysAgo: i + 1, ...props }));

describe("senders you ignore", () => {
  const me = new Set(["me@northwind.example"]);
  it("lists senders with 5+ emails you opened at most 10% of, most ignored first", () => {
    const headers = [
      ...many("Shop <deals@shop.com>", 12),
      ...many("Digest <digest@news.org>", 5),
      ...many("Few <few@x.org>", 4),
      ...many("Read <read@x.org>", 10).map((m, i) => ({ ...m, read: i < 2 })), // 20% opened
      ...many("One <one@x.org>", 10).map((m, i) => ({ ...m, read: i === 0 })), // 10% opened: still ignored
    ];
    const list = ignoredSenders(headers, { me, written: new Set(), roleOf, now: NOW });
    expect(list.map((s) => [s.address, s.total, s.opened])).toEqual([["deals@shop.com", 12, 0], ["one@x.org", 10, 1], ["digest@news.org", 5, 0]]);
    expect(list[0]).toMatchObject({ name: "Shop", inInbox: 12, subjects: ["News 1", "News 2", "News 3"] });
  });
  it("counts archived mail but not sent, Trash, Spam or older than 90 days; never people you write to, kept or pinned senders, or you", () => {
    const sent = mail("me@northwind.example", { folder: "sent", recipients: ["Pal <pal@x.org>"], ccList: ["cc@x.org"] });
    const headers = [
      sent,
      ...many("pal@x.org", 6), ...many("cc@x.org", 6), ...many("kept@x.org", 6), ...many("me@northwind.example", 6),
      ...many("pin@x.org", 6).map((m, i) => ({ ...m, flagged: i === 3 })),
      ...many("mixed@x.org", 3), ...many("mixed@x.org", 2, { folder: "archive" }), ...many("mixed@x.org", 4, { folder: "trash" }),
      ...many("old@x.org", 3), ...many("old@x.org", 4, { daysAgo: 120 }), ...many("spam@x.org", 6, { folder: "junk" }),
    ];
    const written = writtenTo(headers, roleOf);
    expect([...written].sort()).toEqual(["cc@x.org", "pal@x.org"]);
    const list = ignoredSenders(headers, { me, written, roleOf, kept: ["Kept@x.org"], now: NOW });
    expect(list.map((s) => [s.address, s.total, s.inInbox])).toEqual([["mixed@x.org", 5, 3]]);
  });
});

describe("unsubscribing", () => {
  it("reads one-click, web and email unsubscribes", () => {
    expect(parseUnsubscribe("<mailto:unsub@shop.com?subject=Remove%20me>, <https://shop.com/u?id=1>", "List-Unsubscribe=One-Click"))
      .toEqual({ web: "https://shop.com/u?id=1", oneClick: "https://shop.com/u?id=1", mailto: { to: "unsub@shop.com", subject: "Remove me", body: "Please unsubscribe me." } });
    expect(parseUnsubscribe("<https://shop.com/u?id=1>")).toEqual({ web: "https://shop.com/u?id=1" });
    expect(parseUnsubscribe("<mailto:leave@list.org>")).toEqual({ mailto: { to: "leave@list.org", subject: "Unsubscribe", body: "Please unsubscribe me." } });
    expect(parseUnsubscribe("<http://insecure.example/u>")).toBeNull();
    expect(parseUnsubscribe(undefined)).toBeNull();
  });
  it("knows bulk mail by its list headers or category", () => {
    expect(isBulk({ "list-unsubscribe": ["<https://x>"] }, "people")).toBe(true);
    expect(isBulk({ precedence: ["bulk"] }, "people")).toBe(true);
    expect(isBulk({}, "newsletter")).toBe(true);
    expect(isBulk({}, "people")).toBe(false);
  });
});
