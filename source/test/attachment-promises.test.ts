import { describe, expect, it } from "vitest";
import { attachmentWarnings, kindOf, olderThan, promises, versionOf } from "../src/lib/attachment-promises";

const check = (text: string, files: string[] = [], links: string[] = [], thread: { name: string }[] = []) =>
  attachmentWarnings({ text, files: files.map((name) => ({ name })), links, thread: thread.map((t, i) => ({ from: "Ada", date: Date.UTC(2026, 9, 27), messageId: 100 + i, partName: `1.${i + 2}`, ...t })) });

describe("files an email promises", () => {
  it("finds promises in the user's own words, not in thanks for the other person's file", () => {
    expect(promises("Hi Ada. I've attached the budget spreadsheet. Talk soon!")).toEqual([{ sentence: "I've attached the budget spreadsheet.", kinds: ["spreadsheet"] }]);
    expect(promises("Please see the deck for the numbers.")[0].kinds).toEqual(["presentation"]);
    expect(promises("Thanks for the attached report. Can you send the spreadsheet?")).toEqual([]);
    expect(promises("Your attachment didn't open.")).toEqual([]);
  });
  it("warns when an attachment is promised and nothing is attached", () => {
    expect(check("I've attached the notes from today.")).toEqual([expect.objectContaining({ kind: "attachMissing", text: "You mention an attachment, but nothing is attached.", fix: { label: "Attach a file", attach: true } })]);
    expect(check("See the spreadsheet for this year's totals.")[0]).toMatchObject({ kind: "attachMissing", text: "You mention a spreadsheet, but nothing is attached." });
  });
  it("stays quiet for ordinary sentences, and for a shared link to that kind of file", () => {
    expect(check("See the notes below. Here's the plan for Monday.")).toEqual([]);
    expect(check("See the spreadsheet: https://docs.google.com/spreadsheets/d/abc", [], ["https://docs.google.com/spreadsheets/d/abc/edit"])).toEqual([]);
    expect(check("I've attached the deck.", ["Q4 deck.pptx"])).toEqual([]);
    expect(check("The document is attached.", ["Proposal.pdf"])).toEqual([]);
  });
  it("warns when the attached file isn't the kind the email names", () => {
    const [w] = check("Here's the spreadsheet with the budget.", ["budget.pdf"]);
    expect(w).toMatchObject({ kind: "attachKind", text: "You mention a spreadsheet, but none is attached." });
    expect(w.detail).toContain("Attached: budget.pdf.");
  });
});

describe("older versions", () => {
  it("reads versions, dates, copies and final from file names", () => {
    expect(versionOf("Budget_v3 FINAL.xlsx")).toMatchObject({ base: "budget", version: 3, final: true });
    expect(versionOf("report 2026-10-28.docx")).toMatchObject({ base: "report", date: Date.UTC(2026, 9, 28) });
    expect(versionOf("plan (2).pdf")).toMatchObject({ base: "plan", version: 2 });
    expect(kindOf("a.XLSX")).toBe("spreadsheet");
    expect(kindOf("a.pdf")).toBe("pdf");
  });
  it("compares only the same file", () => {
    expect(olderThan("budget-v2.xlsx", "budget-v3.xlsx")).toBe(true);
    expect(olderThan("budget-v3.xlsx", "budget-v2.xlsx")).toBe(false);
    expect(olderThan("budget.xlsx", "budget v2.xlsx")).toBe(true);
    expect(olderThan("report 20261020.docx", "report 2026-10-28.docx")).toBe(true);
    expect(olderThan("deck draft.pptx", "deck final.pptx")).toBe(true);
    expect(olderThan("budget-v2.xlsx", "budget-v3.pdf")).toBe(false);
    expect(olderThan("budget-v2.xlsx", "forecast-v3.xlsx")).toBe(false);
    expect(olderThan("budget-v3.xlsx", "budget-v3.xlsx")).toBe(false);
  });
  it("offers the conversation's newer file instead", () => {
    const warnings = check("Updated numbers attached.", ["budget-v2.xlsx"], [], [{ name: "budget-v3.xlsx" }, { name: "budget-v1.xlsx" }]);
    expect(warnings).toEqual([expect.objectContaining({
      kind: "olderVersion", text: "budget-v2.xlsx looks older than budget-v3.xlsx in this conversation.",
      fix: { label: "Use budget-v3.xlsx", swap: { name: "budget-v2.xlsx", messageId: 100, partName: "1.2", with: "budget-v3.xlsx" } },
    })]);
    expect(warnings[0].detail).toMatch(/^Ada sent budget-v3.xlsx on /);
  });
});
