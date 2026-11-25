import { describe, expect, it } from "vitest";
import { attachmentCutoff, collectAttachments, excludedAttachmentFolders, filterAttachments, isFileAttachment, isReceivedAttachmentMessage, normalizeDomain, senderDomain, type ReceivedAttachment } from "../src/lib/attachments";
import type { MessageAttachment, MessageHeader } from "../src/lib/types";

const now = new Date("2026-10-26T15:00:00Z");
const message = (p: Partial<MessageHeader> = {}): MessageHeader => ({ id: 1, date: now, author: "Ada <ada@example.org>", recipients: ["me@work.org"], ccList: [], bccList: [], subject: "Plan", headerMessageId: "one", size: 10, tags: [], flagged: false, folder: { id: "inbox", name: "Inbox", path: "/Inbox" }, ...p });
const file = (p: Partial<MessageAttachment> = {}): MessageAttachment => ({ name: "plan.pdf", contentType: "application/pdf", partName: "1.2", size: 30, ...p });
const item = (id: number, author = "Ada <ada@example.org>", p: Partial<MessageHeader> = {}): ReceivedAttachment => ({ key: `${id}:1.2`, message: message({ id, author, ...p }), attachment: file(), domain: senderDomain(author) || "" });

describe("approved domains", () => {
  it("normalizes case, trailing dot and IDN", () => {
    expect(normalizeDomain(" Example.ORG. ")).toBe("example.org");
    expect(normalizeDomain("bücher.de")).toBe("xn--bcher-kva.de");
  });
  it("rejects URLs, emails, wildcards and malformed hostnames", () => {
    for (const s of ["https://example.org", "me@example.org", "*.example.org", "example.org/evil", "foo", "a..org", "-foo.org", "example.org:8080", "example.org?x", "example.org\\evil", "example.org%00"]) expect(normalizeDomain(s), s).toBeNull();
  });
  it("uses the parsed mailbox, never a display-name domain", () => {
    expect(senderDomain('"example.org" <spam@evil.org>')).toBe("evil.org");
    expect(senderDomain("broken@@example.org")).toBeNull();
  });
  it("matches exactly, never lookalikes or unapproved subdomains", () => {
    const items = [item(1), item(2, "spam@evil-example.org"), item(3, "spam@example.org.evil.org"), item(4, "ada@sub.example.org")];
    expect(filterAttachments(items, { approvedOnly: true, domains: ["example.org"], query: "", now }).map((x) => x.message.id)).toEqual([1]);
    expect(filterAttachments(items, { approvedOnly: true, domains: [], query: "", now })).toEqual([]);
    expect(filterAttachments(items, { approvedOnly: false, domains: [], query: "", now })).toHaveLength(4);
  });
});

describe("received attachment scope", () => {
  it("includes the 90-day boundary and excludes future, old, junk, own and sent messages", () => {
    expect(isReceivedAttachmentMessage(message({ date: attachmentCutoff(now) }), new Set(), new Set(), now)).toBe(true);
    const excluded = new Set(["sent"]);
    for (const p of [{ date: new Date(+attachmentCutoff(now) - 1) }, { date: new Date(+now + 1) }, { date: new Date("invalid") }, { junk: true }, { author: "Me <me@work.org>" }, { folder: { id: "sent", name: "Sent", path: "/Sent" } }]) {
      expect(isReceivedAttachmentMessage(message(p), new Set(["me@work.org"]), excluded, now)).toBe(false);
    }
  });
  it("excludes descendants of special folders while keeping archives", () => {
    const folders = [{ id: "trash", name: "Trash", path: "/Trash", specialUse: ["trash"], subFolders: [{ id: "child", name: "Child", path: "/Trash/Child" }] }, { id: "archive", name: "Archive", path: "/Archive", specialUse: ["archives"] }];
    expect([...excludedAttachmentFolders(folders)]).toEqual(["trash", "child"]);
  });
  it("keeps text files and excludes inline resources", () => {
    expect(isFileAttachment(file({ name: "notes.txt", contentType: "text/plain" }))).toBe(true);
    expect(isFileAttachment(file({ contentId: "logo" }))).toBe(false);
    expect(isFileAttachment(file({ contentDisposition: "inline" }))).toBe(false);
  });
  it("searches filename, sender and subject and orders newest first", () => {
    const items = [item(1, "ada@example.org", { date: new Date(+now - 10) }), item(2), item(3, "other@work.org", { subject: "Budget" })];
    expect(filterAttachments(items, { approvedOnly: false, domains: [], query: "PDF", now }).map((x) => x.message.id)).toEqual([2, 3, 1]);
    expect(filterAttachments(items, { approvedOnly: false, domains: [], query: "budget", now }).map((x) => x.message.id)).toEqual([3]);
    expect(filterAttachments(items, { approvedOnly: false, domains: [], query: "other@work", now })).toHaveLength(1);
  });
});

describe("attachment collection", () => {
  it("keeps at most two requests in flight and reports partial failures", async () => {
    let running = 0, max = 0;
    const done: number[] = [], failed: number[] = [];
    await collectAttachments([1, 2, 3, 4].map((id) => message({ id })), {
      active: () => true,
      list: async (id) => {
        running++; max = Math.max(max, running);
        await new Promise((r) => setTimeout(r, 1));
        running--;
        if (id === 2) throw new Error("Offline");
        return [file(), file({ contentId: "inline" })];
      },
      onMessage: (m, files) => { expect(files).toHaveLength(1); done.push(m.id); },
      onError: (m) => failed.push(m.id),
    });
    expect(max).toBe(2);
    expect(done.sort()).toEqual([1, 3, 4]);
    expect(failed).toEqual([2]);
  });
  it("discards stale results after navigation and starts no further work", async () => {
    let active = true, calls = 0, delivered = 0;
    await collectAttachments([1, 2, 3, 4].map((id) => message({ id })), {
      active: () => active,
      list: async () => { calls++; await Promise.resolve(); active = false; return [file()]; },
      onMessage: () => delivered++, onError: () => delivered++,
    });
    expect(calls).toBe(2);
    expect(delivered).toBe(0);
  });
});
