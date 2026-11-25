import { describe, expect, it, vi } from "vitest";
import { bestCopy, keepLinks, linkCode, mailLink, readKept, MAIL_LINK_CODE } from "../src/lib/mail-links";
import { MailLinkService } from "../src/lib/mail-link-service";
import source from "../public/experiments/maillinks/implementation.js?raw";

const header = (o: any = {}) => ({ id: 1, headerMessageId: "a1@x.org", subject: "Budget", junk: false, folder: { id: "in", accountId: "acc1", specialUse: ["inbox"] }, ...o });

describe("links to emails", () => {
  it("gives each Message-ID a short, stable code", () => {
    const code = linkCode("CAF+abc=123@mail.gmail.com");
    expect(code).toMatch(MAIL_LINK_CODE);
    expect(linkCode("<CAF+abc=123@mail.gmail.com>")).toBe(code); // with or without angle brackets
    expect(linkCode("CAF+abc=124@mail.gmail.com")).not.toBe(code);
    expect(mailLink("http://127.0.0.1:47391/", "a1@x.org")).toBe(`http://127.0.0.1:47391/email/${linkCode("a1@x.org")}`);
    // 20,000 ids, no two alike.
    expect(new Set(Array.from({ length: 20000 }, (_, i) => linkCode(`m${i}@example.org`))).size).toBe(20000);
  });

  it("keeps the codes handed out (newest 3000), and says when nothing changed", () => {
    const kept = keepLinks({}, ["a@x", "<b@x>"], 5)!;
    expect(kept).toEqual({ [linkCode("a@x")]: ["a@x", 5], [linkCode("b@x")]: ["b@x", 5] });
    expect(keepLinks(kept, ["a@x"], 9)).toBe(null);
    let many = {};
    for (let i = 0; i < 3005; i++) many = keepLinks(many, [`m${i}@x`], i) || many;
    expect(Object.keys(many)).toHaveLength(3000);
    expect(many[linkCode("m0@x")]).toBeUndefined();
    expect(readKept({ [linkCode("a@x")]: ["a@x", 1], bad: ["b@x", 1], [linkCode("c@x")]: [3, 1] })).toEqual({ [linkCode("a@x")]: ["a@x", 1] });
  });

  it("shows the Inbox copy of an email first, Trash and Spam last", () => {
    const trash = header({ id: 3, folder: { specialUse: ["trash"] } }), archive = header({ id: 2, folder: { specialUse: ["archives"] } }), inbox = header({ id: 1 });
    expect(bestCopy([trash, archive, inbox])?.id).toBe(1);
    expect(bestCopy([trash, header({ id: 4, junk: true, folder: {} })])?.id).toBe(4);
    expect(bestCopy([])).toBe(null);
  });
});

