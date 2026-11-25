import { describe, expect, it } from "vitest";
import source from "../public/experiments/search/implementation.js?raw";

// The Experiment is a plain script Thunderbird loads; evaluate it with a stub ExtensionAPI base.
const module = { exports: {} as any };
new Function("module", "ExtensionCommon", source).call({}, module, { ExtensionAPI: class {} });
const { searchWords } = module.exports;

describe("search experiment", () => {
  it("splits a query into words and quoted phrases, once each", () => {
    expect(searchWords("weekly standup")).toEqual(["weekly", "standup"]);
    expect(searchWords('budget "Q4 plan" budget Budget')).toEqual(["Q4 plan", "budget"]);
    expect(searchWords('  "unclosed phrase  ')).toEqual(["unclosed", "phrase"]);
    expect(searchWords("")).toEqual([]);
    expect(searchWords("a b c d e f g h i j")).toHaveLength(8);
  });
});
