import { describe, expect, it, vi } from "vitest";
import { UpdateService } from "../src/lib/update-service";
import source from "../public/experiments/update/implementation.js?raw";

const module = { exports: {} as any };
new Function("module", "ExtensionCommon", source).call({}, module, { ExtensionAPI: class {} });
const { parseFeed } = module.exports;

function native({ offered = "0.1.65", current = "0.1.64", temporary = false, inUse = false as boolean | "no-page", saved = {} as any, install = vi.fn(async () => true) } = {}) {
  const store: any = { autoUpdate: true, updateFolder: "", ...saved };
  return {
    store,
    sparkUpdate: { check: vi.fn(async () => ({ current, temporary, version: offered, newer: offered > current })), install },
    storage: { local: {
      get: vi.fn(async (defaults: any) => ({ ...defaults, ...Object.fromEntries(Object.keys(defaults).filter((k) => k in store).map((k) => [k, store[k]])) })),
      set: vi.fn(async (values: any) => { Object.assign(store, values); }),
      remove: vi.fn(async (key: string) => { delete store[key]; }),
    } },
    runtime: {
      getManifest: () => ({ version: current }),
      sendMessage: vi.fn(async () => { if (inUse === "no-page") throw new Error("Receiving end does not exist"); return inUse; }),
    },
    alarms: { get: vi.fn(async () => null), create: vi.fn(async () => {}) },
  };
}
const closed = async () => ({ open: false, minimized: false });

describe("update service", () => {
  it("installs a newer version when no Ember page is open, remembering how Ember was", async () => {
    const api = native({ inUse: "no-page" });
    await new UpdateService(api, async () => ({ open: true, minimized: true })).check();
    expect(api.sparkUpdate.install).toHaveBeenCalledWith("0.1.65", undefined);
    expect(api.store.sparkResume).toMatchObject({ open: true, minimized: true });
    expect(api.store.updateStatus).toMatchObject({ ready: "0.1.65", installing: true });
  });
  it("waits while Ember is in use, then installs on Update now", async () => {
    const api = native({ inUse: true });
    const updates = new UpdateService(api, closed);
    expect(await updates.check()).toMatchObject({ ready: "0.1.65" });
    expect(api.sparkUpdate.install).not.toHaveBeenCalled();
    await updates.check("now");
    expect(api.sparkUpdate.install).toHaveBeenCalledTimes(1);
  });
  it("never installs automatically when turned off or temporarily installed", async () => {
    for (const api of [native({ saved: { autoUpdate: false } }), native({ temporary: true })]) {
      await new UpdateService(api, closed).check();
      expect(api.sparkUpdate.install).not.toHaveBeenCalled();
      expect(api.store.updateStatus.ready).toBe("0.1.65");
    }
  });
  it("reports up to date, and a failed install without reopening anything", async () => {
    const current = native({ offered: "0.1.64" });
    expect(await new UpdateService(current, closed).check()).toMatchObject({ ready: null, current: "0.1.64" });
    const failing = native({ install: vi.fn(async () => { throw new Error("doesn't match latest.json"); }) });
    const status = await new UpdateService(failing, closed).check();
    expect(status?.error).toContain("doesn't match");
    expect(failing.store.sparkResume).toBeUndefined();
    expect(failing.store.updateStatus.installing).toBeUndefined();
  });
  it("runs one check at a time: start-up's overlapping checks share it", async () => {
    const api = native({ inUse: "no-page" });
    const updates = new UpdateService(api, closed);
    await Promise.all([updates.check(), updates.check(), updates.check()]);
    expect(api.sparkUpdate.check).toHaveBeenCalledTimes(1);
    expect(api.sparkUpdate.install).toHaveBeenCalledTimes(1);
  });
  it("uses the update folder setting", async () => {
    const api = native({ saved: { updateFolder: "/tmp/feed" }, inUse: "no-page" });
    await new UpdateService(api, closed).check();
    expect(api.sparkUpdate.check).toHaveBeenCalledWith("/tmp/feed", false);
    expect(api.sparkUpdate.install).toHaveBeenCalledWith("0.1.65", "/tmp/feed");
  });
});

