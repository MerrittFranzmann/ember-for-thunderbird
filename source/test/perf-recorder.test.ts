import { describe, expect, it } from "vitest";
import { PerfRecorder } from "../src/lib/perf-recorder";
describe("performance recorder", () => {
  it("reports the slowest moments with the work that overlapped them, and records nothing when off", async () => {
    const perf = new PerfRecorder();
    const busy = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* simulated work */ } };
    perf.measure("spark.regroup", () => busy(30), { messages: 3600 });
    perf.record("frame", { ms: 120 });
    perf.measure("spark.fast", () => busy(0));
    const report = perf.report({ version: "test" }, [{ t: Date.now() - 50, kind: "cache-owner.pass", ms: 200 }]) as any;
    const times = report.entries.map((e: any) => e.t);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(report.entries.map((e: any) => e.kind).sort()).toEqual(["cache-owner.pass", "frame", "spark.regroup"]);
    expect(report.entries.some((e: any) => e.kind === "spark.fast")).toBe(false);
    expect(report.worst[0].moment).toMatchObject({ kind: "frame", ms: 120 });
    expect(report.worst[0].during.map((e: any) => e.kind)).toEqual(expect.arrayContaining(["spark.regroup", "cache-owner.pass"]));
    expect(report.entries.find((e: any) => e.kind === "cache-owner.pass").source).toBe("background");
    perf.setEnabled(false);
    perf.record("frame", { ms: 500 });
    expect((perf.report({}) as any).entries).toHaveLength(0);
  });
});
