import { describe, expect, it } from "vitest";
import { freeTimes, matchCommands, opensMenu } from "../src/lib/slash-commands";

describe("slash commands", () => {
  it("opens only at a line start or after a space", () => {
    expect(opensMenu("")).toBe(true);
    expect(opensMenu("Hello ")).toBe(true);
    expect(opensMenu("Hello ")).toBe(true);
    expect(opensMenu("and/or")).toBe(false);
    expect(opensMenu("https:")).toBe(false);
  });
  it("finds commands by label start, any word, then keyword", () => {
    expect(matchCommands("")[0].id).toBe("heading");
    expect(matchCommands("head").map((c) => c.id)).toEqual(["heading", "subheading"]);
    expect(matchCommands("list").map((c) => c.id).slice(0, 3)).toEqual(["bullets", "numbers", "todo"]);
    expect(matchCommands("h1")[0].id).toBe("heading");
    expect(matchCommands("hr")[0].id).toBe("divider");
    expect(matchCommands("follow")[0].id).toBe("remind");
    expect(matchCommands("free")[0].id).toBe("availability");
    expect(matchCommands("zzz")).toEqual([]);
  });
  it("lists free working-hour slots around meetings, skipping weekends", () => {
    // Wednesday 2026-10-28 08:00 local.
    const now = new Date(2026, 9, 28, 8, 0).getTime();
    const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
    const busy = [
      { start: at(28, 10), end: at(28, 11, 30) },
      { start: at(28, 13), end: at(28, 17) },
      { start: at(29, 9), end: at(29, 17) }, // Thursday fully booked
    ];
    const lines = freeTimes(busy, now, { locale: "en-US" });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("Wed, Oct 28: 9:00 AM–10:00 AM, 11:30 AM–1:00 PM");
    expect(lines[1]).toBe("Fri, Oct 30: 9:00 AM–5:00 PM"); // Thursday has none; the weekend is skipped
    expect(lines[2]).toMatch(/^Mon, Nov 2:/);
  });
  it("starts today's slots from the next half hour, and drops slots under 30 minutes", () => {
    const now = new Date(2026, 9, 28, 15, 10).getTime();
    const lines = freeTimes([{ start: new Date(2026, 9, 28, 16, 0).getTime(), end: new Date(2026, 9, 28, 16, 45).getTime() }], now, { locale: "en-US", days: 1 });
    expect(lines).toEqual(["Wed, Oct 28: 3:30 PM–4:00 PM"]);
  });
});
