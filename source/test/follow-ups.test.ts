import { describe, expect, it, vi } from "vitest";
import { baseSubject, followUpFor, followUpMessage, mightReply, repliesTo } from "../src/lib/follow-ups";
import { FollowUpService } from "../src/lib/follow-up-service";

const DAY = 86400000;
const sent = followUpFor("<abc@example.org>", "Budget for Q4", ["Ana Diaz <ana@example.org>", "bo@example.org"], 1_000_000, 3);

describe("follow-up reminders", () => {
  it("records the sent email's Message-ID without brackets and its due time", () => {
    expect(sent).toMatchObject({ mid: "abc@example.org", dueAt: 1_000_000 + 3 * DAY, state: "waiting" });
  });
  it("recognizes a reply by In-Reply-To or References, not by subject", () => {
    expect(repliesTo({ "In-Reply-To": ["<abc@example.org>"] }, "abc@example.org")).toBe(true);
    expect(repliesTo({ references: ["<x@y> <abc@example.org>"] }, "<abc@example.org>")).toBe(true);
    expect(repliesTo({ subject: ["Re: Budget for Q4"], references: ["<other@x>"] }, "abc@example.org")).toBe(false);
  });
  it("reads headers only of someone else's later mail from a recipient or with the same subject", () => {
    const me = new Set(["me@example.org"]);
    const after = new Date(1_000_000 + 1000);
    expect(mightReply(sent, { author: "Ana Diaz <ana@example.org>", subject: "Anything", date: after }, me)).toBe(true);
    expect(mightReply(sent, { author: "Cy <cy@example.org>", subject: "RE: Fwd: budget for q4", date: after }, me)).toBe(true);
    expect(mightReply(sent, { author: "Cy <cy@example.org>", subject: "Lunch", date: after }, me)).toBe(false);
    expect(mightReply(sent, { author: "Me <me@example.org>", subject: "Re: Budget for Q4", date: after }, me)).toBe(false);
    expect(mightReply(sent, { author: "ana@example.org", subject: "Re: Budget for Q4", date: new Date(0) }, me)).toBe(false);
    expect(baseSubject("AW: Re: Budget")).toBe("budget");
  });
  it("says who hasn't answered and since when", () => {
    expect(followUpMessage(sent, 1_000_000 + 3 * DAY)).toBe("No reply yet from Ana Diaz and bo@example.org · sent 3 days ago");
  });
});

function native(stored: Record<string, any>, mail: any[], headers: Record<number, any> = {}) {
  const store: any = { followUps: stored };
  return {
    store,
    storage: { local: { get: vi.fn(async (d: any) => ({ ...d, ...Object.fromEntries(Object.keys(d).filter((k) => k in store).map((k) => [k, structuredClone(store[k])])) })), set: vi.fn(async (v: any) => { Object.assign(store, structuredClone(v)); }) } },
    alarms: { get: vi.fn(async () => null), create: vi.fn(async () => {}), clear: vi.fn(async () => {}) },
    notifications: { create: vi.fn(async () => {}), clear: vi.fn(async () => {}) },
    accounts: { list: vi.fn(async () => [{ identities: [{ email: "me@example.org" }] }]) },
    messages: { query: vi.fn(async (q: any) => q.headerMessageId ? { messages: [{ id: 99 }] } : { id: null, messages: mail }), continueList: vi.fn(), getHeaders: vi.fn(async (id: number) => headers[id] || {}) },
  };
}

