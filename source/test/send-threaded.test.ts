import { describe, expect, it, vi } from "vitest";
import source from "../public/experiments/send/implementation.js?raw";
import { needsComposer, sendThreaded, threadedKind } from "../src/lib/delivery";

const experiment = { exports: {} as any };
new Function("module", "ExtensionCommon", source).call({}, experiment, { ExtensionAPI: class {} });
const { sendReferences, headerReferences } = experiment.exports;

describe("replies without Thunderbird's composer window", () => {
  it("threads a reply after the original's references, each id once", () => {
    expect(sendReferences(["root@x", "mid@x"], "orig@x")).toBe("<root@x> <mid@x> <orig@x>");
    expect(sendReferences([], "<orig@x>")).toBe("<orig@x>");
    expect(sendReferences(["root@x", "orig@x"], "orig@x")).toBe("<root@x> <orig@x>");
    expect(sendReferences(["draft-root@x"])).toBe("<draft-root@x>");
    expect(headerReferences({ numReferences: 2, getStringReference: (i: number) => ["a@x", "b@x"][i] })).toEqual(["a@x", "b@x"]);
  });
  it("sends replies, reply drafts and forwards that way; new mail, unthreaded drafts and no Experiment don't", () => {
    const native = { sparkSend: { send: vi.fn() } };
    expect(["reply", "replyAll", "forward"].map((mode) => threadedKind(native, mode, false, 4))).toEqual(["reply", "reply", "forward"]);
    expect(threadedKind(native, "draft", true, 4)).toBe("draft");
    expect([threadedKind(native, "draft", false, 4), threadedKind(native, "new", false, 4), threadedKind(native, "reply", false, undefined), threadedKind({}, "reply", false, 4)]).toEqual([null, null, null, null]);
  });
  it("leaves a forward with attachments to the composer, and reports other failures", async () => {
    const native = { sparkSend: { send: vi.fn(async () => ({ headerMessageId: "sent@x" })) } };
    expect(await sendThreaded(native, "reply", 4, { to: ["a@x"] }, false)).toEqual({ headerMessageId: "sent@x" });
    expect(native.sparkSend.send).toHaveBeenCalledWith({ to: ["a@x"] }, { kind: "reply", relatedId: 4 });
    native.sparkSend.send.mockRejectedValueOnce(new Error("A forward with attachments needs Thunderbird's composer."));
    expect(await sendThreaded(native, "forward", 4, {}, false)).toBeNull();
    native.sparkSend.send.mockRejectedValueOnce(new Error("Thunderbird couldn't send it: SMTP refused"));
    await expect(sendThreaded(native, "reply", 4, {}, false)).rejects.toThrow("SMTP refused");
    expect(needsComposer("x")).toBe(false);
  });
});
