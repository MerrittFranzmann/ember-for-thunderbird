import { describe, expect, it } from "vitest";
import { clampSidebar, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, sidebarKey } from "../src/lib/sidebar-width";

describe("sidebar width", () => {
  it("stays between the narrowest and widest, in whole pixels", () => {
    expect(clampSidebar(300.4)).toBe(300);
    expect(clampSidebar(40)).toBe(SIDEBAR_MIN);
    expect(clampSidebar(900)).toBe(SIDEBAR_MAX);
    expect(clampSidebar(Number.NaN)).toBe(SIDEBAR_DEFAULT);
  });
  it("leaves the list and the email room in a smaller window", () => {
    expect(clampSidebar(400, 1000)).toBe(340);
    expect(clampSidebar(400, 1600)).toBe(400);
    expect(clampSidebar(400, 300)).toBe(SIDEBAR_MIN); // never narrower than the narrowest
  });
  it("moves with the arrow keys, Home, End and Enter", () => {
    expect(sidebarKey(232, "ArrowRight")).toBe(248);
    expect(sidebarKey(232, "ArrowLeft", true)).toBe(168);
    expect(sidebarKey(300, "Home")).toBe(SIDEBAR_MIN);
    expect(sidebarKey(300, "End")).toBe(SIDEBAR_MAX);
    expect(sidebarKey(300, "Enter")).toBe(SIDEBAR_DEFAULT);
    expect(sidebarKey(300, "a")).toBeNull();
  });
});
