import { describe, expect, it } from "vitest";
import { isChromatic } from "../src/lib/email-text";
describe("standard email text", () => {
  it("resets neutral text colours but keeps intentional ones", () => {
    for (const neutral of ["#000", "#000000", "#444444", "#1d1d1f", "rgb(51, 51, 51)", "black", "gray", "windowtext", "", undefined]) expect(isChromatic(neutral)).toBe(false);
    for (const chosen of ["#ff0000", "#c0392b", "#1F497D", "rgb(0, 112, 192)", "red", "navy", "#0a66d8 !important"]) expect(isChromatic(chosen)).toBe(true);
  });
});
