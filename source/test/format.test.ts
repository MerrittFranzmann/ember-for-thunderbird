import { describe, expect, it } from "vitest";
import { displayName, initials, listDate, normSubject, parseAddr, splitAddrs } from "../src/lib/format";

describe("addresses", () => {
  it("parses name + email", () => {
    expect(parseAddr("Ada Lovelace <ada@x.org>")).toEqual({ name: "Ada Lovelace", email: "ada@x.org" });
    expect(parseAddr('"Hopper, Grace" <g@x.org>')).toEqual({ name: "Hopper, Grace", email: "g@x.org" });
    expect(parseAddr("bare@x.org")).toEqual({ name: "", email: "bare@x.org" });
  });
  it("splits quoted lists", () => {
    expect(splitAddrs('"Hopper, Grace" <g@x.org>, ada@x.org').map((a) => a.email)).toEqual(["g@x.org", "ada@x.org"]);
  });
  it("display names and initials", () => {
    expect(displayName("no-reply@dropbox.com")).toBe("No Reply");
    expect(initials("Ada Lovelace <a@b.c>")).toBe("AL");
    expect(initials("Quiet Sender 0 <q@b.c>")).toBe("QS"); // numbers don't make initials
    expect(initials("2024 <n@b.c>")).toBe("20");
    expect(initials("alan@b.c")).toBe("AL");
  });
});

describe("subjects", () => {
  it("normalizes reply/forward prefixes and list tags", () => {
    expect(normSubject("Re: RE: Fwd: [list] Hello  world")).toBe("hello world");
    expect(normSubject("AW: Treffen")).toBe("treffen");
  });
});

describe("listDate", () => {
  const now = new Date(2026, 9, 26, 15, 0);
  it("time today, Yesterday, weekday, date", () => {
    expect(listDate(new Date(2026, 9, 26, 9, 5), now)).toMatch(/9:05/);
    expect(listDate(new Date(2026, 9, 25, 9, 5), now)).toBe("Yesterday");
    expect(listDate(new Date(2026, 9, 22, 9, 5), now)).toMatch(/Thu/);
    expect(listDate(new Date(2026, 5, 2), now)).toMatch(/Jun/);
    expect(listDate(new Date(2024, 5, 2), now)).toMatch(/2024/);
  });
});
