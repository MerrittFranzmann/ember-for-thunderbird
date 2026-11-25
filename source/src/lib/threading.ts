// Conversation grouping. The MailExtension API doesn't expose Thunderbird's
// threads, so we rebuild them:
//   1. References / In-Reply-To (when cached headers are available) — exact.
//   2. Normalized subject + overlapping participants (excluding "me") — heuristic.
//   3. Meeting answers ("Accepted: X", "Declined: X") — one row per meeting.
// Automated mail (notifications/newsletters) is only grouped by (1), so a stream
// of identical "Your receipt" subjects doesn't collapse into one conversation.

import { responseSubject } from "./meeting-subjects";
import type { Category, Conversation, MessageHeader, MessageMeta } from "./types";
import { displayName, emailOf, normSubject } from "./format";

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(i: number): number {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a: number, b: number) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[rb] = ra;
  }
}

// Address parsing dominates regrouping on large mailboxes; the same few thousand address strings
// repeat across tens of thousands of messages, so parse each once.
const parsed = new Map<string, { email: string; name: string }>();
function addr(s: string) {
  let a = parsed.get(s);
  if (!a) {
    if (parsed.size > 20000) parsed.clear();
    a = { email: emailOf(s), name: displayName(s) };
    parsed.set(s, a);
  }
  return a;
}

// Subjects repeat just as much (replies, recurring mail); normalizing runs several regexes.
const subjects = new Map<string, string>();
function subjectKey(s: string | undefined) {
  const raw = s || "";
  let key = subjects.get(raw);
  if (key === undefined) {
    if (subjects.size > 20000) subjects.clear();
    subjects.set(raw, key = normSubject(raw));
  }
  return key;
}

// Meeting answers ("Accepted: X") from different people: one key per meeting title.
const meetings = new Map<string, string>();
function meetingKey(s: string | undefined) {
  const raw = s || "";
  let key = meetings.get(raw);
  if (key === undefined) {
    if (meetings.size > 20000) meetings.clear();
    const answer = responseSubject(raw);
    meetings.set(raw, key = answer ? answer.title.toLowerCase() : "");
  }
  return key;
}

function participants(m: MessageHeader, me: Set<string>): string[] {
  const out: string[] = [];
  for (const s of [m.author, ...(m.recipients || []), ...(m.ccList || [])]) {
    const e = addr(s).email;
    if (e && !me.has(e)) out.push(e);
  }
  return out;
}

export interface GroupOptions {
  me: Set<string>;
  meta: (m: MessageHeader) => MessageMeta | undefined;
  category: (m: MessageHeader) => Category;
  hasAttachment: (m: MessageHeader) => boolean;
  /** Set false to disable grouping (one conversation per message). */
  enabled?: boolean;
}

export function messageId(value: string): string {
  // Same as trim + strip one leading "<" and trailing ">", without regexes (called per message per regroup).
  let s = value;
  if (s.charCodeAt(0) <= 32 || s.charCodeAt(s.length - 1) <= 32) s = s.trim();
  const start = s.charCodeAt(0) === 60 ? 1 : 0;
  const end = s.length > start && s.charCodeAt(s.length - 1) === 62 ? s.length - 1 : s.length;
  return start || end < s.length ? s.slice(start, end) : s;
}

