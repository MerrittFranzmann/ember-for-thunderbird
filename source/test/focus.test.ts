import { describe, expect, it, vi } from "vitest";
import { FOCUS_DEFAULTS, focusState, inWorkHours, letThrough, nextWorkChange, parseList, quietChoices, shouldNotify, sparkAnnounces, type FocusSettings } from "../src/lib/focus";
import { FocusService } from "../src/lib/focus-service";
import source from "../public/experiments/focus/implementation.js?raw";

// The Experiment is a plain script Thunderbird loads; evaluate it with a stub ExtensionAPI base.
const experiment = { exports: {} as any };
new Function("module", "ExtensionCommon", source).call({}, experiment, { ExtensionAPI: class {} });
const { focusMac, focusRoute } = experiment.exports;

const at = (y: number, m: number, d: number, h: number, min = 0) => +new Date(y, m - 1, d, h, min);
const WED_NOON = at(2026, 10, 28, 12), WED_EVENING = at(2026, 10, 28, 20), SAT_NOON = at(2026, 10, 31, 12);
const settings = (s: Partial<FocusSettings> = {}): FocusSettings => ({ ...FOCUS_DEFAULTS, ...s });
const OFFICE = { key: "office", name: "Office" };

describe("work hours", () => {
  it("knows work days and hours, including shifts past midnight", () => {
    expect(inWorkHours(settings(), WED_NOON)).toBe(true);
    expect(inWorkHours(settings(), WED_EVENING)).toBe(false);
    expect(inWorkHours(settings(), SAT_NOON)).toBe(false);
    const night = settings({ workDays: [3], workStart: "22:00", workEnd: "06:00" });
    expect(inWorkHours(night, at(2026, 10, 28, 23))).toBe(true);
    expect(inWorkHours(night, at(2026, 10, 29, 3))).toBe(true);
    expect(inWorkHours(night, at(2026, 10, 29, 23))).toBe(false);
  });
  it("finds the next start or end", () => {
    expect(nextWorkChange(settings(), WED_NOON)).toBe(at(2026, 10, 28, 17));
    expect(nextWorkChange(settings(), WED_EVENING)).toBe(at(2026, 10, 29, 9));
    expect(nextWorkChange(settings(), SAT_NOON)).toBe(at(2026, 11, 2, 9));
    expect(nextWorkChange(settings({ workDays: [] }), SAT_NOON)).toBeNull();
    expect(quietChoices(settings(), WED_NOON).morning).toBe(at(2026, 10, 29, 9));
    expect(quietChoices(settings(), WED_EVENING).morning).toBe(at(2026, 10, 29, 9));
  });
});

describe("focus state", () => {
  const work = settings({ workAccounts: ["work"], workNetworks: [OFFICE] });
  it("shows work mail on a work network, and in work hours anywhere (by default)", () => {
    expect(focusState(work, { key: "office" }, WED_EVENING)).toMatchObject({ hiddenAccounts: [], onWorkNetwork: true, network: { key: "office", name: "Office" } });
    expect(focusState(work, { key: "home" }, WED_NOON).hiddenAccounts).toEqual([]);
    expect(focusState(work, { key: "home" }, WED_EVENING).hiddenAccounts).toEqual(["work"]);
    expect(focusState(work, { key: "home" }, SAT_NOON).hiddenAccounts).toEqual(["work"]);
    expect(focusState({ ...work, workMailRule: "network" }, { key: "home" }, WED_NOON).hiddenAccounts).toEqual(["work"]);
    expect(focusState(settings(), null, WED_EVENING).hiddenAccounts).toEqual([]);
  });
  it("is quiet outside work hours when asked, and the sidebar's override wins until it ends", () => {
    const quiet = settings({ quietHours: "outsideWork" });
    expect(focusState(quiet, null, WED_NOON).quiet).toBe(false);
    expect(focusState(quiet, null, WED_EVENING)).toMatchObject({ quiet: true, nextChange: at(2026, 10, 29, 9) });
    const now = settings({ focusOverride: { quiet: true, until: WED_NOON + 3600000 } });
    expect(focusState(now, null, WED_NOON)).toMatchObject({ quiet: true, nextChange: WED_NOON + 3600000 });
    expect(focusState(now, null, WED_NOON + 3600001).quiet).toBe(false);
    expect(focusState({ ...work, focusOverride: { showWork: true, until: WED_EVENING + 60000 } }, { key: "home" }, WED_EVENING).hiddenAccounts).toEqual([]);
  });
});

