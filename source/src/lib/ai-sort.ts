// AI sorting with Cloudflare's Clef decision model: People / Calendar / Updates / Newsletters from what an
// email says, not only who sent it, plus four signals in the same request: needs a reply, important, a receipt,
// a promotion. A receipt (or invoice, bill, expense) gets its own section, Receipts (store.categoryOf). Opt-in (Settings), with the user's own Cloudflare account. The background
// (AiSorter) asks once per Inbox email of the last 90 days and for new mail; answers are kept in storage
// (aiCategories) and the page uses one only when Clef is sure enough (aiCategory). The rules in
// classify.ts stay the instant first answer and the fallback. Pure helpers are unit-tested.
import type { Category, MessageHeader, MessagePart } from "./types";
import { extractBodies, htmlToText } from "./body";
import { emailOf } from "./format";
import { groupDef, groupQuestion, vocabularyKey, type InboxId } from "./inboxes";

/** Below this confidence the rules decide. */
export const AI_MIN_CONFIDENCE = 0.75;
/** A signal (needs reply, important…) shows from this probability. */
export const AI_SIGNAL = 0.7;
/** How much of the text Clef sees. */
export const AI_TEXT_CHARS = 600;
/** Clef's choices, and the section each is (Updates is "notification" in Ember). */
const CHOICES: Record<string, Category> = { people: "people", calendar: "calendar", updates: "notification", newsletter: "newsletter" };
export type AiSignal = "reply" | "important" | "receipt" | "promotion" | "spam";
const SIGNALS: AiSignal[] = ["reply", "important", "receipt", "promotion", "spam"];

/** One saved answer: [category, confidence %, when (minutes since 1970), then each signal's probability %
 *  (needs reply, important, receipt, promotion, spam; -1 when Clef didn't answer)]. Older 3-item answers (before
 *  Calendar and the signals) are asked again; 7-item ones (before spam, 0.1.120) are kept: spam is unknown. */
export type AiAnswer = [Category, number, number, ...number[]];
export const AI_ANSWER_LENGTH = 7;
export type AiAnswers = Record<string, AiAnswer>;

/** The key answers are saved under: the Message-ID without brackets. */
export const aiKey = (message: Pick<MessageHeader, "headerMessageId">) => (message.headerMessageId || "").replace(/^<|>$/g, "");

const header = (headers: Record<string, string[] | undefined> | undefined, name: string) => (headers?.[name] || headers?.[name.toLowerCase()] || []).join(", ");

/** Which inbox an email is in, for its group question (inboxes.ts), and what counts as important there. */
export interface InboxAsk { inbox: InboxId; important?: string }

/** What Clef is told about an email (the least that decides the question). With an inbox: also which of that
 *  inbox's groups it belongs in, and "important" as that inbox means it. */
export function clefRequest(message: MessageHeader, full: MessagePart | undefined, ask?: InboxAsk, spam?: { type: string; instructions: string }) {
  const headers = full?.headers as Record<string, string[] | undefined> | undefined;
  const bodies = full ? extractBodies(full) : {};
  const text = (bodies.text ?? (bodies.html ? htmlToText(bodies.html) : "")).replace(/\s+/g, " ").trim().slice(0, AI_TEXT_CHARS);
  const precedence = header(headers, "precedence").toLowerCase();
  return {
    state: {
      from: message.author,
      subject: message.subject,
      recipients: (message.recipients?.length || 0) + (message.ccList?.length || 0),
      mailing_list: !!header(headers, "list-id"),
      unsubscribe_link: !!header(headers, "list-unsubscribe"),
      automated: !!header(headers, "auto-submitted") && header(headers, "auto-submitted").toLowerCase() !== "no" || /bulk|junk|list/.test(precedence),
      text,
    },
    questions: {
      kind: {
        type: "choice",
        instructions: "Which inbox section does this email belong in?",
        criteria: {
          people: "Written by a person to the recipient or a small group: colleagues, friends, clients, replies and personal requests, even when sent from a company or shared address.",
          calendar: "About a meeting or event on a calendar: invitations, updates, cancellations, reschedules, and accept/decline replies.",
          updates: "Sent automatically by a system or service about the recipient's account or activity: receipts, orders, shipping, bills, sign-in codes, security notices, app and tool alerts.",
          newsletter: "Bulk content sent to a mailing list: newsletters, marketing, promotions, announcements and digests.",
        },
      },
      reply: { type: "noul", instructions: "Does this email ask the recipient to reply, answer a question, make a decision or do something?" },
      important: { type: "noul", instructions: "Is this email important or time-sensitive for the recipient personally (a deadline, a problem, a request from someone who matters), rather than routine?" + (ask?.important?.trim() ? ` In this inbox, important means: ${ask.important.trim()}` : "") },
      receipt: { type: "noul", instructions: "Is this a receipt, invoice, bill, expense report, or an order or payment confirmation?" },
      promotion: { type: "noul", instructions: "Is this marketing or a promotion trying to sell something, rather than content the recipient subscribed to read?" },
      ...(ask ? { group: groupQuestion(ask.inbox) } : {}),
      // Spam, with the user's own marks as examples (spam.ts spamQuestion).
      ...(spam ? { spam } : {}),
    },
  };
}

