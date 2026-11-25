import { describe, expect, it } from "vitest";
import { addEntry, agentLook, entryFor, filtersText, markWords, matches, readLog, replacedDrafts, reviewItems, rowsOf, seenAgent, sessionsOf, summaryOf, touchesOf, NEW_AGENT_GRACE_MS, type ActivityEntry } from "../src/lib/agent-activity";
import { applyMarks, restoreMarks } from "../src/lib/agent-marks";

const T = Date.parse("2026-11-16T14:00:00");
const MIN = 60000;
const ref = (id: string) => ({ id, from: `Person <${id}>`, subject: `Subject ${id}` });
let n = 0;
const e = (o: Partial<ActivityEntry>): ActivityEntry => ({ id: `e${n++}`, at: T, agent: "claude-code", kind: "read", ...o });

describe("who did it", () => {
  it("names the agents people use, and makes a name for others", () => {
    expect(agentLook("claude-code")).toMatchObject({ name: "Claude Code", initials: "CC" });
    expect(agentLook("codex-mcp-client").name).toBe("Codex");
    expect(agentLook("claude-ai").name).toBe("Claude");
    expect(agentLook("unknown").name).toBe("An agent");
    const other = agentLook("my-mail-helper");
    expect(other).toMatchObject({ name: "My mail helper", initials: "MM" });
    expect(agentLook("my-mail-helper").color).toBe(other.color); // stable
    expect(agentLook("x", "Zed Assistant").name).toBe("Zed Assistant");
  });

  it("learns agents quietly at first, then says when a new one shows up", () => {
    const first = seenAgent(null, "claude-code", T);
    expect(first.isNew).toBe(false);
    const again = seenAgent(first.registry, "codex-mcp-client", T + 3600000);
    expect(again.isNew).toBe(false); // within the first day
    const later = seenAgent(again.registry, "cursor-vscode", T + NEW_AGENT_GRACE_MS + 1);
    expect(later.isNew).toBe(true);
    expect(later.registry.agents["cursor-vscode"]).toMatchObject({ first: T + NEW_AGENT_GRACE_MS + 1, count: 1, alert: true });
    const repeat = seenAgent(later.registry, "claude-code", T + NEW_AGENT_GRACE_MS + 5);
    expect(repeat.isNew).toBe(false);
    expect(repeat.registry.agents["claude-code"]).toMatchObject({ first: T, count: 2, last: T + NEW_AGENT_GRACE_MS + 5 });
  });
});

describe("what it did", () => {
  const ctx = { agent: "codex-mcp-client", now: T, ref };
  it("records searches, browsing (as words), reads, opens, marks and drafts", () => {
    expect(entryFor("find", { query: " budget  slides ", reason: "Friday call" }, { result: { total: 4 } }, ctx)).toMatchObject({ kind: "search", query: "budget slides", found: 4, reason: "Friday call", agent: "codex-mcp-client" });
    expect(entryFor("find", { signal: "needs_reply", unread_only: true, days: 7 }, { result: { total: 2 } }, ctx)).toMatchObject({ kind: "browse", query: "Needs reply, unread, last 7 days" });
    expect(entryFor("read", { id: "a@x" }, { result: { id: "a@x", from: "Ann <a@x>", subject: "Hi" } }, ctx)?.emails).toEqual([{ id: "a@x", from: "Ann <a@x>", subject: "Hi" }]);
    expect(entryFor("read", { id: "gone@x" }, { error: "No email with id gone@x in Thunderbird." }, { ...ctx, ref: () => null })).toMatchObject({ kind: "read", error: "No email with id gone@x in Thunderbird.", emails: [{ id: "gone@x", from: "", subject: "" }] });
    expect(entryFor("open", { id: "a@x" }, { result: { opened: true, id: "a@x", subject: "Hi" } }, ctx)?.emails?.[0]).toMatchObject({ id: "a@x", subject: "Hi" });
    const mark = entryFor("mark", { ids: ["a@x", "b@x"], top: true, needs_reply: true, note: "Due Friday" }, { result: {} }, { ...ctx, before: { "a@x": null, "b@x": { important: true } } })!;
    expect(mark).toMatchObject({ kind: "mark", change: { top: true, reply: true, note: "Due Friday" }, before: { "a@x": null, "b@x": { important: true } } });
    expect(mark.emails!.map((m) => m.id)).toEqual(["a@x", "b@x"]);
    const draft = entryFor("draft", { id: "a@x", text: "Thanks!\n\nTalk soon" }, { result: { draft_id: "d1@x", replied_to: "a@x" } }, ctx)!;
    expect(draft).toMatchObject({ kind: "draft", draft: "d1@x", preview: "Thanks! Talk soon", emails: [ref("a@x")] });
    expect(entryFor("status", {}, { result: {} }, ctx)).toMatchObject({ kind: "check", what: "status" });
    expect(entryFor("nope", {}, { result: {} }, ctx)).toBe(null);
  });

  it("keeps the days asked for, newest first, and reads storage defensively", () => {
    const old = e({ at: T - 31 * 86400000 }), recent = e({ at: T - 86400000 });
    expect(addEntry([recent, old], e({ id: "new" }), T, 30).map((x) => x.id)).toEqual(["new", recent.id]);
    expect(addEntry([recent], e({ id: "new" }), T, 30, 1).map((x) => x.id)).toEqual(["new"]);
    expect(readLog([recent, null, { id: 1 }, "x"])).toEqual([recent]);
    expect(readLog(undefined)).toEqual([]);
  });

  it("puts filters and marks into words", () => {
    expect(filtersText({ section: "newsletters", days: 3 })).toBe("Newsletters, last 3 days");
    expect(filtersText({})).toBe("Last 14 days");
    expect(markWords({ top: true, reply: true })).toBe("to the top, needs reply");
    expect(markWords({ important: false })).toBe("not important");
    expect(markWords({ note: "x" })).toBe("with a note");
  });
});

