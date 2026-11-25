import { describe, expect, it } from "vitest";
import { buildThreadHtml, pdfName, scopeEmailCss } from "../src/lib/thread-pdf";

describe("conversation PDF", () => {
  it("applies an email's html/body rules to its own wrapper", () => {
    expect(scopeEmailCss("body{color:red} html, body.x{margin:0} .body{} tbody td{}")).toBe(".mail-body{color:red} .mail-body, .mail-body.x{margin:0} .body{} tbody td{}");
  });
  it("lays out each email with its headers, isolated HTML and escaped text", () => {
    const html = buildThreadHtml("Re: Plan <draft>", [
      { from: "Ana <ana@x.org>", to: ["me@x.org"], cc: [], date: "2026-10-01T10:00:00Z", attachments: [{ name: "plan.pdf", size: 2048 }], body: { html: { styles: "body{color:#333}", html: "<p>Hi</p>", bodyStyle: "" } } },
      { from: "Me <me@x.org>", to: ["ana@x.org"], cc: ["bo@x.org"], date: "2026-10-02T10:00:00Z", attachments: [], body: { text: "Thanks <3" } },
    ], false);
    expect(html).toContain("<h1>Re: Plan &lt;draft&gt;</h1>");
    expect(html).toContain("2 messages · ");
    expect(html).toMatch(/class="person"><span class="dot"[^>]*>[A-Z]{1,2}<\/span>Ana/);
    expect(html).toContain('<template shadowrootmode="open">');
    expect(html).toContain(".mail-body{color:#333}");
    expect(html).toContain("plan.pdf · 2 KB");
    expect(html).toContain("to ana@x.org · cc bo@x.org");
    expect(html).toContain('<b>Ana<span>ana@x.org</span></b>');
    expect(html).toContain("Thanks &lt;3");
    expect(html).toContain("img-src data: blob:;"); // no remote images unless allowed
    expect(buildThreadHtml("x", [], true)).toContain("img-src data: blob: https: http:");
  });
  it("keeps Ember's standard typography for conversational mail", () => {
    const html = buildThreadHtml("x", [{ from: "a@x.org", to: [], cc: [], date: 0, attachments: [], body: { html: { styles: "", html: "<p>Hi</p>", bodyStyle: "", standardBody: true } } }], false);
    expect(html).toContain('class="mail-body" data-spark-text-body');
  });
  it("names the file after the subject", () => {
    expect(pdfName("Re: Fwd: Budget / Q4")).toBe("Budget / Q4.pdf");
    expect(pdfName("")).toBe("Conversation.pdf");
  });
});
