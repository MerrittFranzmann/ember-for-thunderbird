// Archives that stay archived. Thunderbird can report an archive as done when the server didn't take it (Exchange
// then puts the email back in the Inbox on the next sync or restart). Ember remembers what the user archived, by
// Message-ID and the folder it came from, for a few days: if one of those emails shows up in that folder again,
// it's archived again (at most MAX_AGAIN times). An archive the server kept refusing (an Exchange outage) waits:
// Ember tries it again every few minutes for RETRY_FOR_MS. Undo, or moving it in Ember, forgets it. Pure and unit-tested
// (test/archive-intents.test.ts); the store keeps them in storage.local "archiveIntents".

export interface ArchiveIntent {
  /** The folder it was archived from (Thunderbird folder id, e.g. "account8://Inbox"). */
  folderId: string;
  /** When it was (last) archived. */
  at: number;
  /** Confirmed archived (by Thunderbird's own check); only then does coming back count. */
  settled: boolean;
  /** How many times it came back and was archived again. */
  again: number;
  /** The server refused the move; since when Ember keeps trying (every RETRY_EVERY_MS, for RETRY_FOR_MS). */
  pending?: number;
}

export type ArchiveIntents = Record<string, ArchiveIntent>;

export const KEEP_MS = 3 * 24 * 3600 * 1000;
export const MAX_AGAIN = 2;
export const MAX_INTENTS = 2000;
export const RETRY_EVERY_MS = 3 * 60 * 1000;
/** As long as the toast's promise ("Ember will archive it when the server answers") reasonably holds. */
export const RETRY_FOR_MS = 24 * 3600 * 1000;

interface Mail { headerMessageId?: string; folder?: { id?: string } | null }

/** Remember these as archived from their folders (not yet confirmed). */
export function remember(intents: ArchiveIntents, mails: Mail[], now: number): ArchiveIntents {
  const next = { ...intents };
  for (const m of mails) {
    if (!m.headerMessageId || !m.folder?.id) continue;
    next[m.headerMessageId] = { folderId: m.folder.id, at: now, settled: false, again: next[m.headerMessageId]?.again ?? 0 };
  }
  return prune(next, now);
}

/** Thunderbird confirmed these left their folders. */
export function settle(intents: ArchiveIntents, messageIds: string[]): ArchiveIntents {
  const next = { ...intents };
  for (const id of messageIds) if (next[id]) { const { pending: _, ...intent } = next[id]; next[id] = { ...intent, settled: true }; }
  return next;
}

/** The server refused these: keep trying for a while (the first refusal starts the clock). */
export function defer(intents: ArchiveIntents, messageIds: string[], now: number): ArchiveIntents {
  const next = { ...intents };
  for (const id of messageIds) if (next[id]) next[id] = { ...next[id], settled: false, pending: next[id].pending ?? now };
  return next;
}

/** Emails whose archive is waiting for the server, still in the folder they were archived from. */
export function waiting<T extends Mail>(intents: ArchiveIntents, mails: T[], now: number): T[] {
  const seen = new Set<string>();
  return mails.filter((m) => {
    const id = m.headerMessageId;
    const intent = id ? intents[id] : undefined;
    if (!id || !intent?.pending || seen.has(id) || now - intent.pending >= RETRY_FOR_MS || m.folder?.id !== intent.folderId) return false;
    seen.add(id);
    return true;
  });
}

/** Stop watching these (Undo, moved or deleted in Ember, or the archive failed and the user was told). */
export function forget(intents: ArchiveIntents, messageIds: string[]): ArchiveIntents {
  const next = { ...intents };
  for (const id of messageIds) delete next[id];
  return next;
}

/** Drop old ones (and archives that waited too long for the server), and keep at most MAX_INTENTS (newest). */
export function prune(intents: ArchiveIntents, now: number): ArchiveIntents {
  const kept = Object.entries(intents).filter(([, i]) => now - i.at < KEEP_MS && !(i.pending && now - i.pending >= RETRY_FOR_MS)).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_INTENTS);
  return Object.fromEntries(kept);
}

/** Archived emails that are back in the folder they were archived from, and may be archived again. */
export function cameBack<T extends Mail>(intents: ArchiveIntents, mails: T[], now: number): T[] {
  const seen = new Set<string>();
  return mails.filter((m) => {
    const id = m.headerMessageId;
    const intent = id ? intents[id] : undefined;
    if (!id || !intent || seen.has(id)) return false;
    if (!intent.settled || intent.again >= MAX_AGAIN || now - intent.at >= KEEP_MS) return false;
    if (m.folder?.id !== intent.folderId) return false;
    seen.add(id);
    return true;
  });
}

/** Archiving them again: not confirmed until Thunderbird says so, and one more time used. */
export function again(intents: ArchiveIntents, messageIds: string[], now: number): ArchiveIntents {
  const next = { ...intents };
  for (const id of messageIds) if (next[id]) next[id] = { ...next[id], at: now, settled: false, again: next[id].again + 1 };
  return next;
}

/** The toast and log line for emails that couldn't be archived (and will be tried again while the server is down). */
export function failureText(count: number, total: number, reason: string, retrying = false): string {
  const what = count === 1 && total === 1 ? "this email" : count === total ? `${count} emails` : `${count} of ${total} emails`;
  const back = `${count === 1 ? "It's" : "They're"} back in the inbox`;
  return `Couldn't archive ${what}: ${reason}. ${back}${retrying ? ", and Ember will archive " + (count === 1 ? "it" : "them") + " when the server answers" : ""}.`;
}