describe("how it's shown", () => {
  it("groups an agent's back-to-back work into sessions, with the reason it gave first", () => {
    const log = [
      e({ at: T, kind: "draft", agent: "claude-code" }),
      e({ at: T - 2 * MIN, kind: "read", agent: "claude-code", reason: "later reason" }),
      e({ at: T - 3 * MIN, kind: "search", agent: "claude-code", reason: "Find what Dana needs" }),
      e({ at: T - 4 * MIN, kind: "read", agent: "codex-mcp-client" }),
      e({ at: T - 30 * MIN, kind: "read", agent: "codex-mcp-client" }), // a gap: a new session
    ];
    const sessions = sessionsOf(log);
    expect(sessions.map((s) => [s.agent, s.entries.length])).toEqual([["claude-code", 3], ["codex-mcp-client", 1], ["codex-mcp-client", 1]]);
    expect(sessions[0]).toMatchObject({ reason: "Find what Dana needs", start: T - 3 * MIN, end: T });
  });

  it("folds back-to-back reads into one row with their emails, and leaves failures on their own", () => {
    const log = [e({ kind: "draft" }), e({ emails: [ref("a")] }), e({ emails: [ref("b")] }), e({ emails: [ref("a")] }), e({ emails: [ref("c")], error: "nope" }), e({ emails: [ref("d")] })];
    const rows = rowsOf(log);
    expect(rows.map((r) => (r.kind === "reads" ? `reads:${r.emails.map((m) => m.id).join("")}` : r.entry.kind))).toEqual(["draft", "reads:ab", "read", "read"]);
    expect(rowsOf(log, false)).toHaveLength(6);
  });

  it("sums up a session", () => {
    const log = [e({ kind: "search" }), e({ kind: "read", emails: [ref("a")] }), e({ kind: "read", emails: [ref("b")] }), e({ kind: "read", emails: [ref("a")] }), e({ kind: "mark", emails: [ref("a"), ref("b")] }), e({ kind: "draft" }), e({ kind: "read", error: "x" })];
    expect(summaryOf(log)).toBe("Searched once, read 2 emails, marked 2, drafted 1 reply, 1 failed");
  });

  it("filters: status checks only with Everything", () => {
    const check = e({ kind: "check" }), draft = e({ kind: "draft" }), mark = e({ kind: "mark" }), read = e({ kind: "read", agent: "codex-mcp-client" });
    expect([check, draft, mark, read].filter((x) => matches(x, "all"))).toEqual([draft, mark, read]);
    expect([check, draft, mark, read].filter((x) => matches(x, "everything"))).toHaveLength(4);
    expect([check, draft, mark, read].filter((x) => matches(x, "drafts"))).toEqual([draft]);
    expect([check, draft, mark, read].filter((x) => matches(x, "reads"))).toEqual([read]);
    expect([check, draft, mark, read].filter((x) => matches(x, "agent:codex-mcp-client"))).toEqual([read]);
  });

  it("knows a draft the agent replaced, and lists what's left to review", () => {
    const newer = e({ kind: "draft", draft: "d2", emails: [ref("a")] });
    const older = e({ kind: "draft", draft: "d1", emails: [ref("a")], at: T - MIN });
    const top = e({ kind: "mark", change: { top: true }, emails: [ref("b"), ref("c")] });
    const log = [newer, older, top];
    expect([...replacedDrafts(log)]).toEqual([older.id]);
    const items = reviewItems(log, { dismissed: new Set(), draftState: (x) => (x.id === newer.id ? "waiting" : "replaced"), onTop: (id) => id === "b" });
    expect(items.map((i) => [i.what, i.email?.id])).toEqual([["draft", "a"], ["top", "b"]]);
    expect(reviewItems(log, { dismissed: new Set([newer.id]), draftState: () => "sent", onTop: () => false })).toEqual([]);
    expect(touchesOf(log, new Set(["c"]))).toEqual([top]);
  });
});

