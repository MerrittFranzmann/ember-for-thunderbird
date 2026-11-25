import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
  const api = {
    messages: { sendMessage: vi.fn(async () => ({ mode: "sendNow", headerMessageId: "<sent-1@example.org>", messages: [] })) },
    compose: {}, runtime: { sendMessage: vi.fn(async () => {}) },
  };
  const store: any = {
    settings: { minimizeCompose: true, signatures: [{ id: "sig-short", name: "Short", html: "M." }] },
    identities: [{ id: "work", accountId: "work", name: "Me", email: "me@example.org", signature: "Me\nNorthwind", signatureIsPlainText: true }, { id: "home", accountId: "home", name: "Me", email: "me@home.org" }],
    me: new Set(["me@example.org"]), toast: vi.fn(),
    setSetting: vi.fn(async (k: string, v: any) => { store.settings[k] = v; }),
  };
  return { api, store };
});
vi.mock("../src/lib/api", () => ({ api: mocks.api, env: { tb: 158, hasBackgroundSend: true, hasBackgroundSave: true, hasUserAction: true } }));
vi.mock("../src/lib/store.svelte", () => ({ store: mocks.store }));
import { composer, signatureContent } from "../src/lib/compose.svelte";
const to = [{ name: "Ana", email: "ana@example.org" }];
beforeEach(() => { vi.clearAllMocks(); composer.close(); composer.getEditorHtml = () => "<p>Hi</p>"; });

describe("signature per email", () => {
  it("starts with the From address's Thunderbird signature and offers saved ones and none", () => {
    composer.openNew(to);
    expect(composer.draft!.signature).toBe("default");
    expect(composer.draft!.html).toContain("-- <br>Me<br>Northwind");
    expect(composer.signatureFor("work", "sig-short")).toBe('<div class="moz-signature" spellcheck="false">-- <br>M.</div>');
    expect(composer.signatureFor("work", "none")).toBe("");
    expect(composer.signatureFor("home")).toBe(""); // no signature set for that address
  });
  it("keeps a chosen signature when the From address changes; Thunderbird's follows the address", () => {
    composer.openNew(to);
    const rev = composer.sigRev;
    composer.setIdentity("home");
    expect(composer.sigRev).toBe(rev + 1);
    composer.chooseSignature("sig-short");
    const chosen = composer.sigRev;
    composer.setIdentity("work");
    expect(composer.sigRev).toBe(chosen);
    expect(composer.draft!.signature).toBe("sig-short");
  });
  it("saves this email's signature as a new one and updates a saved one", async () => {
    composer.openNew(to);
    const id = await composer.saveSignature("Formal", "Alex Morgan<br>Northwind");
    expect(mocks.store.settings.signatures.find((s: any) => s.id === id)).toMatchObject({ name: "Formal", html: "Alex Morgan<br>Northwind" });
    expect(composer.draft!.signature).toBe(id);
    await composer.updateSignature("sig-short", "MF");
    expect(mocks.store.settings.signatures.find((s: any) => s.id === "sig-short").html).toBe("MF");
  });
  it("reads a signature block's content without the separator line", () => {
    expect(signatureContent("-- <br>Me<br>Northwind")).toBe("Me<br>Northwind");
    expect(signatureContent("--&nbsp;<br/>X")).toBe("X");
  });
});

describe("remind me if no reply", () => {
  it("registers the sent email's Message-ID after sending", async () => {
    composer.openNew(to); composer.draft!.subject = "Budget"; composer.draft!.followUp = 3;
    expect(await composer.send()).toBe(true);
    expect(mocks.api.runtime.sendMessage).toHaveBeenCalledWith({ type: "spark:follow-up", add: expect.objectContaining({ mid: "sent-1@example.org", subject: "Budget", to: ["Ana <ana@example.org>"], state: "waiting" }) });
    expect(mocks.store.toast).toHaveBeenCalledWith(expect.objectContaining({ text: "Message sent · reminder in 3 days if no reply" }));
  });
  it("sends without a reminder by default", async () => {
    composer.openNew(to);
    expect(await composer.send()).toBe(true);
    expect(mocks.api.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
