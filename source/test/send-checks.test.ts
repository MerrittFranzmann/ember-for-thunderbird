import { describe, expect, it } from "vitest";
import { correspondence, editDistance, likelyDomain, people, sendWarnings, warningSignature, type CheckInput } from "../src/lib/send-checks";
import { emailOf } from "../src/lib/format";

const headers = [
  { author: "Ada <ada@partner.org>", recipients: ["me@northwind.example"] },
  { author: "me@northwind.example", recipients: ["Ada <ada@partner.org>", "grace@gmail.com"] },
  { author: "Sam <sam@northwind.example>", recipients: ["me@northwind.example"], ccList: ["lee@partner.org"] },
  { author: "news@acme.com", recipients: ["me@northwind.example"] },
];
const known = correspondence(headers, emailOf);
const base = (p: Partial<CheckInput>): CheckInput => ({ mode: "new", from: "me@northwind.example", to: [], cc: [], bcc: [], me: new Set(["me@northwind.example", "me@gmail.com"]), known, ...p });
const kinds = (input: CheckInput) => sendWarnings(input).map((w) => w.kind);

describe("before you send: recipients", () => {
  it("knows each domain the user has mail with", () => {
    expect(known.domains.get("partner.org")).toBe(3);
    expect(known.addresses.has("lee@partner.org")).toBe(true);
  });
  it("says nothing for people and domains the user already emails, or their own colleagues", () => {
    expect(sendWarnings(base({ to: [{ name: "Ada", email: "ada@partner.org" }, { name: "", email: "new.person@partner.org" }, { name: "", email: "boss@northwind.example" }, { name: "", email: "someone@gmail.com" }] }))).toEqual([]);
  });
  it("flags a domain nobody in the user's mail has used, with a remove for a single person", () => {
    const [warning] = sendWarnings(base({ to: [{ name: "Jo Doe", email: "jo@newco.io" }] }));
    expect(warning).toMatchObject({ kind: "newDomain", text: "First email to anyone at newco.io", detail: "Jo Doe isn't in any email you've sent or received.", fix: { label: "Remove", remove: "jo@newco.io" } });
  });
  it("suggests the likely domain for a typo instead", () => {
    const warnings = sendWarnings(base({ to: [{ name: "Grace", email: "grace@gmial.com" }, { name: "", email: "ada@partner.ogr" }] }));
    expect(warnings.map((w) => [w.kind, w.text, w.fix?.replace?.with])).toEqual([
      ["typo", "grace@gmial.com: did you mean gmail.com?", "grace@gmail.com"],
      ["typo", "ada@partner.ogr: did you mean partner.org?", "ada@partner.org"],
    ]);
    expect(editDistance("gmial.com", "gmail.com")).toBe(1);
    expect(likelyDomain("partner.org", known.domains)).toBeNull();
    // Well-known services are never typos of each other, even when the user has no mail there yet.
    expect(likelyDomain("gmail.com", new Map())).toBeNull();
    expect(likelyDomain("ymail.com", new Map())).toBeNull();
    expect(likelyDomain("totally-different.com", known.domains)).toBeNull();
  });
  it("flags people added to a reply who weren't in the conversation, more firmly when it was internal", () => {
    const thread = ["sam@northwind.example", "me@northwind.example"];
    const [warning] = sendWarnings(base({ mode: "reply", thread, to: [{ name: "Sam", email: "sam@northwind.example" }, { name: "Ada", email: "ada@partner.org" }] }));
    expect(warning).toMatchObject({ kind: "notInThread", text: "Ada wasn't in this conversation", detail: "Everyone else in it is at northwind.example; ada@partner.org is outside it.", fix: { remove: "ada@partner.org" } });
    expect(kinds(base({ mode: "reply", thread: ["ada@partner.org", "me@northwind.example"], to: [{ name: "", email: "lee@partner.org" }] }))).toEqual(["notInThread"]);
    // New messages and forwards go to new people by design.
    expect(kinds(base({ mode: "forward", thread, to: [{ name: "Ada", email: "ada@partner.org" }] }))).toEqual([]);
  });
  it("flags big reply-alls and group addresses", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ name: "", email: `p${i}@northwind.example` }));
    expect(sendWarnings(base({ mode: "replyAll", thread: many.map((a) => a.email), to: many }))[0]).toMatchObject({ kind: "crowd", text: "Reply all goes to 8 people" });
    expect(kinds(base({ to: many }))).toEqual([]);
    expect(kinds(base({ to: Array.from({ length: 20 }, (_, i) => ({ name: "", email: `p${i}@northwind.example` })) }))).toEqual(["crowd"]);
    expect(sendWarnings(base({ to: [{ name: "", email: "all-staff@northwind.example" }] }))[0]).toMatchObject({ kind: "group", text: "all-staff@northwind.example is a group address" });
  });
  it("lists names readably and gives the same signature for the same warnings", () => {
    expect(people(["Ada"])).toBe("Ada");
    expect(people(["Ada", "Grace", "Sam"])).toBe("Ada, Grace and Sam");
    expect(people(["Ada", "Grace", "Sam", "Lee"])).toBe("Ada, Grace and 2 others");
    const input = base({ to: [{ name: "", email: "jo@newco.io" }, { name: "", email: "all@northwind.example" }] });
    expect(warningSignature(sendWarnings(input))).toBe(warningSignature([...sendWarnings(input)].reverse()));
  });
});