export function groupConversations(msgs: MessageHeader[], o: GroupOptions): Conversation[] {
  const n = msgs.length;
  const uf = new UnionFind(n);
  // Computed once per message (sorting re-parsed dates and categories were looked up twice).
  const time = msgs.map((m) => m.date instanceof Date ? m.date.getTime() : +new Date(m.date));
  const category = msgs.map((m) => o.category(m));
  const meta = msgs.map((m) => o.meta(m));

  if (o.enabled !== false) {
    // 1. Header references.
    const byMid = new Map<string, number>();
    msgs.forEach((m, i) => {
      if (m.headerMessageId) byMid.set(messageId(m.headerMessageId), i);
    });
    msgs.forEach((m, i) => {
      const refs = meta[i]?.refs;
      if (!refs) return;
      for (const r of refs) {
        const ref = messageId(r);
        if (!ref) continue;
        const j = byMid.get(ref);
        if (j !== undefined) uf.union(j, i);
        else byMid.set(ref, i); // siblings can share a parent absent from this folder
      }
    });

    // 2. Subject + participants (people only).
    const bySubject = new Map<string, number[]>();
    msgs.forEach((m, i) => {
      if (category[i] !== "people") return;
      const key = subjectKey(m.subject);
      if (key.length < 3) return;
      let arr = bySubject.get(key);
      if (!arr) bySubject.set(key, (arr = []));
      arr.push(i);
    });
    for (const idxs of bySubject.values()) {
      if (idxs.length < 2) continue;
      // Thunderbird strips "Re:" from MessageHeader.subject, so we can't rely on reply
      // prefixes: merge same-subject messages that share a participant (other than me)
      // and are close in time (a conversation, not a recurring subject line).
      const sorted = idxs.slice().sort((a, b) => time[a] - time[b]);
      const clusters: { root: number; people: Set<string>; last: number }[] = [];
      const WINDOW = 21 * 86400000;
      for (const i of sorted) {
        const ps = participants(msgs[i], o.me);
        const t = time[i];
        const hit = clusters.find((c) => t - c.last < WINDOW &&
          // Explicit, disjoint reply chains must not be joined by a reused subject.
          !(meta[i]?.refs?.length && meta[c.root]?.refs?.length && uf.find(i) !== uf.find(c.root)) && ps.some((p) => c.people.has(p)));
        if (hit) {
          uf.union(hit.root, i);
          ps.forEach((p) => hit.people.add(p));
          hit.last = Math.max(hit.last, t);
        } else {
          clusters.push({ root: i, people: new Set(ps), last: t });
        }
      }
    }

    // 3. Answers to one meeting, whoever sent them, while they keep arriving.
    const byMeeting = new Map<string, number[]>();
    msgs.forEach((m, i) => {
      const key = meetingKey(m.subject);
      if (!key) return;
      let arr = byMeeting.get(key);
      if (!arr) byMeeting.set(key, (arr = []));
      arr.push(i);
    });
    for (const idxs of byMeeting.values()) {
      if (idxs.length < 2) continue;
      const sorted = idxs.slice().sort((a, b) => time[a] - time[b]);
      for (let k = 1; k < sorted.length; k++) if (time[sorted[k]] - time[sorted[k - 1]] < 30 * 86400000) uf.union(sorted[k - 1], sorted[k]);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = uf.find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(i);
  }

  const convs: Conversation[] = [];
  const latestTime: number[] = [];
  for (const idxs of groups.values()) {
    idxs.sort((a, b) => time[b] - time[a] || msgs[b].id - msgs[a].id);
    const ms = idxs.map((i) => msgs[i]);
    const latest = ms[0];
    const oldest = ms[ms.length - 1];
    const senders: string[] = [];
    const seen = new Set<string>();
    for (const m of ms) {
      const { email: e, name } = addr(m.author);
      if (seen.has(e)) continue;
      seen.add(e);
      senders.push(o.me.has(e) ? "Me" : name);
    }
    // A conversation is "people" if any message is.
    const cat: Category = idxs.some((i) => category[i] === "people") ? "people" : category[idxs[0]];
    convs.push({
      key: oldest.headerMessageId || `id:${oldest.id}`,
      ids: ms.map((m) => m.id),
      latest,
      count: ms.length,
      unread: ms.filter((m) => m.read === false).length,
      flagged: ms.some((m) => m.flagged),
      hasAttachment: ms.some(o.hasAttachment),
      cat,
      senders,
    });
    latestTime.push(time[idxs[0]]);
  }
  const order = convs.map((_, i) => i).sort((a, b) => latestTime[b] - latestTime[a]);
  // Keys must be unique: the list is a keyed {#each}, and a duplicate key stops it from rendering.
  const used = new Set<string>();
  return order.map((i) => {
    const c = convs[i];
    if (used.has(c.key)) c.key = `${c.key}#${c.ids[0]}`;
    used.add(c.key);
    return c;
  });
}

const COPY_RANK: Record<string, number> = { inbox: 0, sent: 1, drafts: 1, archives: 2 };

/**
 * One copy of each email. Gmail keeps the same message in Inbox, All Mail, Starred and Important,
 * so lists that span folders (Pins, Search all mail) would otherwise show it three or four times.
 * Keeps the Inbox copy, else Sent, else All Mail / Archive, else the first one listed.
 */
export function distinctCopies(msgs: MessageHeader[]): MessageHeader[] {
  const rank = (m: MessageHeader) => {
    for (const use of m.folder?.specialUse || []) if (use in COPY_RANK) return COPY_RANK[use];
    return 3;
  };
  const out: MessageHeader[] = [];
  const at = new Map<string, number>();
  for (const m of msgs) {
    const id = m.headerMessageId && messageId(m.headerMessageId);
    if (!id) { out.push(m); continue; }
    const i = at.get(id);
    if (i === undefined) { at.set(id, out.length); out.push(m); }
    else if (rank(m) < rank(out[i])) out[i] = m;
  }
  return out;
}

/** Select the connected conversation, keeping unlabelled messages distinct. */
export function relatedConversation(seeds: MessageHeader[], candidates: MessageHeader[], options: GroupOptions): MessageHeader[] {
  const merged: MessageHeader[] = [];
  const seen = new Set<string>();
  for (const m of [...seeds, ...candidates]) {
    const key = m.headerMessageId ? messageId(m.headerMessageId) : `id:${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(m);
  }
  const ids = new Set(seeds.map((m) => m.id));
  const groups = groupConversations(merged, { ...options, enabled: true });
  const keep = new Set(groups.filter((c) => c.ids.some((id) => ids.has(id))).flatMap((c) => c.ids));
  return merged.filter((m) => keep.has(m.id)).sort((a, b) => +new Date(b.date) - +new Date(a.date) || b.id - a.id);
}