describe("let through and notifications", () => {
  const s = settings({ quietHours: "always", letThroughPeople: ["boss@work.org", "Grace", "@family.org"], letThroughSubjects: ["urgent"] });
  it("matches people by address, name or domain, and subjects by words", () => {
    expect(letThrough(s, { author: "The Boss <Boss@Work.org>" })).toBe(true);
    expect(letThrough(s, { author: "Grace Hopper <g@navy.mil>" })).toBe(true);
    expect(letThrough(s, { author: "mom@family.org" })).toBe(true);
    expect(letThrough(s, { author: "x@y.org", subject: "URGENT: server down" })).toBe(true);
    expect(letThrough(s, { author: "News <news@shop.com>", subject: "Sale" })).toBe(false);
    expect(parseList("a@b.org, Grace Hopper;\n@x.org,, a@b.org")).toEqual(["a@b.org", "Grace Hopper", "@x.org"]);
  });
  it("notifies only what's let through while quiet, never hidden work mail unless let through, never junk", () => {
    const state = focusState({ ...s, workAccounts: ["work"] }, { key: "home" }, WED_EVENING);
    expect(shouldNotify(s, state, { author: "News <news@shop.com>", subject: "Sale" })).toBe(false);
    expect(shouldNotify(s, state, { author: "boss@work.org", accountId: "work" })).toBe(true);
    expect(shouldNotify(s, state, { author: "boss@work.org", junk: true })).toBe(false);
    const open = settings({ workAccounts: ["work"] });
    const evening = focusState(open, { key: "home" }, WED_EVENING);
    expect(shouldNotify(open, evening, { author: "a@b.org", accountId: "personal" })).toBe(true);
    expect(shouldNotify(open, evening, { author: "a@b.org", accountId: "work" })).toBe(false);
  });
  it("Ember announces new mail only while something needs it", () => {
    expect(sparkAnnounces(settings())).toBe(false);
    expect(sparkAnnounces(settings({ quietHours: "outsideWork" }))).toBe(true);
    expect(sparkAnnounces(settings({ workAccounts: ["w"] }))).toBe(true);
    expect(sparkAnnounces(settings({ focusOverride: { quiet: true, until: WED_NOON + 1 } }), WED_NOON)).toBe(true);
    expect(sparkAnnounces(settings({ focusOverride: { quiet: true, until: WED_NOON - 1 } }), WED_NOON)).toBe(false);
  });
});

describe("the network, from macOS's route and arp", () => {
  it("reads the gateway and its hardware address", () => {
    expect(focusRoute("   route to: default\ndestination: default\n    gateway: 10.50.1.1\n  interface: en22\n")).toEqual({ gateway: "10.50.1.1", iface: "en22" });
    expect(focusMac("? (10.50.1.1) at 0:1b:2c:a:4d:5e on en22 ifscope [ethernet]")).toBe("00:1b:2c:0a:4d:5e");
    expect(focusMac("? (10.50.1.1) at (incomplete) on en0")).toBeNull();
    expect(focusRoute("route: writing to routing socket: not in table")).toEqual({ gateway: null, iface: null });
  });
});

describe("the background's Focus", () => {
  function native(stored: Partial<FocusSettings>) {
    return {
      storage: { local: { get: vi.fn(async (defaults: any) => ({ ...defaults, ...stored })), set: vi.fn(async () => {}) } },
      alarms: { create: vi.fn(async () => {}), clear: vi.fn(async () => true) },
      notifications: { create: vi.fn(async () => ""), clear: vi.fn(async () => true) },
      sparkFocus: { network: vi.fn(async () => ({ key: "home", dns: [] })), setMailAlerts: vi.fn(async () => true) },
    };
  }
  it("turns Thunderbird's alerts off and announces only let-through mail while quiet", async () => {
    const n = native({ quietHours: "always", letThroughPeople: ["boss@work.org"] });
    const focus = new FocusService(n, vi.fn(), vi.fn());
    await focus.received({ specialUse: ["inbox"], accountId: "a" }, { messages: [
      { id: 1, read: false, author: "Boss <boss@work.org>", subject: "Call me", folder: { accountId: "a" } },
      { id: 2, read: false, author: "Shop <news@shop.com>", subject: "Sale", folder: { accountId: "a" } },
    ] });
    expect(n.sparkFocus.setMailAlerts).toHaveBeenCalledWith(false);
    expect(n.notifications.create).toHaveBeenCalledExactlyOnceWith("spark-mail:1", { type: "basic", title: "Boss", message: "Call me" });
    expect(n.storage.local.set).toHaveBeenCalledWith({ focusState: expect.objectContaining({ quiet: true }) });
  });
  it("leaves new mail to Thunderbird when Focus isn't set, and puts its alerts back", async () => {
    const n = native({});
    const focus = new FocusService(n, vi.fn(), vi.fn());
    await focus.refresh();
    expect(n.sparkFocus.setMailAlerts).toHaveBeenCalledWith(true);
    await focus.received({ specialUse: ["inbox"] }, { messages: [{ id: 1, read: false, author: "a@b.org", subject: "Hi" }] });
    expect(n.notifications.create).not.toHaveBeenCalled();
  });
  it("opens the email from its notification, and sums up many at once", async () => {
    const n = native({ quietHours: "always", letThroughSubjects: ["invoice"] });
    const open = vi.fn(async () => {});
    const focus = new FocusService(n, open, vi.fn());
    await focus.received({ specialUse: ["inbox"] }, { messages: [1, 2, 3, 4].map((id) => ({ id, read: false, author: `P${id} <p${id}@x.org>`, subject: `Invoice ${id}` })) });
    expect(n.notifications.create).toHaveBeenCalledExactlyOnceWith("spark-mail:many", expect.objectContaining({ title: "4 new emails" }));
    expect(await focus.clicked("spark-mail:42")).toBe(true);
    expect(open).toHaveBeenCalledWith(42);
    expect(await focus.clicked("spark-follow:x")).toBe(false);
  });
});
