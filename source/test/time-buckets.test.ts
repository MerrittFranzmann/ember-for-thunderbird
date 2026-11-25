import { describe, expect, it } from "vitest";
import { groupTimeBuckets, timeBucket } from "../src/lib/time-buckets";
import type { Conversation } from "../src/lib/types";
const now = new Date(2026, 9, 29, 14);
const at = (month: number, day: number, year = 2026) => new Date(year, month - 1, day, 10);
describe("exclusive calendar buckets", () => {
  it("assigns each conversation to the most recent matching period in local time", () => {
    expect([at(10,29), at(10,27), at(10,4), at(8,1), at(12,1,2025)].map((date) => timeBucket(date, now).id)).toEqual(["day", "week", "month", "year", "year:2025"]);
  });
  it("handles Monday, year boundaries, future mail and invalid dates", () => {
    expect(timeBucket(new Date(2026,9,25,23,59), new Date(2026,9,26)).id).toBe("month");
    expect(timeBucket(new Date(2025,11,31), new Date(2026,0,1)).id).toBe("week");
    expect(timeBucket(at(10,30), now).id).toBe("future");
    expect(timeBucket("bad", now).id).toBe("unknown");
  });
  it("orders newest first and does not duplicate messages across buckets", () => {
    const conversation = (key: string, date: Date) => ({ key, latest: { date } } as Conversation);
    const groups = groupTimeBuckets([conversation("old",at(8,2)),conversation("week",at(10,27)),conversation("today",at(10,29)),conversation("older",at(1,1,2024))],now);
    expect(groups.map((b) => b.id)).toEqual(["day","week","year","year:2024"]);
    expect(groups.flatMap((b) => b.conversations.map((c) => c.key))).toEqual(["today","week","old","older"]);
  });
});