describe("before you send: shared files", () => {
  const sharepoint = { url: "https://northwind.sharepoint.com/:w:/s/Team/Eabc", label: "“the Q3 plan”", service: "SharePoint" as const, tenant: "northwind" };
  const doc = { url: "https://docs.google.com/document/d/1abc/edit", label: "a Google Doc", service: "Google Drive" as const };
  it("warns when a file that needs a sign-in goes to people outside its organization", () => {
    const [warning] = sendWarnings(base({ to: [{ name: "Sam", email: "sam@northwind.example" }, { name: "Ada Lovelace", email: "ada@partner.org" }], links: [{ link: sharepoint, access: "signin" }] }));
    expect(warning).toMatchObject({ kind: "linkAccess", text: "“The Q3 plan” needs a sign-in", detail: "Ada Lovelace can open it only if it's shared with them on northwind's SharePoint. Anyone with the link can't." });
    expect(kinds(base({ to: [{ name: "Sam", email: "sam@northwind.example" }], links: [{ link: sharepoint, access: "signin" }] }))).toEqual([]);
    expect(kinds(base({ to: [{ name: "Ada", email: "ada@partner.org" }], links: [{ link: sharepoint, access: "public" }] }))).toEqual([]);
  });
  it("treats every recipient as outside for a personal account's file", () => {
    const warnings = sendWarnings(base({ from: "me@gmail.com", to: [{ name: "Grace", email: "grace@gmail.com" }], links: [{ link: doc, access: "signin" }] }));
    expect(warnings[0]).toMatchObject({ kind: "linkAccess", text: "A Google Doc needs a sign-in" });
  });
  it("says when a link doesn't open at all, and ignores answers it couldn't get", () => {
    expect(sendWarnings(base({ to: [{ name: "Sam", email: "sam@northwind.example" }], links: [{ link: doc, access: "missing" }] }))[0]).toMatchObject({ kind: "linkMissing", text: "A Google Doc doesn't open" });
    expect(kinds(base({ to: [{ name: "Ada", email: "ada@partner.org" }], links: [{ link: doc, access: "unknown" }] }))).toEqual([]);
  });
});

describe("own organization's subdomains", () => {
  it("doesn't call a colleague at eu.northwind.example a first email to a new domain", () => {
    const input = base({ to: [{ name: "", email: "kim@eu.northwind.example" }] });
    expect(sendWarnings(input).filter((w) => w.kind === "newDomain")).toEqual([]);
  });
});
