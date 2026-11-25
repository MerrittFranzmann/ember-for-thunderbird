import { describe, expect, it } from "vitest";
import { INBOX_GROUPS, groupQuestion, groupsOf, inboxOf, ruleGroup, vocabularyKey, workDomains } from "../src/lib/inboxes";
import { aiGroup, clefGroup, clefRequest, hasGroupAnswer, unsorted } from "../src/lib/ai-sort";
import { splitInbox, mailboxGroups, sameView } from "../src/lib/mailboxes";
import { categoryParent, scopedCategory } from "../src/lib/inbox";
import { datasetKey } from "../src/lib/view-cache";
import type { MailAccount, MessageHeader } from "../src/lib/types";

const header = (over: Partial<MessageHeader> = {}): MessageHeader => ({ id: 1, date: new Date(), author: "Ada <ada@x.org>", subject: "Hi", flagged: false, recipients: [], ccList: [], bccList: [], headerMessageId: "a@x", size: 1, tags: [], ...over } as MessageHeader);

describe("Work and Personal inboxes", () => {
  it("puts an account's mail in Work or Personal, and has one inbox without work accounts", () => {
    expect(inboxOf("account7", ["account7", "account8"])).toBe("work");
    expect(inboxOf("account1", ["account7"])).toBe("personal");
    expect(inboxOf(undefined, ["account7"])).toBe("personal");
    expect(inboxOf("account7", [])).toBeNull();
  });

  it("places mail by the rules when there's no sender rule or sure AI answer", () => {
    const ctx = { internal: false, promotion: false, subject: "" };
    expect(ruleGroup("work", { ...ctx, base: "people", internal: true })).toBe("team");
    expect(ruleGroup("work", { ...ctx, base: "people" })).toBe("outside");
    expect(ruleGroup("work", { ...ctx, base: "notification" })).toBe("tools");
    expect(ruleGroup("work", { ...ctx, base: "newsletter" })).toBe("announcements");
    expect(ruleGroup("work", { ...ctx, base: "receipt" })).toBe("receipts");
    expect(ruleGroup("personal", { ...ctx, base: "calendar" })).toBe("plans");
    expect(ruleGroup("personal", { ...ctx, base: "notification", subject: "Your order has shipped" })).toBe("purchases");
    expect(ruleGroup("personal", { ...ctx, base: "notification", subject: "Your reservation at Husk" })).toBe("plans");
    expect(ruleGroup("personal", { ...ctx, base: "notification", subject: "Your statement is ready" })).toBe("accounts");
    expect(ruleGroup("personal", { ...ctx, base: "newsletter", subject: "40% off everything this weekend" })).toBe("promotions");
    expect(ruleGroup("personal", { ...ctx, base: "newsletter", promotion: true })).toBe("promotions");
    expect(ruleGroup("personal", { ...ctx, base: "newsletter", subject: "The Sunday letter" })).toBe("newsletters");
  });

  it("knows the work domains (not Gmail and other consumer mail)", () => {
    expect([...workDomains(["alex.morgan@northwind.example", "me@Fabrikam.com", "me@gmail.com", "x@outlook.com"])]).toEqual(["northwind.example", "fabrikam.com"]);
  });

  it("applies the user's names, order and hidden groups", () => {
    const groups = groupsOf("work", { inboxGroups: { work: { order: ["tools", "team"], hidden: ["announcements"], labels: { team: "Northwind people" } } } });
    expect(groups.map((g) => g.id)).toEqual(["tools", "team", "outside", "calendar", "receipts", "announcements"]);
    expect(groups[1].label).toBe("Northwind people");
    expect(groups.find((g) => g.id === "announcements")!.hidden).toBe(true);
  });

  it("asks Clef for the inbox's group, and uses only answers for its current groups", () => {
    const request = clefRequest(header(), undefined, { inbox: "personal", important: "Bills due" });
    expect(request.questions.group).toEqual(groupQuestion("personal"));
    expect(Object.keys(request.questions.group!.criteria)).toEqual(INBOX_GROUPS.personal.map((g) => g.id));
    expect(request.questions.important.instructions).toContain("In this inbox, important means: Bills due");
    expect("group" in clefRequest(header(), undefined).questions).toBe(false);

    const answer = clefGroup({ result: { answers: { group: { choice: "purchases", confidence: 0.91 } } } }, "personal")!;
    expect(answer).toEqual([vocabularyKey("personal"), "purchases", 91]);
    expect(clefGroup({ result: { answers: { group: { choice: "team", confidence: 0.9 } } } }, "personal")).toBeNull();
    const groups = { "a@x": answer };
    expect(aiGroup(groups, header(), "personal")).toBe("purchases");
    expect(aiGroup({ "a@x": ["old", "purchases", 91] }, header(), "personal")).toBeNull();
    expect(aiGroup({ "a@x": [vocabularyKey("personal"), "purchases", 60] }, header(), "personal")).toBeNull();
    expect(vocabularyKey("work")).not.toBe(vocabularyKey("personal"));

    // An email with a full base answer but no group answer for its inbox is asked again.
    const inbox = header({ folder: { id: "f", accountId: "a1", specialUse: ["inbox"] } as any });
    const base = { "a@x": ["people", 90, 1, 10, 10, 10, 10] as any };
    expect(unsorted([inbox], base, new Set())).toHaveLength(0);
    expect(unsorted([inbox], base, new Set(), (m) => hasGroupAnswer({}, m, "personal"))).toHaveLength(1);
    expect(unsorted([inbox], base, new Set(), (m) => hasGroupAnswer(groups, m, "personal"))).toHaveLength(0);
  });

  it("splits the sidebar's Inbox into Work and Personal (and keeps All inboxes when asked)", () => {
    const account = (id: string, email: string): MailAccount => ({ id, name: email, type: "imap", identities: [{ email, name: "M" } as any], folders: [{ id: `${id}/INBOX`, name: "Inbox", path: "/INBOX", accountId: id, specialUse: ["inbox"] } as any] });
    const groups = mailboxGroups([account("a1", "me@gmail.com"), account("a7", "me@northwind.example")]);
    expect(splitInbox(groups, []).map((g) => g.key)).toEqual(["inbox", "pins"]);
    const split = splitInbox(groups, ["a7"]);
    expect(split.map((g) => g.key)).toEqual(["inbox-work", "inbox-personal", "pins"]);
    expect(split[0].accounts.map((e) => e.accountId)).toEqual(["a7"]);
    expect(split[0].view).toEqual({ kind: "smart", inbox: "work" });
    expect(splitInbox(groups, ["a7"], true).map((g) => g.label)).toEqual(["Work", "Personal", "All inboxes", "Pins"]);
    expect(splitInbox(groups, ["a1", "a7"]).map((g) => g.key)).toEqual(["inbox", "pins"]);
  });

  it("keeps each inbox's groups in its own views", () => {
    const work = { kind: "smart", inbox: "work" } as const;
    const team = scopedCategory("team", work);
    expect(team).toEqual({ kind: "category", cat: "team", inbox: "work" });
    expect(categoryParent(team)).toEqual(work);
    expect(datasetKey(team)).toBe("smart:work");
    expect(datasetKey({ kind: "smart" })).toBe("smart");
    expect(sameView(work, { kind: "smart", inbox: "personal" })).toBe(false);
    expect(sameView(team, { kind: "category", cat: "team" })).toBe(false);
  });
});
