import { describe, expect, it } from "vitest";
import { fingerprint, HeaderInterner, packFolders, unpackFolders } from "../src/lib/intern";

describe("header interning", () => {
  it("shares equal folders, senders and recipient lists between headers", () => {
    const interner = new HeaderInterner();
    const make = () => ({ folder: { id: "f1", name: "Inbox", path: "/Inbox", specialUse: ["inbox"] }, author: "Ada <ada@x.org>", recipients: ["Me <me@x.org>"], ccList: [], subject: "Hi" });
    const a = interner.header(make()), b = interner.header(make());
    expect(b.folder).toBe(a.folder);
    expect(b.recipients).toBe(a.recipients);
    expect(b.author).toBe(a.author);
    expect(b.ccList).not.toBe(a.ccList); // empty lists stay separate
    expect(b).toEqual(make());
  });
  it("keeps folders that differ (a renamed folder) apart", () => {
    const interner = new HeaderInterner();
    const a = interner.header({ folder: { id: "f1", name: "Old" } });
    const b = interner.header({ folder: { id: "f1", name: "New" } });
    expect(b.folder).not.toBe(a.folder);
    expect((b.folder as any).name).toBe("New");
  });
  it("leaves non-string lists and missing fields alone", () => {
    const interner = new HeaderInterner();
    const odd = { recipients: [1, 2] as any, author: undefined };
    expect(interner.header(odd)).toEqual({ recipients: [1, 2], author: undefined });
  });
  it("fingerprints tell different saved values apart", () => {
    expect(fingerprint('{"read":true}')).not.toBe(fingerprint('{"read":false}'));
    expect(fingerprint("same")).toBe(fingerprint("same"));
    const seen = new Set<number>();
    for (let i = 0; i < 20000; i++) seen.add(fingerprint(`{"id":${i},"subject":"Message ${i}"}`));
    expect(seen.size).toBe(20000);
  });
  it("sends each folder once per page and restores it on arrival", () => {
    const inbox = { id: "i", name: "Inbox" }, sent = { id: "s", name: "Sent" };
    const headers = [{ id: 1, folder: inbox }, { id: 2, folder: inbox }, { id: 3, folder: sent }, { id: 4 }];
    const packed = packFolders(headers);
    expect(packed.folders).toEqual([inbox, sent]);
    expect(packed.headers.map((h: any) => h.folderRef)).toEqual([0, 0, 1, undefined]);
    const real = { id: "account2://Inbox", accountId: "account2", name: "Inbox", path: "/Inbox", specialUse: ["inbox"], type: "inbox", isFavorite: false, isRoot: false, isTag: false, isUnified: false, isVirtual: false };
    const many = Array.from({ length: 50 }, (_, i) => ({ id: i, subject: `Message ${i}`, folder: real }));
    expect(JSON.stringify(packFolders(many)).length).toBeLessThan(JSON.stringify(many).length * 0.5);
    const page = unpackFolders(structuredClone({ ...packed, next: null }));
    expect(page.headers).toEqual(headers);
    expect((page as any).folders).toBeUndefined();
    expect((page.headers[0] as any).folder).toBe((page.headers[1] as any).folder); // one shared object after the clone
  });
});