describe("follow-up service", () => {
  it("drops a reminder once a reply arrives, and only notifies the ones still without one", async () => {
    const now = Date.now();
    const answered = { ...followUpFor("one@x", "Plan", ["ana@example.org"], now - 4 * DAY, 3) };
    const silent = { ...followUpFor("two@x", "Budget", ["bo@example.org"], now - 4 * DAY, 3) };
    const api = native({ [answered.mid]: answered, [silent.mid]: silent }, [
      { id: 1, author: "ana@example.org", subject: "Re: Plan", date: new Date(now - DAY), headerMessageId: "r1" },
      { id: 2, author: "bo@example.org", subject: "Something else", date: new Date(now - DAY), headerMessageId: "r2" },
    ], { 1: { "in-reply-to": ["<one@x>"] }, 2: { references: ["<unrelated@x>"] } });
    await new FollowUpService(api, async () => {}).sweep();
    expect(Object.keys(api.store.followUps)).toEqual(["two@x"]);
    expect(api.store.followUps["two@x"].state).toBe("due");
    expect(api.notifications.create).toHaveBeenCalledTimes(1);
    expect(api.notifications.create).toHaveBeenCalledWith("spark-follow:two@x", expect.objectContaining({ title: "Budget" }));
    expect(api.messages.getHeaders).toHaveBeenCalledTimes(2); // only likely replies are read
  });
  it("leaves a reminder that isn't due yet waiting, and opens the sent email from its notification", async () => {
    const now = Date.now();
    const f = followUpFor("three@x", "Later", ["cy@example.org"], now, 2);
    const opened = vi.fn(async () => {});
    const api = native({ [f.mid]: f }, []);
    const service = new FollowUpService(api, opened);
    await service.sweep();
    expect(api.store.followUps["three@x"].state).toBe("waiting");
    expect(api.notifications.create).not.toHaveBeenCalled();
    expect(await service.clicked("spark-follow:three@x")).toBe(true);
    expect(opened).toHaveBeenCalledWith(99);
    expect(await service.clicked("spark-remind:x")).toBe(false);
  });
  it("reads saved mail instead of searching every folder, and asks Thunderbird before a reminder turns due", async () => {
    const now = Date.now();
    const answered = followUpFor("one@x", "Plan", ["ana@example.org"], now - DAY, 3); // not due yet
    const due = followUpFor("two@x", "Budget", ["bo@example.org"], now - 4 * DAY, 3); // reply read on a phone
    const api = native({ [answered.mid]: answered, [due.mid]: due }, [
      { id: 7, author: "bo@example.org", subject: "Re: Budget", date: new Date(now - DAY), headerMessageId: "r7" },
    ], { 7: { "in-reply-to": ["<two@x>"] } });
    const saved = {
      recentMail: vi.fn(async () => [{ id: -5, author: "ana@example.org", subject: "Re: Plan", date: new Date(now - 1000), headerMessageId: "r5" }] as any),
      cache: { body: vi.fn(async (id: number) => id === -5 ? { headers: { references: ["<one@x>"] } } : undefined), resolve: vi.fn(async (id: number) => id) },
    };
    await new FollowUpService(api, async () => {}, saved).sweep();
    expect(api.store.followUps).toEqual({}); // both answered
    expect(api.notifications.create).not.toHaveBeenCalled();
    expect(api.messages.query).toHaveBeenCalledTimes(1); // only to confirm the one turning due
    expect(api.messages.query.mock.calls[0][0].fromDate.getTime()).toBe(due.sentAt - 60000);
  });
  it("searches Thunderbird when saved mail may not be current", async () => {
    const now = Date.now();
    const f = followUpFor("one@x", "Plan", ["ana@example.org"], now - DAY, 3);
    const api = native({ [f.mid]: f }, [{ id: 1, author: "ana@example.org", subject: "Re: Plan", date: new Date(now - 1000), headerMessageId: "r1" }], { 1: { "in-reply-to": ["<one@x>"] } });
    const saved = { recentMail: vi.fn(async () => null), cache: { body: vi.fn(), resolve: vi.fn() } };
    await new FollowUpService(api, async () => {}, saved).sweep();
    expect(api.store.followUps).toEqual({});
    expect(api.messages.query).toHaveBeenCalledTimes(1);
  });
  it("opens the sent email from saved mail when a notification is clicked", async () => {
    const now = Date.now();
    const f = followUpFor("five@x", "Plan", ["ana@example.org"], now - DAY, 3);
    const opened = vi.fn(async () => {});
    const api = native({ [f.mid]: f }, []);
    const saved = { recentMail: vi.fn(async () => [{ id: -9, headerMessageId: "<five@x>", date: new Date(now - DAY) }] as any), cache: { body: vi.fn(), resolve: vi.fn(async () => 77) } };
    expect(await new FollowUpService(api, opened, saved).clicked("spark-follow:five@x")).toBe(true);
    expect(saved.cache.resolve).toHaveBeenCalledWith(-9);
    expect(opened).toHaveBeenCalledWith(77); // Thunderbird's id: the page doesn't know the background's stand-ins
    expect(api.messages.query).not.toHaveBeenCalled();
  });
});
