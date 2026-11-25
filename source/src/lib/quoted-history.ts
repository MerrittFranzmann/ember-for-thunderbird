import { htmlToText, type Bodies } from "./body";

/** Only email history markers, never an arbitrary editorial blockquote. */
export const HISTORY_SELECTOR = '.gmail_quote, .yahoo_quoted, blockquote[type="cite"], .moz-cite-prefix, #divRplyFwdMsg';

export function splitHtmlHistory(html: string): { current: string; history: string } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const nodes = Array.from(doc.querySelectorAll(HISTORY_SELECTOR)).filter((node) => !node.parentElement?.closest(HISTORY_SELECTOR));
  const history = doc.createElement("div");
  for (const node of nodes) {
    if (!doc.contains(node)) continue;
    history.append(node.cloneNode(true));
    if (node.id === "divRplyFwdMsg") {
      while (node.nextSibling) { history.append(node.nextSibling.cloneNode(true)); node.nextSibling.remove(); }
    }
    node.remove();
  }
  if (!history.childNodes.length) return { current: html, history: "" };
  // Quote-only messages must never turn into an empty card.
  const visible = doc.body.cloneNode(true) as HTMLElement;
  visible.querySelectorAll("script,style,noscript,title").forEach((node) => node.remove());
  if (!visible.textContent?.trim() && !visible.querySelector("img")) return { current: html, history: "" };
  return { current: doc.documentElement.outerHTML, history: history.innerHTML };
}

export function normalizeQuoteText(text: string): string {
  return text.normalize("NFKC").replace(/^\s*>+\s?/gm, "").replace(/[\u200b-\u200f\ufeff]/g, "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim().toLowerCase();
}

/** Require a substantial exact text passage; a shared greeting/signature is not a match. */
export function quotedOriginalIds(history: Bodies, originals: { id: number; body: Bodies }[]): number[] {
  const quote = normalizeQuoteText(history.text || (history.html ? htmlToText(history.html) : ""));
  if (!quote) return [];
  return originals.filter(({ body }) => {
    const text = normalizeQuoteText(body.text || (body.html ? htmlToText(body.html) : ""));
    return text.length >= 32 && text.split(/\s+/).length >= 6 && quote.includes(text);
  }).map(({ id }) => id);
}

export interface QuotedHistoryRequest {
  message: import("./types").MessageHeader;
  history: Bodies;
  cid: Map<string, string>;
  forcePanel?: boolean;
}
