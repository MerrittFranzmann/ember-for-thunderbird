import { describe, expect, it } from "vitest";
import { listDate } from "../src/lib/format";
describe("shared list date formatters", () => {
  it("preserves local date labels across day/week/year boundaries", () => {
    const now = new Date(2026, 9, 27, 14);
    const today = new Date(2026, 9, 27, 9, 15), yesterday = new Date(2026, 9, 26, 9), weekday = new Date(2026, 9, 25), month = new Date(2026, 8, 2), year = new Date(2025, 8, 2);
    expect(listDate(today, now)).toBe(today.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
    expect(listDate(yesterday, now)).toBe("Yesterday");
    expect(listDate(weekday, now)).toBe(weekday.toLocaleDateString(undefined, { weekday: "short" }));
    expect(listDate(month, now)).toBe(month.toLocaleDateString(undefined, { month: "short", day: "numeric" }));
    expect(listDate(year, now)).toBe(year.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }));
    expect(listDate("invalid", now)).toBe("");
  });
});