describe("Undo of an agent's mark", () => {
  it("puts marks back as they were, keeping a reply draft linked since", () => {
    let marks = applyMarks({}, ["b@x"], { important: true }, "user", 1);
    marks = applyMarks(marks, ["a@x", "b@x"], { top: true, reply: true }, "agent", 2);
    marks = applyMarks(marks, ["a@x"], { draft: "d@x" }, "agent", 3);
    const back = restoreMarks(marks, { "a@x": null, "b@x": { important: true } }, 4);
    expect(back).toEqual({ "a@x": { draft: "d@x", at: 4, by: "user" }, "b@x": { important: true, at: 4, by: "user" } });
    expect(restoreMarks(applyMarks({}, ["c@x"], { top: true }, "agent", 1), { "c@x": null })).toEqual({});
  });
});

describe("calendar requests and holds", () => {
  const ctx = { agent: "claude-code", now: Date.UTC(2026, 10, 16, 20) };
  const hold = { event_id: "a1:EV9", account_id: "a1", item_id: "EV9", title: "Venue walkthrough", start: "2026-11-19T18:00:00.000Z", end: "2026-11-19T19:30:00.000Z", to_invite: [{ name: "Priya Nair", email: "priya@x.test" }] };
  it("records looking at the calendar, free times found and a hold", () => {
    expect(entryFor("calendar", { reason: "Plan the week" }, { result: { range: "Thu, Nov 19 – Mon, Nov 23", events: [{}, {}] } }, ctx)).toMatchObject({ kind: "calendar", what: "events", query: "Thu, Nov 19 – Mon, Nov 23", found: 2, reason: "Plan the week" });
    expect(entryFor("free", {}, { result: { people: [{ you: true, email: "me@x.test" }, { name: "Priya Nair", email: "priya@x.test" }], free: [{ label: "Thu 1:00 PM" }, { label: "Fri 10:00 AM" }] } }, ctx)).toMatchObject({ kind: "calendar", what: "free", query: "with Priya Nair: Thu 1:00 PM, Fri 10:00 AM", found: 2 });
    expect(entryFor("hold", { title: "Venue walkthrough" }, { result: hold }, ctx)).toMatchObject({ kind: "hold", hold: { accountId: "a1", itemId: "EV9", subject: "Venue walkthrough", start: Date.parse(hold.start), invite: [{ name: "Priya Nair", email: "priya@x.test" }] } });
    expect(entryFor("hold", { title: "X" }, { error: "No calendar" }, ctx)).toMatchObject({ kind: "hold", error: "No calendar", query: "X" });
  });
  it("puts undecided holds in To review and counts them in the summary", () => {
    const e = { ...entryFor("hold", { title: "Venue walkthrough" }, { result: hold }, ctx)!, id: "h1" };
    const look = { ...entryFor("calendar", {}, { result: { range: "x", events: [] } }, ctx)!, id: "c1" };
    const base = { dismissed: new Set<string>(), draftState: () => undefined, onTop: () => false };
    expect(reviewItems([e], base).map((i) => i.what)).toEqual(["hold"]);
    expect(reviewItems([e], { ...base, holdState: () => "invited" })).toEqual([]);
    expect(reviewItems([e], { ...base, dismissed: new Set(["h1"]) })).toEqual([]);
    expect(summaryOf([e, look])).toBe("Checked your calendar, held 1 time");
    expect(matches(e, "reads")).toBe(false);
    expect(matches(look, "reads")).toBe(true);
  });
});
