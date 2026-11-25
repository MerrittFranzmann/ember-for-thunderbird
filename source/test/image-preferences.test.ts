import { beforeEach, describe, expect, it, vi } from "vitest";
const saved = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
vi.mock("../src/lib/api", async original => ({ ...await original<object>(), api: { storage: { local: { get: vi.fn(async defaults => ({ ...defaults, ...saved.values })) } } } }));
import { Store } from "../src/lib/store.svelte";
beforeEach(() => { saved.values = {}; });
describe("remote-image defaults", () => {
  it("loads remote images by default when no preference was saved", async () => {
    const store = new Store(); await store.loadSettings(); expect(store.settings.loadRemoteImages).toBe(true);
  });
  it("preserves an explicit choice to block images", async () => {
    saved.values = { loadRemoteImages: false }; const store = new Store(); await store.loadSettings(); expect(store.settings.loadRemoteImages).toBe(false);
  });
});
