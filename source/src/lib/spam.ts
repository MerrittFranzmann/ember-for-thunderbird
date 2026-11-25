// Spam you teach Ember (2026-11-16). Clef keeps nothing between requests, so what you mark is kept here (storage
// `spamFeedback`) and goes with each new email's Clef request as examples. Three checks for new Inbox mail:
//   1. a sender you marked → Spam right away (spam-service.ts; no AI);
//   2. Thunderbird's own junk filter, trained by your marks (sparkJunk Experiment);
//   3. Clef's "spam" question (ai-sort.ts), with your examples: at ≥ 90% Ember moves it (only recent mail, never
//      from someone you've written to); at 70–90% the email shows "Looks like spam?" with Spam / Not spam.
// "Not spam" undoes all of it. Nothing is deleted. Pure; unit-tested in test/spam.test.ts.
import { emailOf } from "./format";
import type { MessageHeader } from "./types";

/** Ember moves an email to Spam by itself from this probability (Clef's spam answer). */
export const SPAM_MOVE = 0.9;
/** From this probability (below SPAM_MOVE) the email asks "Looks like spam?". */
export const SPAM_ASK = 0.7;
/** Only mail this recent is moved by itself (older mail that Clef sorts for the first time only asks). */
export const SPAM_MOVE_WITHIN_MS = 3 * 86400000;
const MAX_SPAM_EXAMPLES = 20;
const MAX_GOOD_EXAMPLES = 10;
const MAX_CLEARED = 300;
const SUBJECT_CHARS = 80;

export interface SpamExample { spam: boolean; domain: string; subject: string; at: number }
export interface SpamFeedback {
  /** Senders you marked (address → when): their new mail goes straight to Spam. */
  senders: Record<string, number>;
  /** Your recent marks, newest first, as Clef sees them: the sender's domain and the subject (no address, no text). */
  examples: SpamExample[];
  /** Message-IDs you said aren't spam (no "Looks like spam?" again, never moved by Clef). */
  cleared: string[];
}
export const emptyFeedback = (): SpamFeedback => ({ senders: {}, examples: [], cleared: [] });

/** A stored value as feedback (missing or damaged parts start empty). */
export function readFeedback(value: any): SpamFeedback {
  const f = emptyFeedback();
  if (value && typeof value.senders === "object" && value.senders) for (const [k, v] of Object.entries(value.senders)) if (k.includes("@") && Number.isFinite(Number(v))) f.senders[k.toLowerCase()] = Number(v);
  if (Array.isArray(value?.examples)) f.examples = value.examples.filter((e: any) => e && typeof e.subject === "string" && typeof e.domain === "string").map((e: any) => ({ spam: !!e.spam, domain: e.domain, subject: e.subject, at: Number(e.at) || 0 }));
  if (Array.isArray(value?.cleared)) f.cleared = value.cleared.filter((k: any) => typeof k === "string");
  return f;
}

export const domainOf = (author: string) => (emailOf(author).toLowerCase().split("@")[1] || "");
const keyOf = (m: Pick<MessageHeader, "headerMessageId">) => (m.headerMessageId || "").replace(/^<|>$/g, "");
const example = (m: Pick<MessageHeader, "author" | "subject">, spam: boolean, at: number): SpamExample => ({ spam, domain: domainOf(m.author), subject: (m.subject || "").replace(/\s+/g, " ").trim().slice(0, SUBJECT_CHARS), at });

