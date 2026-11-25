import { describe, expect, it } from "vitest";
import { everyoneFree, freeSlots, slotLabel, timeline } from "../src/lib/find-time";

const t = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
const MON_EARLY = t(16, 7); // Monday 7 AM

describe("find a time", () => {
  const me = { email: "me@x.test", busy: [{ start: t(19, 9), end: t(19, 12) }, { start: t(19, 13, 30), end: t(19, 15) }] };
  const priya = { email: "priya@x.test", busy: [{ start: t(19, 12), end: t(19, 13) }, { start: t(19, 16), end: t(19, 17) }] };
  it("finds the first time of each stretch where everyone's free, in working hours", () => {
    const slots = freeSlots([me, priya], { from: t(19, 0), to: t(21, 0), now: MON_EARLY, minutes: 30 });
    expect(slots.map((s) => [new Date(s.start).getDate(), new Date(s.start).getHours(), new Date(s.start).getMinutes()])).toEqual([[19, 13, 0], [19, 15, 0], [20, 9, 0]]);
    expect(slots[0].end - slots[0].start).toBe(30 * 60000);
  });
  it("needs room for the whole meeting, skips weekends and the past", () => {
    const long = freeSlots([me, priya], { from: t(19, 0), to: t(20, 0), now: MON_EARLY, minutes: 90 });
    expect(long).toEqual([]);
    // Saturday and Sunday are skipped: Monday's first time.
    expect(freeSlots([], { from: t(21, 0), to: t(24, 0), now: MON_EARLY, minutes: 60, limit: 1 })).toEqual([{ start: t(23, 9), end: t(23, 10) }]);
    // Not before now (rounded up to the half hour).
    expect(freeSlots([], { from: t(16, 0), to: t(17, 0), now: t(16, 11, 42), minutes: 30, limit: 1 })).toEqual([{ start: t(16, 12), end: t(16, 12, 30) }]);
  });
  it("leaves out people Exchange couldn't see", () => {
    const outside = { email: "pal@gmail.test", busy: [], unknown: true };
    expect(everyoneFree([me, outside], t(19, 12), t(19, 13))).toBe(true);
    expect(everyoneFree([me, priya], t(19, 12), t(19, 13))).toBe(false);
  });
  it("draws a day's busy blocks on an 8 AM – 6 PM line", () => {
    expect(timeline(me.busy, t(19, 0))).toEqual([{ left: 0.1, width: 0.3 }, { left: 0.55, width: 0.15 }]);
    expect(timeline([{ start: t(19, 6), end: t(19, 9) }], t(19, 0))).toEqual([{ left: 0, width: 0.1 }]);
  });
  it("labels slots", () => {
    expect(slotLabel({ start: t(19, 13), end: t(19, 13, 30) }, "en-US")).toBe("Thu 1:00 PM");
    expect(slotLabel({ start: t(19, 13), end: t(19, 13, 30) }, "en-US", true)).toBe("Thu, Nov 19 · 1:00 PM – 1:30 PM");
  });
});
