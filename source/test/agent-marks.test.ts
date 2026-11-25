import { describe, expect, it } from "vitest";
import { applyMarks, markOf, topOf } from "../src/lib/agent-marks";
import source from "../public/experiments/agent/implementation.js?raw";

describe("agent marks", () => {
  it("sets, overrides and clears marks by Message-ID", () => {
    let marks = applyMarks({}, ["<a@x>", "b@x"], { top: true, reply: true, note: "  Ada asked for the budget  " }, "agent", 1000);
    expect(marks["a@x"]).toEqual({ top: true, reply: true, note: "Ada asked for the budget", at: 1000, by: "agent" });
    expect(markOf(marks, { headerMessageId: "<b@x>" })?.top).toBe(true);
    // false stays (it overrides Clef's guess); a mark with nothing left goes.
    marks = applyMarks(marks, ["a@x"], { important: false }, "user", 2000);
    expect(marks["a@x"]).toMatchObject({ top: true, reply: true, important: false, by: "user", at: 2000 });
    marks = applyMarks(marks, ["b@x"], { top: undefined, reply: undefined, note: "" }, "user");
    expect(marks["b@x"]).toMatchObject({ top: true });
    const cleared = applyMarks({ "c@x": { note: "x", at: 1, by: "agent" } }, ["c@x"], { note: "" }, "agent");
    expect(cleared["c@x"]).toBeUndefined();
    expect(applyMarks({}, ["", "<>"], { top: true }, "agent")).toEqual({});
    // A reply draft's link is a mark of its own; clearing it (null) removes an otherwise empty mark.
    const drafted = applyMarks({}, ["d@x"], { draft: "<draft-1@x>" }, "agent", 5);
    expect(drafted["d@x"]).toEqual({ draft: "draft-1@x", at: 5, by: "agent" });
    expect(applyMarks(drafted, ["d@x"], { draft: null }, "user")["d@x"]).toBeUndefined();
  });
  it("keeps a conversation at the top until it's unmarked, or answered when it needed a reply", () => {
    const marks = { "q@x": { top: true, reply: true, at: 1, by: "agent" as const }, "fyi@x": { top: true, at: 1, by: "agent" as const } };
    expect(topOf(marks, [{ headerMessageId: "q@x" }], false)).toBe(true);
    expect(topOf(marks, [{ headerMessageId: "q@x" }], true)).toBe(false); // the user replied
    expect(topOf(marks, [{ headerMessageId: "fyi@x" }], true)).toBe(true);
    expect(topOf(marks, [{ headerMessageId: "other@x" }], false)).toBe(false);
  });
});

describe("the agent socket's framing", () => {
  const module = { exports: {} as any };
  new Function("module", "ExtensionCommon", source).call({}, module, { ExtensionAPI: class {} });
  it("splits complete lines and keeps the rest", () => {
    expect(module.exports.agentLines('{"id":1}\n\n{"id":2}\n{"id"')).toEqual([['{"id":1}', '{"id":2}'], '{"id"']);
    expect(module.exports.agentLines("")).toEqual([[], ""]);
  });
});
