import { describe, expect, it } from "vitest";
import { rowAt, rowWindow, stableWindow } from "../src/lib/virtual-list";
describe("virtual mail list windows", () => {
  const mixed = new Float64Array([0, 40, 126, 212, 252, 338]);
  it("finds mixed bucket/message rows at exact boundaries and outside the list", () => {
    expect([-10, 0, 39, 40, 125, 126, 337, 338, 1000].map(y => rowAt(mixed, y))).toEqual([0, 0, 0, 1, 1, 2, 4, 5, 5]);
    expect(rowWindow(new Float64Array([0]), 100, 800)).toEqual({ start: 0, end: 0 });
  });
  it("clips overscan at both ends and includes the viewport when jumping many pages", () => {
    const offsets = Float64Array.from({ length: 1001 }, (_, i) => i * 86);
    expect(rowWindow(offsets, 0, 860)).toEqual({ start: 0, end: 17 });
    expect(rowWindow(offsets, 43000, 860)).toEqual({ start: 494, end: 517 });
    expect(rowWindow(offsets, 85900, 860)).toEqual({ start: 992, end: 1000 });
    expect(rowWindow(offsets, 43000, 860, 0)).toEqual({ start: 500, end: 511 });
  });
  it("keeps the same window identity during pixel scrolling within a row", () => {
    const offsets = Float64Array.from({ length: 100 }, (_, i) => i * 86);
    const current = rowWindow(offsets, 860, 860);
    expect(stableWindow(current, rowWindow(offsets, 861, 860))).toBe(current);
    expect(stableWindow(current, rowWindow(offsets, 946, 860))).not.toBe(current);
  });
});
