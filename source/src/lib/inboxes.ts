// Work and Personal inboxes: an email's inbox is its account's (Focus's work accounts are Work, every other
// account Personal), and each inbox sorts its mail into its own groups. A group is a name plus one sentence that
// Clef sorts by (ai-sort.ts); the rules here place mail Clef hasn't answered for, from the base category
// (classify.ts) and a few signals. No work accounts: one inbox with the base sections, as before.
// Pure, unit-tested (test/inboxes.test.ts); the background bundles it too (no page imports).
import type { Category, InboxId } from "./types";

export type { InboxId };
export const INBOX_IDS: InboxId[] = ["work", "personal"];
export const INBOX_LABEL: Record<InboxId, string> = { work: "Work", personal: "Personal" };

/** What kind of mail a group holds: its icon's fallback and which filters it offers (People: Needs reply /
 *  Important; Newsletters: Reading / Promotions). */
export type GroupKind = "people" | "calendar" | "updates" | "newsletter" | "receipt";
export interface GroupDef { id: string; label: string; icon: string; kind: GroupKind; description: string }

export const INBOX_GROUPS: Record<InboxId, GroupDef[]> = {
  work: [
    { id: "team", label: "Team", icon: "people", kind: "people", description: "Written personally by someone at the recipient's own organisation (the same email domain as the recipient): colleagues and teammates." },
    { id: "outside", label: "Outside", icon: "globe", kind: "people", description: "Written personally by someone outside the recipient's organisation: partners, donors, clients, vendors and other contacts." },
    { id: "calendar", label: "Calendar", icon: "calendar", kind: "calendar", description: "About a meeting or event on a calendar: invitations, updates, cancellations, reschedules, and accept/decline replies." },
    { id: "tools", label: "Tools", icon: "gear", kind: "updates", description: "Sent automatically by work software or a service: app and tool alerts, shared documents and comments, task and project updates, sign-in codes, system notices." },
    { id: "receipts", label: "Receipts", icon: "receipt", kind: "receipt", description: "A receipt, invoice, bill, expense report, or an order or payment confirmation." },
    { id: "announcements", label: "Announcements", icon: "news", kind: "newsletter", description: "Bulk mail sent to many people: organisation-wide announcements, newsletters, industry news, digests and marketing." },
  ],
  personal: [
    { id: "people", label: "People", icon: "people", kind: "people", description: "Written personally by a person to the recipient or a small group: friends, family, neighbours and anyone writing to them personally." },
    { id: "plans", label: "Plans", icon: "calendar", kind: "calendar", description: "About something the recipient is going to: events and invitations, tickets, reservations and bookings, travel itineraries, appointments." },
    { id: "purchases", label: "Purchases", icon: "receipt", kind: "receipt", description: "About something the recipient bought: order confirmations, receipts, shipping and delivery updates, returns and refunds." },
    { id: "accounts", label: "Money", icon: "card", kind: "updates", description: "From a bank, utility, government or service about the recipient's account: bills, statements, payments, sign-in codes, security notices, app and social media notifications." },
    { id: "newsletters", label: "Newsletters", icon: "news", kind: "newsletter", description: "Content the recipient subscribed to read: newsletters, digests, blogs, school, church and community updates." },
    { id: "promotions", label: "Promotions", icon: "tag", kind: "newsletter", description: "Marketing trying to sell something: sales, offers, deals and promotional emails from stores and brands." },
  ],
};

/** "What matters here" (Clef's important question, per inbox). */
export const DEFAULT_IMPORTANT: Record<InboxId, string> = {
  work: "Anything from leadership, a donor or partner, a deadline, or a problem that needs the recipient.",
  personal: "Family and close friends, bills or payments due, appointments, and anything time-sensitive.",
};

export interface InboxSettings {
  /** Accounts whose mail is work mail (Focus's list). */
  workAccounts: string[];
  /** Per inbox: group order, hidden groups, and names the user gave them. */
  inboxGroups: Partial<Record<InboxId, { order?: string[]; hidden?: string[]; labels?: Record<string, string> }>>;
  /** Per inbox: sender address → group ("Always put this sender in…"). */
  senderGroups: Partial<Record<InboxId, Record<string, string>>>;
  /** Per inbox: what counts as important there (Clef). */
  inboxImportant: Partial<Record<InboxId, string>>;
}
export const INBOX_DEFAULTS: Omit<InboxSettings, "workAccounts"> = { inboxGroups: {}, senderGroups: {}, inboxImportant: {} };

