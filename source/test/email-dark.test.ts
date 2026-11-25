import { describe, expect, it } from "vitest";
import { contrast, parseColor, remap } from "../src/lib/email-dark";

const canvas = { r: 30, g: 30, b: 33 }; // dark message card
const hue = (c: { r: number; g: number; b: number }) => {
  const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === c.r ? ((c.g - c.b) / d) % 6 : max === c.g ? (c.b - c.r) / d + 2 : (c.r - c.g) / d + 4;
  return (h * 60 + 360) % 360;
};

describe("email dark mode colours", () => {
  it("parses computed colours", () => {
    expect(parseColor("rgb(0, 124, 255)")).toEqual({ r: 0, g: 124, b: 255, a: 1 });
    expect(parseColor("rgba(0, 0, 0, 0)")).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseColor("transparent")).toBeNull();
  });
  it("moves dark text into the readable light range against the dark canvas", () => {
    for (const text of [{ r: 0, g: 0, b: 0 }, { r: 51, g: 51, b: 51 }, { r: 102, g: 102, b: 102 }]) {
      const light = remap(text, canvas, canvas);
      expect(contrast(light, canvas)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("moves light backgrounds into the dark range so light text stays readable", () => {
    const text = remap({ r: 0, g: 0, b: 0 }, canvas, canvas);
    for (const bg of [{ r: 255, g: 255, b: 255 }, { r: 255, g: 238, b: 204 }, { r: 240, g: 244, b: 248 }]) {
      const dark = remap(bg, text, canvas);
      expect(contrast(dark, text)).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("keeps the hue of coloured text (a red stays red, a blue stays blue)", () => {
    const red = remap({ r: 180, g: 20, b: 20 }, canvas, canvas), blue = remap({ r: 0, g: 60, b: 200 }, canvas, canvas);
    expect(Math.min(hue(red), 360 - hue(red))).toBeLessThan(20);
    expect(Math.abs(hue(blue) - 225)).toBeLessThan(25);
  });
});
