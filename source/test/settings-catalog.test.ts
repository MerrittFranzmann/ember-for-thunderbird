import { describe, expect, it } from "vitest";
import { SECTIONS, SETTINGS, matchingShortcuts, searchSettings } from "../src/lib/settings-catalog";

describe("the settings catalog", () => {
  it("puts every setting in a known section, once", () => {
    const ids = SETTINGS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SETTINGS) expect(SECTIONS.some((section) => section.id === s.section)).toBe(true);
    expect(SECTIONS.every((section) => SETTINGS.some((s) => s.section === section.id))).toBe(true);
  });
  it("finds settings by any of their words, all words required", () => {
    expect(searchSettings("undo").map((s) => s.id)).toContain("undoSend");
    expect(searchSettings("dark").map((s) => s.id)).toEqual(["theme", "emailDarkMode"]);
    expect(searchSettings("tracking pixels").map((s) => s.id)).toEqual(["loadRemoteImages"]);
    expect(searchSettings("token").map((s) => s.id)).toEqual(["aiSort"]);
    expect(searchSettings("chatgpt").map((s) => s.id)).toEqual(["agentAccess", "emailLinks"]);
    expect(searchSettings("zebra")).toEqual([]);
    expect(searchSettings("   ")).toEqual([]);
  });
  it("lists settings whose title matches first within a section", () => {
    const ids = searchSettings("send").filter((s) => s.section === "sending").map((s) => s.id);
    expect(ids.indexOf("undoSend")).toBeLessThan(ids.indexOf("minimizeCompose"));
    expect(ids.slice(0, 2)).toEqual(["undoSend", "sendLater"]);
  });
  it("finds keyboard shortcuts by what they do", () => {
    expect(searchSettings("reply all").map((s) => s.id)).toContain("shortcuts");
    expect(matchingShortcuts("archive")).toEqual([["E", "Done (archive)"]]);
    expect(matchingShortcuts("")).toHaveLength(21);
  });
});