/** Keeps the newest examples of each kind (one per subject and domain). */
function trimExamples(list: SpamExample[]): SpamExample[] {
  const seen = new Set<string>();
  const out: SpamExample[] = [];
  let spam = 0, good = 0;
  for (const e of [...list].sort((a, b) => b.at - a.at)) {
    const key = `${e.domain}\n${e.subject.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (e.spam ? spam++ >= MAX_SPAM_EXAMPLES : good++ >= MAX_GOOD_EXAMPLES) continue;
    out.push(e);
  }
  return out;
}

/** You marked these as spam: their senders' new mail goes to Spam, and they become examples for Clef. */
export function markedSpam(f: SpamFeedback, messages: Pick<MessageHeader, "author" | "subject" | "headerMessageId">[], me: Set<string>, now = Date.now()): SpamFeedback {
  const senders = { ...f.senders };
  const fresh: SpamExample[] = [];
  const keys = new Set(messages.map(keyOf));
  for (const m of messages) {
    const address = emailOf(m.author).toLowerCase();
    if (!address || me.has(address)) continue;
    senders[address] = now;
    fresh.push(example(m, true, now));
  }
  // An example of the same email said "not spam" before is replaced; its Message-ID is no longer cleared.
  const replaced = new Set(fresh.map((e) => `${e.domain}\n${e.subject.toLowerCase()}`));
  return { senders, examples: trimExamples([...fresh, ...f.examples.filter((e) => !replaced.has(`${e.domain}\n${e.subject.toLowerCase()}`))]), cleared: f.cleared.filter((k) => !keys.has(k)) };
}

/** You said these aren't spam: their senders are forgotten, they become counter-examples, and they're cleared. */
export function markedNotSpam(f: SpamFeedback, messages: Pick<MessageHeader, "author" | "subject" | "headerMessageId">[], now = Date.now()): SpamFeedback {
  const senders = { ...f.senders };
  for (const m of messages) delete senders[emailOf(m.author).toLowerCase()];
  const fresh = messages.map((m) => example(m, false, now));
  const replaced = new Set(fresh.map((e) => `${e.domain}\n${e.subject.toLowerCase()}`));
  const cleared = [...new Set([...messages.map(keyOf).filter(Boolean), ...f.cleared])].slice(0, MAX_CLEARED);
  return { senders, examples: trimExamples([...fresh, ...f.examples.filter((e) => !replaced.has(`${e.domain}\n${e.subject.toLowerCase()}`))]), cleared };
}

/** "Mark as spam" taken back (Undo): as if it hadn't happened. */
export function unmarkedSpam(f: SpamFeedback, messages: Pick<MessageHeader, "author" | "subject">[]): SpamFeedback {
  const senders = { ...f.senders };
  for (const m of messages) delete senders[emailOf(m.author).toLowerCase()];
  const gone = new Set(messages.map((m) => `${domainOf(m.author)}\n${(m.subject || "").replace(/\s+/g, " ").trim().slice(0, SUBJECT_CHARS).toLowerCase()}`));
  return { ...f, senders, examples: f.examples.filter((e) => !(e.spam && gone.has(`${e.domain}\n${e.subject.toLowerCase()}`))) };
}

/** A sender you marked as spam (exact address). */
export const isSpamSender = (f: SpamFeedback, author: string) => !!f.senders[emailOf(author).toLowerCase()];

const quote = (e: SpamExample) => `"${e.subject.replace(/"/g, "'")}" (from ${e.domain || "unknown"})`;
/** Clef's spam question: what spam is, plus your recent marks either way (subjects and sender domains only). */
export function spamQuestion(f: SpamFeedback) {
  const spam = f.examples.filter((e) => e.spam), good = f.examples.filter((e) => !e.spam);
  let instructions = "Is this email spam: unsolicited bulk mail, a scam, phishing, or fraud, rather than mail the recipient signed up for, expects, or would want to read?";
  if (spam.length) instructions += ` The recipient marked emails like these as spam: ${spam.map(quote).join("; ")}.`;
  if (good.length) instructions += ` The recipient said these are NOT spam: ${good.map(quote).join("; ")}.`;
  return { type: "noul", instructions };
}

/** What Ember does with Clef's spam answer for an Inbox email: move it, ask, or nothing. */
export function spamVerdict(probability: number | null | undefined, m: Pick<MessageHeader, "author" | "date" | "headerMessageId" | "flagged">, o: { me: Set<string>; written: Set<string>; feedback: SpamFeedback; now?: number }): "move" | "ask" | null {
  if (probability === null || probability === undefined || !(probability >= SPAM_ASK)) return null;
  const address = emailOf(m.author).toLowerCase();
  if (!address || o.me.has(address) || o.feedback.cleared.includes(keyOf(m))) return null;
  // Someone you've written to, or an email you pinned: never moved by itself, at most a question.
  const recent = (o.now ?? Date.now()) - +new Date(m.date) <= SPAM_MOVE_WITHIN_MS;
  if (probability >= SPAM_MOVE && recent && !o.written.has(address) && !m.flagged) return "move";
  return "ask";
}
