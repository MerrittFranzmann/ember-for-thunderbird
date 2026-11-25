import { describe, expect, it } from "vitest";
import { RateLimit, fresh, pruneResults, scanBadge, scanStats, scanText, threatName, validKey, verdict, type ScanResult } from "../src/lib/virustotal";
import source from "../public/experiments/scan/implementation.js?raw";

// The Experiment is a plain script Thunderbird loads; evaluate it with a stub ExtensionAPI base.
const experiment = { exports: {} as any };
new Function("module", "ExtensionCommon", source).call({}, experiment, { ExtensionAPI: class {} });
const { scanBase, scanFlagged } = experiment.exports;

const SHA = "a".repeat(64);
const DAY = 86400000;

describe("VirusTotal answers", () => {
  it("counts only engines that scanned the file", () => {
    expect(scanStats({ malicious: 3, suspicious: 1, harmless: 10, undetected: 50, "type-unsupported": 12, timeout: 2 })).toEqual({ malicious: 3, suspicious: 1, harmless: 10, undetected: 50, total: 64 });
    expect(scanStats(null)).toBeNull();
  });

  it("flags a file any engine calls malicious, else suspicious, else clean", () => {
    expect(verdict({ malicious: 1, suspicious: 0, harmless: 0, undetected: 60, total: 61 })).toBe("flagged");
    expect(verdict({ malicious: 0, suspicious: 2, harmless: 0, undetected: 60, total: 62 })).toBe("suspicious");
    expect(verdict({ malicious: 0, suspicious: 0, harmless: 5, undetected: 60, total: 65 })).toBe("clean");
  });

  it("names the threat by the most common engine names", () => {
    expect(threatName({ A: "Trojan.Agent", B: "Trojan.Agent", C: "Win32.Bad", D: "" })).toBe("Trojan.Agent, Win32.Bad");
    expect(threatName({})).toBeUndefined();
    expect(scanFlagged({ A: { category: "malicious", result: "X" }, B: { category: "undetected", result: null } })).toEqual({ A: "X" });
  });

  it("says what it found, short and long", () => {
    const flagged: ScanResult = { status: "flagged", stats: { malicious: 5, suspicious: 0, harmless: 0, undetected: 63, total: 68 }, threat: "EICAR-Test-File" };
    expect(scanText(flagged)).toBe("Flagged by 5 of 68 scanners · EICAR-Test-File");
    expect(scanBadge(flagged)).toBe("Flagged 5/68");
    expect(scanText({ status: "clean", stats: { malicious: 0, suspicious: 0, harmless: 2, undetected: 66, total: 68 } })).toBe("No scanner flags it (0 of 68)");
    expect(scanText({ status: "unknown" })).toBe("VirusTotal hasn't seen this file");
    expect(scanBadge(undefined)).toBe("Check");
    expect(scanText({ status: "error", error: "VirusTotal didn't accept the API key." })).toBe("VirusTotal didn't accept the API key.");
  });
});

describe("keeping answers", () => {
  const now = 100 * DAY;
  it("asks again about an unseen file after a day, a clean one after a week, never keeps errors", () => {
    expect(fresh({ status: "unknown", at: now - DAY / 2 }, now)).toBe(true);
    expect(fresh({ status: "unknown", at: now - 2 * DAY }, now)).toBe(false);
    expect(fresh({ status: "clean", at: now - 6 * DAY }, now)).toBe(true);
    expect(fresh({ status: "clean", at: now - 8 * DAY }, now)).toBe(false);
    expect(fresh({ status: "flagged", at: now - 20 * DAY }, now)).toBe(true);
    expect(fresh({ status: "error", at: now }, now)).toBe(false);
    expect(fresh({ status: "checking", at: now }, now)).toBe(false);
  });

  it("keeps the newest fresh answers", () => {
    const kept = pruneResults({ a: { status: "clean", at: now - 1 }, b: { status: "clean", at: now - 10 * DAY }, c: { status: "flagged", at: now - 2 }, d: { status: "unknown", at: now - 3 } }, now, 2);
    expect(Object.keys(kept)).toEqual(["a", "c"]);
  });
});

describe("the free key's limit", () => {
  it("lets 4 through a minute, then says how long to wait", () => {
    let t = 0;
    const limit = new RateLimit(4, () => t);
    for (let i = 0; i < 4; i++) { expect(limit.wait()).toBe(0); limit.take(); t += 1000; }
    expect(limit.wait()).toBe(60000 - 4000 + 50);
    t = 60001;
    expect(limit.wait()).toBe(0);
    limit.full();
    expect(limit.wait()).toBeGreaterThan(59000);
  });
});

describe("sparkScan Experiment", () => {
  it("asks VirusTotal, or only a local mock", () => {
    expect(scanBase("")).toBe("https://www.virustotal.com/api/v3");
    expect(scanBase("http://127.0.0.1:8123/")).toBe("http://127.0.0.1:8123");
    expect(scanBase("https://evil.example")).toBeNull();
  });
  it("knows an API key", () => {
    expect(validKey(SHA)).toBe(true);
    expect(validKey("nope")).toBe(false);
  });
});
