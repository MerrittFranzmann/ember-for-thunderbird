import { describe, expect, it } from "vitest";
import { LOCK_DEFAULTS, lockConfig, lockReasonText, trustedNetwork } from "../src/lib/lock";
import source from "../public/experiments/lock/implementation.js?raw";

// The Experiment is a plain script Thunderbird loads; evaluate it with a stub ExtensionAPI base.
const experiment = { exports: {} as any };
new Function("module", "ExtensionCommon", source).call({}, experiment, { ExtensionAPI: class {} });
const { lockScreenLocked, lockShouldLock, lockUnlocksWhenTrusted } = experiment.exports;

const config = (c = {}) => ({ ...lockConfig({ ...LOCK_DEFAULTS, lockEnabled: true }), ...c });
const HOME = { key: "home-key", name: "Home" };

describe("lock settings", () => {
  it("is off by default, and passes the Experiment what it needs", () => {
    expect(LOCK_DEFAULTS.lockEnabled).toBe(false);
    expect(lockConfig(LOCK_DEFAULTS)).toEqual({ enabled: false, idleMinutes: 15, onSleep: true, onStart: true });
    expect(lockConfig({ ...LOCK_DEFAULTS, lockAfter: -3 }).idleMinutes).toBe(0);
  });

  it("knows a trusted network by Focus's key, never an unknown one", () => {
    const s = { lockTrustedNetworks: [HOME] };
    expect(trustedNetwork(s, "home-key")).toEqual(HOME);
    expect(trustedNetwork(s, "cafe-key")).toBeUndefined();
    expect(trustedNetwork(s, null)).toBeUndefined();
  });

  it("says why Ember locked", () => {
    expect(lockReasonText("away", 15)).toBe("Locked after 15 minutes away from your Mac.");
    expect(lockReasonText("away", 1)).toBe("Locked after a minute away from your Mac.");
    expect(lockReasonText("away", 60)).toBe("Locked after an hour away from your Mac.");
    expect(lockReasonText("sleep", 15)).toMatch(/went to sleep/);
    expect(lockReasonText("screen", 15)).toMatch(/screen locked/);
    expect(lockReasonText("start", 15)).toMatch(/Thunderbird started/);
    expect(lockReasonText("manual", 15)).toMatch(/until you unlock/);
  });
});

describe("lock Experiment rules", () => {
  it("never locks while the lock is off", () => {
    for (const trigger of ["manual", "start", "sleep", "screen", "away"]) expect(lockShouldLock(config({ enabled: false }), trigger, false)).toBe(false);
  });

  it("locks when away, on sleep or screen lock, and at start, as set", () => {
    expect(lockShouldLock(config(), "away", false)).toBe(true);
    expect(lockShouldLock(config({ idleMinutes: 0 }), "away", false)).toBe(false);
    expect(lockShouldLock(config(), "screen", false)).toBe(true);
    expect(lockShouldLock(config({ onSleep: false }), "screen", false)).toBe(false);
    expect(lockShouldLock(config({ onSleep: false }), "sleep", false)).toBe(false);
    expect(lockShouldLock(config({ onStart: false }), "start", false)).toBe(false);
    expect(lockShouldLock(config(), "something-else", false)).toBe(false);
  });

  it("on a trusted network: no lock when away or the screen locks; sleep and start lock anyway (where it wakes isn't known)", () => {
    expect(lockShouldLock(config(), "away", true)).toBe(false);
    expect(lockShouldLock(config(), "screen", true)).toBe(false);
    expect(lockShouldLock(config(), "sleep", true)).toBe(true);
    expect(lockShouldLock(config(), "start", true)).toBe(true);
    expect(lockShouldLock(config(), "manual", true)).toBe(true);
  });

  it("a trusted network takes off only a recent lock from sleep or start", () => {
    const now = 1_000_000_000;
    expect(lockUnlocksWhenTrusted({ locked: true, reason: "sleep", at: now - 5000 }, now)).toBe(true);
    expect(lockUnlocksWhenTrusted({ locked: true, reason: "start", at: now - 60000 }, now)).toBe(true);
    expect(lockUnlocksWhenTrusted({ locked: true, reason: "sleep", at: now - 10 * 60000 }, now)).toBe(false);
    expect(lockUnlocksWhenTrusted({ locked: true, reason: "manual", at: now }, now)).toBe(false);
    expect(lockUnlocksWhenTrusted({ locked: true, reason: "away", at: now }, now)).toBe(false);
    expect(lockUnlocksWhenTrusted({ locked: false }, now)).toBe(false);
  });

  it("reads a locked screen from ioreg", () => {
    const plist = (key: string, value: boolean) => `<dict>\n\t<key>${key}</key>\n\t<${value}/>\n</dict>`;
    expect(lockScreenLocked(plist("IOConsoleLocked", true))).toBe(true);
    expect(lockScreenLocked(plist("CGSSessionScreenIsLocked", true))).toBe(true);
    expect(lockScreenLocked(plist("IOConsoleLocked", false))).toBe(false);
    expect(lockScreenLocked("")).toBe(false);
  });
});
