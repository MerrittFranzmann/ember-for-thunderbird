import { describe, expect, it } from "vitest";
import { extractBodies, splitQuotedText, textToHtml } from "../src/lib/body";

describe("conversation rendering", () => {
  it("separates trailing quoted history", () => {
    expect(splitQuotedText("New reply\n\nOn Monday, Ada wrote:\n> History")).toEqual({ text: "New reply", quote: "On Monday, Ada wrote:\n> History" });
    expect(splitQuotedText("New reply\n\n> Old text").quote).toBe("> Old text");
  });
  it("preserves inline replies and quote-only messages", () => {
    for (const text of ["> Question\nAnswer", "Opening\n> Question\nAnswer", "> Only quoted text"]) expect(splitQuotedText(text)).toEqual({ text, quote: "" });
  });
  it("never treats an attached email or a text attachment as the message body", () => {
    expect(extractBodies({ parts: [{ contentType: "text/plain", name: "secret.txt", body: "Secret", headers: { "content-disposition": ["attachment"] } }, { contentType: "text/plain", name: "more-notes.txt", body: "Not the message body" }, { contentType: "message/rfc822", parts: [{ contentType: "text/html", body: "Forwarded" }] }, { contentType: "text/plain", body: "Actual message" }] })).toEqual({ text: "Actual message" });
  });
  it("escapes email text and makes safe links", () => {
    const html = textToHtml('<script>alert(1)</script>\nhttps://example.org/path\n> quote');
    expect(html).not.toContain("<script>");
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("<blockquote>");
  });
});