/** The inbox an account's mail is in; null when there are no work accounts (one inbox). */
export function inboxOf(accountId: string | undefined, workAccounts: string[]): InboxId | null {
  if (!workAccounts.length) return null;
  return accountId && workAccounts.includes(accountId) ? "work" : "personal";
}

export interface InboxGroup extends GroupDef { hidden: boolean }
/** An inbox's groups in the user's order, with their names; hidden ones flagged. */
export function groupsOf(inbox: InboxId, s: Pick<InboxSettings, "inboxGroups">): InboxGroup[] {
  const own = s.inboxGroups?.[inbox] || {};
  const order = own.order || [];
  const rank = (id: string) => { const i = order.indexOf(id); return i < 0 ? order.length + INBOX_GROUPS[inbox].findIndex((g) => g.id === id) : i; };
  return [...INBOX_GROUPS[inbox]].sort((a, b) => rank(a.id) - rank(b.id))
    .map((g) => ({ ...g, label: own.labels?.[g.id]?.trim() || g.label, hidden: !!own.hidden?.includes(g.id) }));
}
export const groupDef = (inbox: InboxId, id: string) => INBOX_GROUPS[inbox].find((g) => g.id === id);

const PURCHASE = /\b(your order|order (confirm|number|#|no\.)|ordered|has shipped|shipped|shipping|out for delivery|delivered|delivery|your package|tracking|receipt|purchase|refund|return label)\b/i;
const PLANS = /\b(reservation|booking|booked|tickets?|itinerary|check-in|boarding pass|appointment|rsvp|your (stay|trip|flight))\b/i;
const PROMO = /(\d+\s*% off|\bsale\b|\bdeals?\b|\bfree shipping\b|\blimited time\b|\bsave \$?\d+|\bcoupon\b|\bpromo code\b)/i;

export interface RuleContext {
  /** The base category (rules, or Clef's base answer). */
  base: Category;
  /** From someone at one of the user's work domains. */
  internal: boolean;
  /** Clef's promotion signal. */
  promotion: boolean;
  subject: string;
}
/** The group the rules give an email (when there's no sender rule or sure Clef answer). */
export function ruleGroup(inbox: InboxId, c: RuleContext): string {
  if (inbox === "work") {
    switch (c.base) {
      case "people": return c.internal ? "team" : "outside";
      case "calendar": return "calendar";
      case "receipt": return "receipts";
      case "newsletter": return "announcements";
      default: return "tools";
    }
  }
  switch (c.base) {
    case "people": return "people";
    case "calendar": return "plans";
    case "receipt": return "purchases";
    case "newsletter": return c.promotion || PROMO.test(c.subject) ? "promotions" : PURCHASE.test(c.subject) ? "purchases" : "newsletters";
    default: return PURCHASE.test(c.subject) ? "purchases" : PLANS.test(c.subject) ? "plans" : "accounts";
  }
}

/** Domains of the user's work addresses (not consumer mail services): mail from them is Team. */
const CONSUMER = /^(gmail|googlemail|outlook|hotmail|live|msn|icloud|me|mac|yahoo|aol|proton|protonmail|pm|gmx|zoho|fastmail)\./i;
export function workDomains(addresses: string[]): Set<string> {
  return new Set(addresses.map((a) => a.toLowerCase().split("@")[1] || "").filter((d) => d && !CONSUMER.test(d)));
}

/** Clef's question for an inbox's groups (every group, hidden too, so hiding one doesn't re-sort). */
export function groupQuestion(inbox: InboxId) {
  return {
    type: "choice" as const,
    instructions: `Which group of the recipient's ${INBOX_LABEL[inbox].toLowerCase()} inbox does this email belong in?`,
    criteria: Object.fromEntries(INBOX_GROUPS[inbox].map((g) => [g.id, g.description])),
  };
}

/** Changes when an inbox's groups (ids or descriptions) do: answers for another vocabulary are asked again. */
export function vocabularyKey(inbox: InboxId): string {
  let hash = 5381;
  for (const ch of inbox + JSON.stringify(groupQuestion(inbox).criteria)) hash = (hash * 33 + ch.charCodeAt(0)) >>> 0;
  return `${inbox[0]}${hash.toString(36)}`;
}
