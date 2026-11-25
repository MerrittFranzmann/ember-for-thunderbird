import { describe, expect, it } from "vitest";
import { classify, quickClassify } from "../src/lib/classify";

const me = new Set(["merritt@spark.test"]);

describe("classify", () => {
  it("people by default", () => {
    expect(classify("Ada <ada@x.org>", {}, me)).toBe("people");
  });
  it("me is people", () => {
    expect(classify("Merritt <merritt@spark.test>", { "list-unsubscribe": ["<x>"] }, me)).toBe("people");
  });
  it("newsletters: List-Unsubscribe + List-Id / bulk", () => {
    expect(classify("Brew <crew@brew.example>", { "list-unsubscribe": ["<https://u>"], "list-id": ["<brew.list>"] }, me)).toBe("newsletter");
    expect(classify("X <hello@x.example>", { "list-unsubscribe": ["<https://u>"], precedence: ["bulk"] }, me)).toBe("newsletter");
    expect(classify("X <a@x.example>", { "x-mailchimp-campaign": ["1"] }, me)).toBe("newsletter");
  });
  it("notifications: noreply, Auto-Submitted, GitHub, bare List-Unsubscribe", () => {
    expect(classify("Dropbox <no-reply@dropbox.com>", {}, me)).toBe("notification");
    expect(classify("Cal <cal@g.com>", { "auto-submitted": ["auto-generated"] }, me)).toBe("notification");
    expect(
      classify("GitHub <notifications@github.com>", { "x-github-reason": ["mention"], "list-id": ["<a.b>"], "list-unsubscribe": ["<m>"] }, me),
    ).toBe("notification");
    expect(classify("Slack <feedback@slack.com>", { "list-unsubscribe": ["<https://u>"] }, me)).toBe("notification");
  });
  it("discussion lists with List-Post stay with people", () => {
    expect(classify("Bob <bob@x.org>", { "list-id": ["<dev.x.org>"], "list-post": ["<mailto:dev@x.org>"], "list-unsubscribe": ["<m>"] }, me)).toBe("people");
  });
  it("address-only fallback", () => {
    expect(classify("News <newsletter@x.com>", undefined, me)).toBe("newsletter");
    expect(classify("Alerts <alerts@bank.com>", undefined, me)).toBe("notification");
  });
});

describe("calendar mail", () => {
  it("recognises meeting mail by Exchange/Google headers or its subject", () => {
    expect(classify("Ada <ada@partner.org>", { "x-ms-exchange-calendar-series-instance-id": ["abc"] })).toBe("calendar");
    expect(classify("Google Calendar <calendar-notification@google.com>", { "x-google-calendar-content-type": ["invite"], "list-unsubscribe": ["<x>"] })).toBe("calendar");
    expect(classify("Ada <ada@partner.org>", { "content-class": ["urn:content-classes:calendarmessage"] })).toBe("calendar");
    expect(quickClassify("Ada <ada@partner.org>", undefined, "Accepted: Board prep")).toBe("calendar");
    expect(quickClassify("Ada <ada@partner.org>", undefined, "Invitation: Standup @ Weekly from 9am")).toBe("calendar");
    expect(quickClassify("Ada <ada@partner.org>", undefined, "Canceled: Vendor call")).toBe("calendar");
    expect(quickClassify("Ada <ada@partner.org>", undefined, "Your invitation to speak")).toBe("people");
    // The user's own mail stays People.
    expect(quickClassify("Me <me@x.org>", new Set(["me@x.org"]), "Invitation: Standup")).toBe("people");
  });
});