/** One saved group answer: [the inbox's vocabulary key, group id, confidence %]. */
export type AiGroupAnswer = [string, string, number];
export type AiGroups = Record<string, AiGroupAnswer>;

/** The group Clef chose for an email of this inbox, or null. */
export function clefGroup(body: any, inbox: InboxId): AiGroupAnswer | null {
  const group = (body?.result ?? body)?.answers?.group;
  const id = group?.choice;
  if (typeof id !== "string" || !groupDef(inbox, id)) return null;
  const confidence = unit(group.confidence ?? group.probabilities?.[id]);
  return confidence === null ? null : [vocabularyKey(inbox), id, Math.round(confidence * 100)];
}

/** Clef's group for an email when it's for this inbox's current groups and sure enough, else null. */
export function aiGroup(groups: AiGroups | undefined, message: Pick<MessageHeader, "headerMessageId">, inbox: InboxId): string | null {
  const answer = groups?.[aiKey(message)];
  return answer && answer[0] === vocabularyKey(inbox) && answer[2] >= AI_MIN_CONFIDENCE * 100 ? answer[1] : null;
}

/** Whether an email of this inbox has a group answer for its current groups (sure or not). */
export const hasGroupAnswer = (groups: AiGroups, message: Pick<MessageHeader, "headerMessageId">, inbox: InboxId) => groups[aiKey(message)]?.[0] === vocabularyKey(inbox);

const unit = (value: unknown) => { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null; };
/** The category, its confidence and the signals' probabilities from Cloudflare's answer, or null. */
export function clefAnswer(body: any): { cat: Category; confidence: number; signals: Record<AiSignal, number | null> } | null {
  const answers = (body?.result ?? body)?.answers;
  const kind = answers?.kind;
  const cat = CHOICES[kind?.choice];
  if (!cat) return null;
  const confidence = unit(kind.confidence ?? kind.probabilities?.[kind.choice]);
  if (confidence === null) return null;
  const signals = Object.fromEntries(SIGNALS.map((name) => { const a = answers[name]; return [name, unit(typeof a === "number" ? a : a?.noul ?? a?.probability ?? a?.value)]; })) as Record<AiSignal, number | null>;
  return { cat, confidence, signals };
}

/** The answer as saved. */
export function savedAnswer(answer: NonNullable<ReturnType<typeof clefAnswer>>, now = Date.now()): AiAnswer {
  const pct = (value: number | null) => (value === null ? -1 : Math.round(value * 100));
  return [answer.cat, pct(answer.confidence), Math.floor(now / 60000), pct(answer.signals.reply), pct(answer.signals.important), pct(answer.signals.receipt), pct(answer.signals.promotion), pct(answer.signals.spam)];
}

/** Whether Clef said a signal applies to an email (needs reply, important, receipt, promotion). */
export function aiSignal(answers: AiAnswers | undefined, message: Pick<MessageHeader, "headerMessageId">, signal: AiSignal): boolean {
  const answer = answers?.[aiKey(message)];
  return !!answer && answer.length >= AI_ANSWER_LENGTH && (answer[3 + SIGNALS.indexOf(signal)] as number) >= AI_SIGNAL * 100;
}

/** Clef's spam probability for an email (0–1), or null when it wasn't asked. */
export function aiSpam(answers: AiAnswers | undefined, message: Pick<MessageHeader, "headerMessageId">): number | null {
  const value = answers?.[aiKey(message)]?.[3 + SIGNALS.indexOf("spam")];
  return typeof value === "number" && value >= 0 ? value / 100 : null;
}

/** A readable reason for a refused request. */
export function clefError(status: number, body: any): string {
  const message = body?.errors?.[0]?.message || "";
  if (status === 401 || status === 403) return "Cloudflare didn't accept the API token. It needs the Workers AI permission for this account.";
  if (status === 404) return "Cloudflare doesn't know that account ID, or Clef isn't available to it.";
  if (status === 429) return "Cloudflare's daily or per-minute limit was reached; Ember will continue later.";
  return message ? `Cloudflare: ${message}` : `Cloudflare answered HTTP ${status}.`;
}

/** The AI's category for an email when it's sure enough, else null (the rules decide). */
export function aiCategory(answers: AiAnswers | undefined, message: Pick<MessageHeader, "headerMessageId">): Category | null {
  const answer = answers?.[aiKey(message)];
  return answer && answer[1] >= AI_MIN_CONFIDENCE * 100 ? answer[0] : null;
}

/** Inbox emails of the saved 90 days still without a (current) answer, newest first (not the user's own, not junk).
 *  `answered` also asks whether an email has its inbox's group answer (Work and Personal inboxes). */
export function unsorted(headers: MessageHeader[], answers: AiAnswers, me: Set<string>, answered: (m: MessageHeader) => boolean = () => true): MessageHeader[] {
  const seen = new Set<string>();
  return headers.filter((m) => {
    const key = aiKey(m);
    if (!key || ((answers[key]?.length ?? 0) >= AI_ANSWER_LENGTH && answered(m)) || seen.has(key) || m.junk || !m.folder?.specialUse?.includes("inbox") || me.has(emailOf(m.author))) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => +new Date(b.date) - +new Date(a.date));
}