describe("the background's links", () => {
  function setup(o: { saved?: any[]; kept?: any; query?: any[]; on?: boolean; start?: () => Promise<any> } = {}) {
    const store: any = { mailLinks: o.kept || {}, emailLinks: o.on ?? true };
    const native: any = {
      storage: { local: { get: vi.fn(async (d: any) => ({ ...d, ...store })), set: vi.fn(async (v: any) => Object.assign(store, v)) } },
      messages: { query: vi.fn(async () => ({ messages: o.query || [] })) },
      sparkMailLinks: { start: vi.fn(o.start || (async () => ({ url: "http://127.0.0.1:47391" }))), stop: vi.fn(async () => {}), activate: vi.fn(async () => true) },
    };
    const deps = { headers: vi.fn(async () => o.saved || []), show: vi.fn(async () => {}), missing: vi.fn(async () => {}) };
    return { store, native, deps, service: new MailLinkService(native, deps) };
  }

  it("listens while Settings allow, and says how it went", async () => {
    const on = setup();
    expect(await on.service.configure()).toEqual({ url: "http://127.0.0.1:47391" });
    expect(on.store.mailLinkStatus).toEqual({ url: "http://127.0.0.1:47391" });
    const busy = setup({ start: async () => { throw new Error("port 47391 is in use by another program"); } });
    expect(await busy.service.configure()).toEqual({ error: "port 47391 is in use by another program" });
    const off = setup({ on: false });
    expect(await off.service.configure()).toBe(null);
    expect(off.native.sparkMailLinks.stop).toHaveBeenCalled();
    expect(off.native.sparkMailLinks.start).not.toHaveBeenCalled();
  });

  it("opens a clicked link's email (the Inbox copy) and brings Ember to the front", async () => {
    const t = setup({ saved: [header({ id: 9, folder: { specialUse: ["archives"] } }), header({ id: 7 }), header({ id: 8, headerMessageId: "other@x" })] });
    expect(await t.service.open(linkCode("a1@x.org"))).toBe(true);
    expect(t.deps.show).toHaveBeenCalledWith(7);
    expect(t.native.sparkMailLinks.activate).toHaveBeenCalled();
  });

  it("opens the email as Thunderbird has it now, not by Ember's saved (maybe out of date) id", async () => {
    const t = setup({ saved: [header({ id: 7 })], query: [header({ id: 70, folder: { specialUse: ["archives"] } }), header({ id: 71 })] });
    expect(await t.service.open(linkCode("a1@x.org"))).toBe(true);
    expect(t.native.messages.query).toHaveBeenCalledWith({ headerMessageId: "a1@x.org" });
    expect(t.deps.show).toHaveBeenCalledWith(71);
  });

  it("finds an email Ember doesn't save through its kept code, and says so when it's gone", async () => {
    const code = linkCode("old@x.org");
    const t = setup({ kept: { [code]: ["old@x.org", 1] }, query: [header({ id: 42, headerMessageId: "old@x.org" })] });
    expect(await t.service.open(code)).toBe(true);
    expect(t.native.messages.query).toHaveBeenCalledWith({ headerMessageId: "old@x.org" });
    expect(t.deps.show).toHaveBeenCalledWith(42);
    const gone = setup();
    expect(await gone.service.open(code)).toBe(false);
    expect(gone.deps.missing).toHaveBeenCalled();
    expect(gone.native.messages.query).not.toHaveBeenCalled(); // an unknown code is never looked up
  });

  it("opens an email an agent asks for", async () => {
    const t = setup({ saved: [header({ id: 5 })] });
    expect(await t.service.openEmail("<a1@x.org>")).toEqual({ opened: true, subject: "Budget" });
    expect(t.deps.show).toHaveBeenCalledWith(5);
    expect(await setup().service.openEmail("nope@x")).toEqual({ opened: false });
  });
});

describe("the links Experiment", () => {
  const experiment: { exports: any } = { exports: {} };
  new Function("module", "ExtensionCommon", source)(experiment, { ExtensionAPIPersistent: class {} });
  const { mailLinkRequest } = experiment.exports;
  const code = linkCode("a1@x.org");
  const req = (lines: string[]) => mailLinkRequest(lines.join("\r\n"), 47391);

  it("opens a link the user clicked", () => {
    expect(req([`GET /email/${code} HTTP/1.1`, "Host: 127.0.0.1:47391", "Sec-Fetch-Mode: navigate", "Sec-Fetch-Dest: document"])).toEqual({ status: 200, page: "open", code });
    expect(req([`GET /email/${code}?utm=x HTTP/1.1`, "Host: localhost:47391"])).toEqual({ status: 200, page: "open", code }); // curl, `open`
  });

  it("refuses what isn't a click on this Mac's own address", () => {
    expect(req([`GET /email/${code} HTTP/1.1`, "Host: evil.example:47391"]).status).toBe(403); // DNS rebinding
    expect(req([`GET /email/${code} HTTP/1.1`, "Host: 127.0.0.1:47391", "Sec-Fetch-Mode: no-cors", "Sec-Fetch-Dest: image"]).status).toBe(403);
    expect(req([`GET /email/${code} HTTP/1.1`, "Host: 127.0.0.1:47391", "Sec-Fetch-Mode: navigate", "Sec-Fetch-Dest: iframe"]).status).toBe(403);
    expect(req([`POST /email/${code} HTTP/1.1`, "Host: 127.0.0.1:47391"]).status).toBe(405);
    expect(req([`HEAD /email/${code} HTTP/1.1`, "Host: 127.0.0.1:47391"])).toEqual({ status: 200, page: "open" }); // a preview never opens
    expect(req(["GET /email/ABC HTTP/1.1", "Host: 127.0.0.1:47391"]).status).toBe(404);
    expect(req(["GET / HTTP/1.1", "Host: 127.0.0.1:47391"])).toEqual({ status: 200, page: "home" });
  });
});
