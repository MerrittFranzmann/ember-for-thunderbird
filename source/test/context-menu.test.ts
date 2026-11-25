import { describe, expect, it, vi } from "vitest";
import { allowsNativeMenu, bodyMenuItems, imageFileName, installNativeMenuGuard, mailtoAddress } from "../src/lib/context-menu";

const el = (matches: boolean) => ({ closest: vi.fn(() => (matches ? {} : null)) });

describe("right-clicks", () => {
  it("keeps the text menu only where you type", () => {
    expect(allowsNativeMenu(el(true))).toBe(true);
    expect(allowsNativeMenu(el(false))).toBe(false);
    expect(allowsNativeMenu({ nodeType: 3, parentElement: el(true) })).toBe(true); // a text node in a field
    expect(allowsNativeMenu(null)).toBe(false);
  });

  it("drops Thunderbird's menu where no Ember menu took the right-click", () => {
    let handler: (e: any) => void = () => {};
    installNativeMenuGuard({ addEventListener: (_type, fn) => { handler = fn; } });
    const event = (target: any, prevented = false) => ({ target, defaultPrevented: prevented, preventDefault: vi.fn() });
    const onInterface = event(el(false)); handler(onInterface); expect(onInterface.preventDefault).toHaveBeenCalled();
    const inField = event(el(true)); handler(inField); expect(inField.preventDefault).not.toHaveBeenCalled();
    const sparkMenu = event(el(false), true); handler(sparkMenu); expect(sparkMenu.preventDefault).not.toHaveBeenCalled();
  });

  it("offers in an email what fits what was right-clicked", () => {
    expect(bodyMenuItems({}).map((i) => i.action)).toEqual([]);
    expect(bodyMenuItems({ selection: "  the board deck " }).map((i) => [i.action, i.label])).toEqual([["copy", "Copy"], ["search", "Search mail for “the board deck”"]]);
    expect(bodyMenuItems({ selection: "x".repeat(40) })[1].label).toBe(`Search mail for “${"x".repeat(26)}…”`);
    expect(bodyMenuItems({ href: "https://example.org/a" }).map((i) => i.action)).toEqual(["open-link", "copy-link"]);
    expect(bodyMenuItems({ href: "mailto:Ana%40example.org?subject=Hi" }).map((i) => [i.action, i.label])).toEqual([["write-to", "Write to Ana@example.org"], ["copy-address", "Copy email address"]]);
    expect(bodyMenuItems({ href: "javascript:alert(1)" })).toEqual([]);
    expect(bodyMenuItems({ image: "blob:x", href: "https://example.org" }).map((i) => i.action)).toEqual(["open-link", "copy-link", "copy-image", "save-image"]);
  });

  it("reads mailto addresses and names saved images", () => {
    expect(mailtoAddress("mailto:a@b.org?cc=c@d.org")).toBe("a@b.org");
    expect(mailtoAddress("https://a.org")).toBe("");
    expect(imageFileName("https://cdn.example.org/img/logo%20big.png?v=2")).toBe("logo big.png");
    expect(imageFileName("https://cdn.example.org/track")).toBe("image.png");
    expect(imageFileName("blob:moz-extension://x/123")).toBe("image.png");
  });
});

describe("people and attachment menus", () => {
  it("offers writing, copying and your mail with someone; only copying for yourself", async () => {
    const { personMenuItems } = await import("../src/lib/context-menu");
    expect(personMenuItems({ name: "Ana Lima", email: "ana@x.org" }).map((i) => i.label)).toEqual(["Write to Ana", "Copy email address", "Copy name and address", "Show mail with Ana"]);
    expect(personMenuItems({ name: "", email: "ana@x.org" }).map((i) => i.action)).toEqual(["write-to", "copy-address", "show-mail"]);
    expect(personMenuItems({ name: "Me", email: "me@x.org", isMe: true }).map((i) => i.action)).toEqual(["copy-address", "copy-contact"]);
    expect(personMenuItems({ email: "" })).toEqual([]);
  });

  it("names people and writes contact lines", async () => {
    const { firstName, contactLine } = await import("../src/lib/context-menu");
    expect(firstName("Lima, Ana")).toBe("Ana");
    expect(firstName("\"Ana Lima\"")).toBe("Ana");
    expect(firstName("ana@x.org")).toBe("");
    expect(contactLine("Ana Lima", "ana@x.org")).toBe("Ana Lima <ana@x.org>");
    expect(contactLine("Lima, Ana", "ana@x.org")).toBe("\"Lima, Ana\" <ana@x.org>");
    expect(contactLine("", "ana@x.org")).toBe("ana@x.org");
  });

  it("offers Save all beside other files in an email and Show the email in the Attachments view", async () => {
    const { attachmentMenuItems } = await import("../src/lib/context-menu");
    expect(attachmentMenuItems({ canPreview: true, others: 2 }).map((i) => i.label)).toEqual(["Quick Look", "Open", "Save…", "Save all 3 to Downloads", "Copy file name"]);
    expect(attachmentMenuItems({ others: 0 }).map((i) => i.action)).toEqual(["open", "save", "copy-name"]);
    expect(attachmentMenuItems({ inLibrary: true, others: 5 }).map((i) => i.action)).toEqual(["open", "save", "copy-name", "show-email"]);
  });
});
