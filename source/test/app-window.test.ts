import { describe, expect, it, vi } from "vitest";
import { AppWindow } from "../src/lib/app-window";
const APP = "moz-extension://spark/app.html";
function native(windows: any[], tabs: any[] = [], saved: any = {}) {
  return {
    windows: {
      getAll: vi.fn(async ({ windowTypes }: any) => windows.filter((w) => windowTypes.includes(w.type))),
      // Thunderbird can leave these pending; Ember must not wait for them.
      update: vi.fn(() => new Promise(() => {})),
      create: vi.fn(() => new Promise(() => {})),
    },
    tabs: { query: vi.fn(async () => tabs), remove: vi.fn(async () => {}) },
    storage: { local: { get: vi.fn(async () => saved) } },
  };
}
describe("Ember window", () => {
  it("opens a toolbar-free popup with remembered bounds and closes Ember tabs elsewhere", async () => {
    const api = native([{ id: 1, type: "normal", focused: true, left: 0, top: 0, width: 800, height: 600 }], [{ id: 5, windowId: 1, url: APP }, { id: 6, windowId: 1, url: "about:blank" }, { id: 8, windowId: 99, url: APP }], { sparkWindowBounds: { left: 10, top: 20, width: 1280, height: 900 } });
    await new AppWindow(api, APP).showSpark();
    expect(api.windows.create).toHaveBeenCalledWith({ type: "popup", url: APP, left: 10, top: 20, width: 1280, height: 900 });
    expect(api.tabs.remove).toHaveBeenCalledWith([5, 8]); // no Ember window yet: every Ember tab hands over
  });
  it("first opens over the Thunderbird window, then refocuses the existing Ember window", async () => {
    const main = { id: 1, type: "normal", focused: true, left: 5, top: 6, width: 1000, height: 700 };
    const api = native([main]);
    await new AppWindow(api, APP).showSpark();
    expect(api.windows.create).toHaveBeenCalledWith({ type: "popup", url: APP, left: 5, top: 6, width: 1000, height: 700 });
    const open = native([main, { id: 7, type: "popup", focused: false, state: "minimized", tabs: [{ url: APP }] }]);
    await new AppWindow(open, APP).showSpark();
    expect(open.windows.create).not.toHaveBeenCalled();
    expect(open.windows.update).toHaveBeenCalledWith(7, { focused: true, state: "normal" });
  });
  it("opens at a usual size, not the small hidden Thunderbird window's (Ember-only mode shrinks it)", async () => {
    const api = native([{ id: 1, type: "normal", focused: false, left: 360, top: 40, width: 240, height: 180 }]);
    await new AppWindow(api, APP).showSpark();
    expect(api.windows.create).toHaveBeenCalledWith({ type: "popup", url: APP, left: 360, top: 40, width: 1100, height: 800 });
  });
  it("reopens minimized after an update when it was minimized", async () => {
    const api = native([{ id: 1, type: "normal", focused: true }]);
    api.windows.create = vi.fn(async () => ({ id: 9 })) as any;
    await new AppWindow(api, APP).showSpark({ minimized: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.windows.update).toHaveBeenCalledWith(9, { state: "minimized" });
  });
  it("toggles to Thunderbird when Ember is focused and back to Ember otherwise", async () => {
    const focused = native([{ id: 1, type: "normal", focused: false }, { id: 7, type: "popup", focused: true, tabs: [{ url: APP }] }]);
    await new AppWindow(focused, APP).toggle();
    expect(focused.windows.update).toHaveBeenCalledWith(1, { focused: true });
    const behind = native([{ id: 1, type: "normal", focused: true }, { id: 7, type: "popup", focused: false, tabs: [{ url: APP }] }]);
    await new AppWindow(behind, APP).toggle();
    expect(behind.windows.update).toHaveBeenCalledWith(7, { focused: true });
  });
  it("Ember-only mode: showing Ember hides Thunderbird's window; switching shows it through the Experiment", async () => {
    const only = { hideThunderbird: vi.fn(async () => {}), showThunderbird: vi.fn(async () => {}), focusSpark: vi.fn(async () => true) };
    const api: any = { ...native([{ id: 1, type: "normal", focused: false }, { id: 7, type: "popup", focused: true, tabs: [{ url: APP }] }]), sparkWindow: only };
    const spark = new AppWindow(api, APP);
    await spark.toggle(); // Ember focused -> Thunderbird
    expect(only.showThunderbird).toHaveBeenCalledOnce(); expect(api.windows.update).not.toHaveBeenCalledWith(1, expect.anything());
    await spark.showSpark();
    expect(only.hideThunderbird).toHaveBeenCalledOnce(); expect(only.focusSpark).toHaveBeenCalledOnce(); // restores a minimized Ember too
  });
});
