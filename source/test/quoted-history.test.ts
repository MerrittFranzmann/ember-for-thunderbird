import { describe, expect, it } from "vitest";
import { normalizeQuoteText, quotedOriginalIds } from "../src/lib/quoted-history";
import { splitMessageHistory } from "../src/lib/body";

describe("quoted message matching", () => {
  it("finds original replies while stripping quote markers and normalizing wrapping", () => {
    const reply = "I’ll send the revised deck by Thursday at 3, including the updated budget.";
    expect(quotedOriginalIds({ text: "> On Monday, Merritt wrote:\n> I'll send the revised deck by Thursday at 3,\n> including the updated budget." }, [{ id: 1, body: { text: reply } }, { id: 2, body: { text: "A different original message about next month's travel plans." } }])).toEqual([1]);
  });
  it("never matches a common short greeting/signature or unrelated text", () => {
    expect(quotedOriginalIds({ text: "> Thanks,\n> Ada" }, [{ id: 1, body: { text: "Thanks, Ada" } }])).toEqual([]);
    expect(quotedOriginalIds({ text: "History not present in this conversation" }, [{ id: 1, body: { text: "A different original message about next month's travel plans." } }])).toEqual([]);
  });
  it("separates a current plain-text reply and preserves exact history for fallback", () => {
    const body = "Works for me.\n\nOn Monday, Ada wrote:\n> The board review is Friday at 10. Please send the deck Thursday afternoon.";
    const split = splitMessageHistory({ text: body });
    expect(split.current.text).toBe("Works for me.");
    expect(split.history.text).toContain("The board review");
    expect(split.hasHistory).toBe(true);
    expect(normalizeQuoteText(split.history.text!)).not.toContain(">");
  });
});
