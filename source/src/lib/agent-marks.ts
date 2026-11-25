// Marks an AI agent (through Ember's MCP server) or the user sets on emails: needs a reply, important, and "top"
// (shown above the date groups in the inbox). Saved in storage (agentMarks) by Message-ID; an explicit mark wins
// over Clef's guess. Pure; unit-tested.
import { aiKey } from "./ai-sort";
import type { MessageHeader } from "./types";

export interface AgentMark {
  reply?: boolean; important?: boolean; top?: boolean; note?: string;
  /** The Message-ID of a reply draft an agent wrote for this email (in Drafts, not sent). */
  draft?: string;
  at: number; by: "agent" | "user";
}
export type AgentMarks = Record<string, AgentMark>;
export interface MarkChange { reply?: boolean; important?: boolean; top?: boolean; note?: string; draft?: string | null }

/** The marks after a change to some emails (by Message-ID). A mark with nothing left set is dropped. */
export function applyMarks(marks: AgentMarks, ids: string[], change: MarkChange, by: AgentMark["by"], now = Date.now()): AgentMarks {
  const next = { ...marks };
  for (const raw of ids) {
    const id = aiKey({ headerMessageId: raw });
    if (!id) continue;
    const mark: AgentMark = { ...next[id], at: now, by };
    for (const key of ["reply", "important", "top"] as const) if (change[key] !== undefined) mark[key] = change[key];
    if (change.note !== undefined) mark.note = change.note.trim().slice(0, 300) || undefined;
    if (change.draft !== undefined) mark.draft = change.draft ? aiKey({ headerMessageId: change.draft }) : undefined;
    // false is kept: "not important" overrides Clef's guess. Only an entry with nothing at all goes.
    if (mark.reply === undefined && mark.important === undefined && mark.top === undefined && !mark.note && !mark.draft) delete next[id];
    else next[id] = mark;
  }
  return next;
}

/** Marks set back to how they were before an agent changed them (Agent Activity's Undo); null: none. A reply
 *  draft linked since stays linked. */
export function restoreMarks(marks: AgentMarks, before: Record<string, { reply?: boolean; important?: boolean; top?: boolean; note?: string } | null>, now = Date.now()): AgentMarks {
  const next = { ...marks };
  for (const [raw, mark] of Object.entries(before)) {
    const id = aiKey({ headerMessageId: raw });
    if (!id) continue;
    const draft = next[id]?.draft;
    if (!mark && !draft) { delete next[id]; continue; }
    next[id] = { ...(mark || {}), ...(draft ? { draft } : {}), at: now, by: "user" };
  }
  return next;
}

export function markOf(marks: AgentMarks, message: Pick<MessageHeader, "headerMessageId">): AgentMark | undefined {
  return marks[aiKey(message)];
}

/** Whether a conversation belongs at the top: one of its emails is marked top, unless it was marked because it
 *  needs a reply and the user has since replied (the newest email is theirs). */
export function topOf(marks: AgentMarks, messages: Pick<MessageHeader, "headerMessageId">[], newestIsMine: boolean): boolean {
  return messages.some((m) => { const mark = markOf(marks, m); return !!mark?.top && !(mark.reply && newestIsMine); });
}
