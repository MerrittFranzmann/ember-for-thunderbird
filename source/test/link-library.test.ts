import { describe, expect, it } from "vitest";
import { filterLinks, groupLinks, libraryLinks, linkKind, linkTitle, messageLinks } from "../src/lib/link-library";
import type { MessageHeader, MessagePart } from "../src/lib/types";

const html = (body: string): MessagePart => ({ contentType: "multipart/alternative", headers: {}, parts: [{ contentType: "text/html", headers: {}, body }] } as any);
const text = (body: string): MessagePart => ({ contentType: "text/plain", headers: {}, body } as any);
const header = (id: number, author: string, date: string, subject = "S"): MessageHeader => ({ id, author, date: new Date(date), subject, headerMessageId: `m${id}@x` } as any);

describe("which links count", () => {
  it("knows shared files, transfers and review links", () => {
    expect(linkKind("https://www.dropbox.com/scl/fi/abc123/Final%20cut%20v3.mov?rlkey=x&dl=0")).toEqual({ service: "Dropbox", kind: "Dropbox file" });
    expect(linkKind("https://www.dropbox.com/t/AbCdEf123")).toEqual({ service: "Dropbox", kind: "Dropbox transfer" });
    expect(linkKind("https://docs.google.com/spreadsheets/d/1abc/edit")).toMatchObject({ service: "Google Drive", kind: "Google Sheet" });
    expect(linkKind("https://f.io/AbC123")).toMatchObject({ service: "Frame.io" });
    expect(linkKind("https://next.frame.io/share/9a8b7c/")).toMatchObject({ service: "Frame.io" });
    expect(linkKind("https://vimeo.com/123456789/abcdef1234")).toMatchObject({ service: "Vimeo" });
    expect(linkKind("https://vimeo.com/user12345/review/987654321/abcd")).toMatchObject({ service: "Vimeo" });
    expect(linkKind("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toMatchObject({ service: "YouTube" });
    expect(linkKind("https://youtu.be/dQw4w9WgXcQ")).toMatchObject({ service: "YouTube" });
    expect(linkKind("https://we.tl/t-AbC123")).toMatchObject({ service: "WeTransfer" });
    expect(linkKind("https://app.box.com/s/abc123")).toMatchObject({ service: "Box", kind: "Box file" });
    expect(linkKind("https://www.figma.com/design/AbC123/Brand-Kit")).toMatchObject({ service: "Figma" });
    expect(linkKind("https://www.loom.com/share/0123abcd")).toMatchObject({ service: "Loom" });
  });
  it("ignores everything else: home pages, profiles, plain web pages, http", () => {
    for (const url of ["https://www.dropbox.com/", "https://vimeo.com/", "https://vimeo.com/channels", "https://www.youtube.com/@northwind", "https://www.youtube.com/", "https://frame.io/pricing", "https://example.org/file.pdf", "http://youtu.be/dQw4w9WgXcQ", "https://www.figma.com/community"])
      expect(linkKind(url), url).toBeNull();
  });
});

describe("links in an email", () => {
  it("takes the email's own links with its words for them, unwrapping safe links, once each", () => {
    const safe = `https://nam12.safelinks.protection.outlook.com/?url=${encodeURIComponent("https://f.io/Rev1ew")}&data=x`;
    const links = messageLinks(html(`<p>Here's the <a href="https://www.dropbox.com/scl/fi/abc/Cut%20v3.mov?dl=0">latest cut</a> and the <a href="${safe}">review link</a>.</p>
      <p><a href="https://www.dropbox.com/scl/fi/abc/Cut%20v3.mov?dl=0">here</a> · https://youtu.be/dQw4w9WgXcQ. <a href="https://northwind.example">site</a></p>`));
    expect(links.map((l) => [l.service, l.url, l.text])).toEqual([
      ["Dropbox", "https://www.dropbox.com/scl/fi/abc/Cut%20v3.mov?dl=0", "latest cut"],
      ["Frame.io", "https://f.io/Rev1ew", "review link"],
      ["YouTube", "https://youtu.be/dQw4w9WgXcQ", undefined],
    ]);
  });
  it("leaves out the quoted history (those links belong to earlier emails)", () => {
    expect(messageLinks(html(`<p>Thanks!</p><div class="gmail_quote">On Mon, Ada wrote:<blockquote><a href="https://f.io/Old1">old</a></blockquote></div>`))).toEqual([]);
    expect(messageLinks(html(`<p>Thanks!</p><div id="divRplyFwdMsg">From: Ada</div><a href="https://f.io/Old1">old</a>`))).toEqual([]);
    expect(messageLinks(text("New one: https://we.tl/t-New\n\nOn Mon, Ada wrote:\n> https://we.tl/t-Old")).map((l) => l.url)).toEqual(["https://we.tl/t-New"]);
  });
  it("names a link by its words, else the file name in the address, else what it is", () => {
    expect(linkTitle({ url: "https://www.dropbox.com/scl/fi/abc/Cut%20v3.mov?dl=0", service: "Dropbox", kind: "Dropbox file" })).toBe("Cut v3.mov");
    expect(linkTitle({ url: "https://www.figma.com/design/AbC/Brand-Kit", service: "Figma", kind: "Figma file" })).toBe("Brand Kit");
    expect(linkTitle({ url: "https://f.io/x1", service: "Frame.io", kind: "Frame.io review", text: "Episode 4 review" })).toBe("Episode 4 review");
    expect(linkTitle({ url: "https://f.io/x1", service: "Frame.io", kind: "Frame.io review" })).toBe("Frame.io review");
  });
});

describe("the library", () => {
  const records = [
    { message: header(2, "Ben <ben@studio.com>", "2026-10-20", "Re: Cut"), links: [{ url: "https://f.io/A", service: "Frame.io" as const, kind: "Frame.io review" }] },
    { message: header(1, "Ada <ada@northwind.example>", "2026-10-10", "Cut"), links: [{ url: "https://f.io/A", service: "Frame.io" as const, kind: "Frame.io review", text: "Rough cut" }, { url: "https://youtu.be/abcdefg", service: "YouTube" as const, kind: "YouTube video" }] },
    { message: header(3, "News <news@shop.com>", "2026-10-25", "Sale"), links: [{ url: "https://youtu.be/zzzzzzz", service: "YouTube" as const, kind: "YouTube video" }] },
  ];
  const domain = (author: string) => author.match(/@([^>]+)>/)![1];
  const items = libraryLinks(records, domain);
  it("lists each link once, credited to whoever shared it first, newest shares first", () => {
    expect(items.map((i) => [i.link.url, i.message.id, i.mentions, i.title])).toEqual([
      ["https://youtu.be/zzzzzzz", 3, 1, "YouTube video"],
      ["https://f.io/A", 1, 2, "Rough cut"],
      ["https://youtu.be/abcdefg", 1, 1, "YouTube video"],
    ]);
  });
  it("filters by approved sender domains, service and words, and groups", () => {
    expect(filterLinks(items, { approvedOnly: true, domains: ["northwind.example"], query: "", service: "all" }).map((i) => i.link.url)).toEqual(["https://f.io/A", "https://youtu.be/abcdefg"]);
    expect(filterLinks(items, { approvedOnly: false, domains: [], query: "", service: "YouTube" })).toHaveLength(2);
    expect(filterLinks(items, { approvedOnly: false, domains: [], query: "rough", service: "all" })).toHaveLength(1);
    expect(groupLinks(items, "service", () => ({ key: "", label: "" })).map((g) => [g.label, g.links.length])).toEqual([["Frame.io", 1], ["YouTube", 2]]);
  });
});