describe("update feed (latest.json)", () => {
  const sha = "a".repeat(64);
  it("accepts plain file names in the folder", () => {
    expect(parseFeed({ version: "0.1.65", xpi: "thunderbird-spark-0.1.65.xpi", sha256: sha.toUpperCase(), notes: "whats-new-0.1.65.md" }))
      .toEqual({ version: "0.1.65", xpi: "thunderbird-spark-0.1.65.xpi", sha256: sha, notes: "whats-new-0.1.65.md" });
    expect(parseFeed({ version: "0.1.65", xpi: "spark.xpi", sha256: sha }).notes).toBeNull();
  });
  it("rejects paths outside the folder, bad versions and missing hashes", () => {
    expect(() => parseFeed({ version: "0.1.65", xpi: "../evil.xpi", sha256: sha })).toThrow();
    expect(() => parseFeed({ version: "0.1.65", xpi: "/tmp/evil.xpi", sha256: sha })).toThrow();
    expect(() => parseFeed({ version: "latest", xpi: "spark.xpi", sha256: sha })).toThrow();
    expect(() => parseFeed({ version: "0.1.65", xpi: "spark.zip", sha256: sha })).toThrow();
    expect(() => parseFeed({ version: "0.1.65", xpi: "spark.xpi", sha256: "abc" })).toThrow();
    expect(parseFeed({ version: "0.1.65", xpi: "spark.xpi", sha256: sha, notes: "../x.md" }).notes).toBeNull();
  });
});

describe("the signed public feed", () => {
  const { parseRemoteFeed, signedText, verifyFeed, EMBER_RELEASES, EMBER_FEED } = module.exports;
  const sha = "ab".repeat(32);
  const base = { version: "1.0.1", url: `${EMBER_RELEASES}download/v1.0.1/ember-1.0.1.xpi`, sha256: sha, signature: "AAAA" };
  it("reads Ember's GitHub releases", () => {
    expect(EMBER_FEED).toBe("https://github.com/MerrittFranzmann/ember-for-thunderbird/releases/latest/download/latest.json");
    expect(parseRemoteFeed(base)).toEqual({ ...base, notes: `${EMBER_RELEASES}tag/v1.0.1` });
  });
  it("accepts only an XPI among Ember's own releases, with a hash and a signature", () => {
    expect(() => parseRemoteFeed({ ...base, url: "https://evil.example/ember-1.0.1.xpi" })).toThrow(/url/);
    expect(() => parseRemoteFeed({ ...base, url: `${EMBER_RELEASES}download/v1.0.1/../../x.xpi` })).toThrow(/url/);
    expect(() => parseRemoteFeed({ ...base, url: `${EMBER_RELEASES}download/v1.0.1/ember.zip` })).toThrow(/url/);
    expect(() => parseRemoteFeed({ ...base, signature: "" })).toThrow(/signature/);
    expect(() => parseRemoteFeed({ ...base, sha256: "xyz" })).toThrow();
    expect(parseRemoteFeed({ ...base, notes: "https://evil.example/" }).notes).toBe(`${EMBER_RELEASES}tag/v1.0.1`);
  });
  it("installs only what the publisher's key signed", async () => {
    const subtle = globalThis.crypto.subtle;
    const keys = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const spki = btoa(String.fromCharCode(...new Uint8Array(await subtle.exportKey("spki", keys.publicKey))));
    const sign = async (feed: any) => btoa(String.fromCharCode(...new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, new TextEncoder().encode(signedText(feed))))));
    const feed = { ...base, signature: "" };
    feed.signature = await sign(feed);
    expect(await verifyFeed(feed, subtle, spki)).toBe(true);
    // Another version or another file under the same signature: refused.
    expect(await verifyFeed({ ...feed, version: "9.9.9" }, subtle, spki)).toBe(false);
    expect(await verifyFeed({ ...feed, sha256: "cd".repeat(32) }, subtle, spki)).toBe(false);
    // The built-in key didn't sign it.
    expect(await verifyFeed(feed, subtle)).toBe(false);
    expect(await verifyFeed({ ...feed, signature: "bm90IGEgc2lnbmF0dXJl" }, subtle, spki)).toBe(false);
  });
});
