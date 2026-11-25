// Smart Inbox classification: People / Calendar / Updates ("notification") / Newsletters.
// Header heuristics only (no network, no ML). Pure and unit-tested.

import type { Category } from "./types";
import { parseAddr } from "./format";

export type Headers = Record<string, string[] | string | undefined>;

function h(headers: Headers | undefined, name: string): string {
  if (!headers) return "";
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v.join(", ");
  return v ? String(v) : "";
}

const AUTOMATED_LOCAL =
  /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|notify|alerts?|mailer[-_]?daemon|postmaster|bounces?|automated|auto|system|robot|bot|receipts?|billing|invoices?|orders?|shipping|security|account(s)?|accounts?-?update|updates?|service|calendar[-_.]?notification|support|help|feedback|info|team|hello)([-_.+].*)?$/i;

const NEWSLETTER_LOCAL = /^(news(letter)?s?|digest|weekly|daily|editor(s)?|crew|marketing|promo(tions)?|offers?|deals|subscriptions?)([-_.+].*)?$/i;

const NOTIFICATION_HEADERS = [
  "x-github-reason", "x-gitlab-project", "x-jira-fingerprint", "x-linkedin-class",
  "x-facebook-notify", "x-atlassian-mail-type", "x-zendesk-from-account-id",
];

/** Headers Exchange and Google put on meeting invitations, updates, cancellations and responses. */
const CALENDAR_HEADERS = ["x-google-calendar-content-type", "x-ms-exchange-calendar-series-instance-id", "x-ms-exchange-calendar-originator-id"];

/** Subjects Outlook, Google and Thunderbird give meeting mail ("Invitation: …", "Accepted: …", "Canceled: …"). */
export function calendarSubject(subject: string | undefined): boolean {
  return /^\s*((updated )?invitation( updated)?|new event|event (updated|canceled|cancelled)|accepted|declined|tentative(ly accepted)?|canceled( event)?|cancelled( event)?|updated event)( with note)?\s*:/i.test(subject || "");
}

const BULK_MAILER_HEADERS = [
  "x-campaign", "x-campaignid", "x-mailchimp-campaign", "x-mc-user", "x-newsletter",
  "x-sg-eid", "x-mailgun-tag", "x-cm-campaign", "x-substack-post", "x-beehiiv-id",
  "x-ems-proxy", "x-mailer-recptid", "x-emarsys-identify",
];

/**
 * Classify a message.
 * @param author  The From header ("Name <a@b>").
 * @param headers Lower-cased header dictionary (as returned by getFull/getHeaders), or undefined
 *                when only the address is known (fast first pass).
 * @param me      The user's own addresses (lower case) — mail from me is always "people".
 * @param subject Meeting mail is recognised by its subject too ("Invitation: …").
 */
export function classify(author: string, headers?: Headers, me?: Set<string>, subject?: string): Category {
  const from = parseAddr(author);
  const email = from.email.toLowerCase();
  if (me && me.has(email)) return "people";
  const local = email.split("@")[0] || "";

  if (headers && (CALENDAR_HEADERS.some((k) => h(headers, k)) || /calendarmessage/i.test(h(headers, "content-class")) || /text\/calendar/i.test(h(headers, "content-type")))) return "calendar";
  if (calendarSubject(subject)) return "calendar";

  if (headers) {
    const listId = h(headers, "list-id");
    const listUnsub = h(headers, "list-unsubscribe");
    const listPost = h(headers, "list-post");
    const precedence = h(headers, "precedence").toLowerCase();
    const autoSubmitted = h(headers, "auto-submitted").toLowerCase();
    const bulk = precedence.includes("bulk") || precedence.includes("junk");
    const isNotifHeader = NOTIFICATION_HEADERS.some((k) => h(headers, k));
    const isBulkMailer = BULK_MAILER_HEADERS.some((k) => h(headers, k));
    const feedbackId = h(headers, "feedback-id").toLowerCase();

    // Strong machine signals first (GitHub etc. also carry List-Id/List-Unsubscribe).
    if (isNotifHeader) return "notification";
    if (autoSubmitted && autoSubmitted !== "no") return "notification";

    // Discussion mailing lists (List-Post, human sender) stay with people.
    if (listPost && listId && !AUTOMATED_LOCAL.test(local) && !bulk) return "people";

    if (listUnsub && (listId || bulk || isBulkMailer || NEWSLETTER_LOCAL.test(local))) return "newsletter";
    if (isBulkMailer || (bulk && listUnsub)) return "newsletter";
    if (feedbackId.includes("campaign") || feedbackId.includes("newsletter")) return "newsletter";

    // List-Unsubscribe without being a newsletter = automated notification.
    if (listUnsub) return "notification";
    if (precedence.includes("list") || bulk) return "notification";
  }

  if (NEWSLETTER_LOCAL.test(local)) return "newsletter";
  if (AUTOMATED_LOCAL.test(local)) return "notification";
  return "people";
}

/** Address-only first pass (no headers fetched yet). Conservative. */
export function quickClassify(author: string, me?: Set<string>, subject?: string): Category {
  return classify(author, undefined, me, subject);
}
