import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  const api = {
    messages: { sendMessage: vi.fn(async () => ({})), get: vi.fn(async () => ({ id: 7, author: "Sam <sam@northwind.example>", subject: "Plan", recipients: ["me@northwind.example"], ccList: [], bccList: [], date: new Date(), folder: { accountId: "work" } })), getFull: vi.fn(async () => ({ contentType: "text/plain", body: "Original", headers: {} })) },
    compose: { beginReply: vi.fn(async () => ({ id: 10, windowId: 20 })), sendMessage: vi.fn(async () => ({})), setComposeDetails: vi.fn() },
    windows: { update: vi.fn(async () => ({})) }, tabs: { remove: vi.fn() },
    sparkSearch: { search: vi.fn(async () => ({ messages: [], interrupted: false })) },
    sparkLinks: { access: vi.fn(async () => ({ status: "signin", title: "" })) },
  };
  const headers = [{ author: "Ada <ada@partner.org>", recipients: ["me@northwind.example"], ccList: [], bccList: [] }, { author: "me@northwind.example", recipients: ["lee@partner.org"], ccList: [], bccList: [] }];
  const store = { settings: { minimizeCompose: true, checkRecipients: true, checkLinks: true }, identities: [{ id: "identity", accountId: "work", name: "Me", email: "me@northwind.example" }], me: new Set(["me@northwind.example"]), toast: vi.fn(), threadPeople: () => ["sam@northwind.example", "me@northwind.example"] };
  return { api, store, headers };
});
vi.mock("../src/lib/api", () => ({ api: mocks.api, mailCache: { all: () => mocks.headers }, env: { tb: 158, hasBackgroundSend: true, hasBackgroundSave: true, hasUserAction: true } }));
vi.mock("../src/lib/store.svelte", () => ({ store: mocks.store }));
import { composer } from "../src/lib/compose.svelte";

beforeEach(() => { vi.clearAllMocks(); composer.close(); composer.getEditorHtml = () => "<p>Hello</p>"; mocks.store.settings.checkRecipients = true; mocks.store.settings.checkLinks = true; });
describe("before you send", () => {
  it("holds an email to a never-used domain until the user sends anyway", async () => {
    composer.openNew([{ name: "Jo", email: "jo@newco.io" }]);
    expect(await composer.send()).toBe(false);
    expect(composer.review?.map((w) => w.kind)).toEqual(["newDomain"]);
    // Older mail (beyond the saved 90 days) was asked about that domain.
    expect(mocks.api.sparkSearch.search).toHaveBeenCalledWith("@newco.io", { headersOnly: true, limit: 1 });
    expect(mocks.api.messages.sendMessage).not.toHaveBeenCalled();
    expect(await composer.sendAnyway()).toBe(true);
    expect(mocks.api.messages.sendMessage).toHaveBeenCalledOnce();
  });
  it("doesn't ask when Thunderbird has older mail with that domain, or when nothing is unusual", async () => {
    mocks.api.sparkSearch.search.mockResolvedValueOnce({ messages: [{ id: 1 }], interrupted: false } as any);
    composer.openNew([{ name: "Jo", email: "jo@oldco.io" }]);
    expect(await composer.send()).toBe(true);
    composer.openNew([{ name: "Ada", email: "ada@partner.org" }]);
    expect(await composer.send()).toBe(true);
    expect(mocks.api.messages.sendMessage).toHaveBeenCalledTimes(2);
  });
  it("fixes a typo in place and sends without asking again", async () => {
    composer.openNew([{ name: "Ada", email: "ada@partner.ogr" }]);
    expect(await composer.send()).toBe(false);
    const [typo] = composer.review!;
    expect(typo.kind).toBe("typo");
    await composer.fix(typo);
    expect(composer.draft!.to).toEqual([{ name: "Ada", email: "ada@partner.org" }]);
    expect(composer.review).toBeNull();
    expect(await composer.send()).toBe(true);
  });
  it("checks shared links, and flags people added to a reply", async () => {
    await composer.openReply(7, false);
    composer.draft!.to = [...composer.draft!.to, { name: "Ada", email: "ada@partner.org" }];
    composer.getEditorHtml = () => '<p>See <a href="https://northwind.sharepoint.com/:w:/s/Team/Eabc">the plan</a></p>';
    expect(await composer.send()).toBe(false);
    expect(mocks.api.sparkLinks.access).toHaveBeenCalledWith("https://northwind.sharepoint.com/:w:/s/Team/Eabc");
    expect(composer.review!.map((w) => w.kind)).toEqual(["notInThread", "linkAccess"]);
  });
  it("is off with both settings off", async () => {
    mocks.store.settings.checkRecipients = false; mocks.store.settings.checkLinks = false;
    composer.openNew([{ name: "Jo", email: "jo@newco.io" }]);
    expect(await composer.send()).toBe(true);
    expect(mocks.api.sparkSearch.search).not.toHaveBeenCalled();
  });
});
