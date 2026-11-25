import { extractBodies, htmlToText } from "./body";
import { isFileAttachment } from "./attachments";
import type { MessageAttachment, MessageHeader, MessagePart } from "./types";
import { involves } from "./meeting-brief";
export interface SearchFilters { sender?: string; after?: string; before?: string; unread?: boolean; hasAttachments?: boolean; accountId?: string;
  /** Only email from or to any of these addresses (lower-case; "Before your meeting"), trash left out. */
  people?: string[]; }
export interface SearchDocument { text: string; terms: string[]; hasAttachments: boolean; }
export interface SearchResult { messages: MessageHeader[]; indexed: number; cached: number; }
export const foldSearch = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
export const searchTerms = (value: string): string[] => [...new Set(foldSearch(value).match(/[\p{L}\p{N}]+/gu) || [])];
export function searchPhrases(query: string): string[] { return [...query.matchAll(/"([^"]+)"/g)].map((match) => foldSearch(match[1])); }
export function headerSearchText(message: MessageHeader): string { return foldSearch([message.subject, message.author, ...(message.recipients || []), ...(message.ccList || [])].join(" ")); }
export function searchDocument(message: MessageHeader, full: MessagePart, files: MessageAttachment[]): SearchDocument {
  const bodies = extractBodies(full);
  const text = foldSearch([headerSearchText(message), bodies.text ?? (bodies.html ? htmlToText(bodies.html) : ""), ...files.filter(isFileAttachment).map((file) => file.name)].join(" "));
  return { text, terms: searchTerms(text), hasAttachments: files.some(isFileAttachment) };
}
const peopleSets = new WeakMap<string[], Set<string>>();
/** One set per search (this runs for every saved header). */
function peopleSet(people: string[]): Set<string> {
  let set = peopleSets.get(people);
  if (!set) peopleSets.set(people, set = new Set(people.map((email) => email.toLowerCase())));
  return set;
}
export function matchesSearchHeader(message: MessageHeader, filters: SearchFilters): boolean {
  if (message.junk || message.folder?.specialUse?.includes("junk")) return false;
  if (filters.sender && !foldSearch(message.author).includes(foldSearch(filters.sender))) return false;
  if (filters.people?.length && (message.folder?.specialUse?.includes("trash") || !involves(message, peopleSet(filters.people)))) return false;
  if (filters.unread && message.read !== false) return false;
  if (filters.accountId && message.folder?.accountId !== filters.accountId) return false;
  const date = +new Date(message.date);
  if (filters.after) { const after = new Date(`${filters.after}T00:00:00`); if (Number.isFinite(+after) && date < +after) return false; }
  if (filters.before) { const before = new Date(`${filters.before}T00:00:00`); before.setDate(before.getDate() + 1); if (Number.isFinite(+before) && date >= +before) return false; }
  return true;
}
export function matchesSearchText(text: string, query: string): boolean {
  text = foldSearch(text);
  const tokens = searchTerms(text);
  return searchTerms(query).every((term) => tokens.some((token) => token.startsWith(term))) && searchPhrases(query).every((phrase) => text.includes(phrase));
}
