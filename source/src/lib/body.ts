// Message body helpers: pick the best part, build snippets, and prepare HTML for a
// locked-down iframe (sandbox without scripts, strict CSP, remote content
// blocked unless the user opts in).

import type { MessagePart } from "./types";
import { splitHtmlHistory } from "./quoted-history";
import { escapeHtml } from "./format";
import { perf } from "./perf-recorder";
import { darkStyleOf, type DarkStyle } from "./email-dark";
import { standardizeText, STANDARD_TEXT_CSS } from "./email-text";

export interface Bodies {
  html?: string;
  text?: string;
}

/** Walk the MIME tree and collect the first text/html and text/plain bodies (non-attachment). */
export function extractBodies(root: MessagePart | undefined): Bodies {
  const out: Bodies = {};
  const walk = (p: MessagePart | undefined) => {
    if (!p) return;
    const ct = (p.contentType || "").toLowerCase();
    const disp = (p.headers?.["content-disposition"]?.[0] || "").toLowerCase();
    const isAttachment = disp.startsWith("attachment") || !!p.name;
    if (ct === "message/rfc822" && p !== root) return; // forwarded message attachment
    if (!isAttachment && typeof p.body === "string") {
      if (ct.startsWith("text/html") && out.html === undefined) out.html = p.body;
      else if (ct.startsWith("text/plain") && out.text === undefined) out.text = p.body;
    }
    p.parts?.forEach(walk);
  };
  walk(root);
  return out;
}

export function htmlToText(html: string): string {
  try {
    // Template contents are inert: indexing must never activate remote resources.
    const template = document.createElement("template");
    template.innerHTML = html;
    const content = template.content;
    content.querySelectorAll("style,script,head,title,noscript,iframe,object,link,img,video,audio,source").forEach((e) => e.remove());
    content.querySelectorAll("br").forEach((e) => e.replaceWith("\n"));
    content.querySelectorAll("p,div,tr,li,h1,h2,h3,h4,blockquote").forEach((e) => e.append("\n"));
    return content.textContent || "";
  } catch {
    return html.replace(/<[^>]+>/g, " ");
  }
}

/** A one/two line preview: no quoted text, no signatures, collapsed whitespace. */
export function makeSnippet(b: Bodies, max = 220): string {
  let text = b.text ?? (b.html ? htmlToText(b.html) : "");
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^>/.test(line)) continue;
    if (/^(on .{4,120} wrote:|am .{4,120} schrieb .*:|-----original message-----)$/i.test(line)) break;
    if (line === "--" || line === "-- ") break;
    if (/^(view (it |this )?(online|in (your )?browser)|read (it )?online|unsubscribe|having trouble viewing)/i.test(line)) continue;
    if (/^https?:\/\/\S+$/.test(line)) continue;
    if (line) lines.push(line);
    if (lines.join(" ").length > max) break;
  }
  const s = lines.join(" ").replace(/\s+/g, " ").replace(/‌|­|͏/g, "").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

const URL_RE = /\b((?:https?:\/\/|mailto:|www\.)[^\s<>"']+[^\s<>"'.,;:!?)\]])/gi;

/** Plain text → safe HTML with clickable links and dimmed quote blocks. */
export function textToHtml(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let quoteDepth = 0;
  for (const line of lines) {
    const m = line.match(/^((?:>\s?)+)/);
    const depth = m ? (m[1].match(/>/g) || []).length : 0;
    while (quoteDepth < depth) {
      out.push("<blockquote>");
      quoteDepth++;
    }
    while (quoteDepth > depth) {
      out.push("</blockquote>");
      quoteDepth--;
    }
    const content = m ? line.slice(m[1].length) : line;
    out.push(linkify(escapeHtml(content)) + "\n");
  }
  while (quoteDepth-- > 0) out.push("</blockquote>");
  return out.join("");
}

export function linkify(escaped: string): string {
  return escaped.replace(URL_RE, (u) => {
    const href = u.startsWith("www.") ? "https://" + u : u;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${u}</a>`;
  });
}

export interface PreparedHtml {
  srcdoc: string;
  hasRemote: boolean;
  /** How the email should look in dark mode (see email-dark.ts). */
  darkStyle?: DarkStyle;
  hasQuotes?: boolean;
  /** No text and nothing to see (Outlook's meeting responses often have an empty HTML body). */
  empty?: boolean;
}

const REMOTE_RE = /^(https?:)?\/\//i;

/**
 * Sanitize email HTML for the reader iframe.
 * - removes scripts, event handlers, <base>, meta refresh, forms' actions, iframes/objects
 * - rewrites cid: references to data: URLs (inline images), or marks unresolved ones for HtmlFrame
 * - detects remote resources (img/srcset/background/CSS url()) so the UI can offer "Load images"
 * - wraps in a document with a strict CSP; remote images allowed only when `allowRemote`.
 */
export function prepareHtml(
  html: string,
  opts: { allowRemote: boolean; cid?: Map<string, string>; dark?: boolean; extraCss?: string; hideQuotes?: boolean; standardizeText?: boolean },
): PreparedHtml {
  const done = perf.span("spark.prepare-html", { kb: Math.round(html.length / 1024) });
  // Splitting history is a second full parse; only pay for it when quotes are hidden.
  const separated = opts.hideQuotes ? splitHtmlHistory(html) : undefined;
  const doc = new DOMParser().parseFromString(separated ? separated.current : html, "text/html");
  let hasRemote = false;
  const darkStyle = darkStyleOf(doc);

  doc.querySelectorAll("script,base,iframe,frame,frameset,object,embed,applet,link[rel=import],meta[http-equiv]").forEach((e) => {
    // Keep charset metas; drop refresh / CSP / anything else.
    e.remove();
  });
  doc.querySelectorAll("link").forEach((l) => {
    const href = l.getAttribute("href") || "";
    if (REMOTE_RE.test(href)) hasRemote = true;
    l.remove(); // external stylesheets are remote content; never load them
  });

  const all = doc.querySelectorAll("*");
  for (const el of Array.from(all)) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const val = attr.value;
      if (name.startsWith("on")) el.removeAttribute(attr.name);
      else if ((name === "href" || name === "xlink:href") && /^\s*(javascript|data|vbscript):/i.test(val))
        el.removeAttribute(attr.name);
      else if (name === "action" || name === "formaction") el.removeAttribute(attr.name);
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "a" || tag === "area") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
    for (const a of ["src", "background", "poster", "srcset"]) {
      const v = el.getAttribute(a);
      if (!v) continue;
      if (/^\s*cid:/i.test(v)) {
        const id = v.trim().slice(4).replace(/^<|>$/g, "");
        let decoded = id;
        try { decoded = decodeURIComponent(id); } catch { /* malformed received ID */ }
        const data = opts.cid?.get(id) || opts.cid?.get(decoded);
        if (data) el.setAttribute(a, data);
        else {
          // HtmlFrame fills these in on the live document once the part arrives.
          el.removeAttribute(a);
          if (a !== "srcset") el.setAttribute(`data-cid-${a}`, id);
        }
      } else if (REMOTE_RE.test(v.trim()) || (a === "srcset" && /https?:/i.test(v))) {
        hasRemote = true;
      }
    }
    const style = el.getAttribute("style");
    if (style && /url\(\s*['"]?\s*(https?:)?\/\//i.test(style)) hasRemote = true;
  }
  doc.querySelectorAll("style").forEach((s) => {
    if (/url\(\s*['"]?\s*(https?:)?\/\//i.test(s.textContent || "") || /@import/i.test(s.textContent || ""))
      hasRemote = true;
  });

  const imgSrc = opts.allowRemote ? "data: https: http:" : "data:";
  const csp =
    `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'` +
    (opts.allowRemote ? " https: http:" : "") +
    `; font-src data:${opts.allowRemote ? " https:" : ""}; media-src 'none'; form-action 'none'`;

  const headExtra =
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    // Light stays light; in dark mode the frame's colour scheme lets the email's own dark rules apply.
    `<meta name="color-scheme" content="light dark">` +
    `<base target="_blank">` +
    `<style>${BASE_EMAIL_CSS}${opts.extraCss || ""}</style>`;

  // Spark-style standard text: marked after sanitizing, enforced after the email's own styles.
  const standard = opts.standardizeText ? (standardizeText(doc), `<style>${STANDARD_TEXT_CSS}</style>`) : "";
  const head = (doc.head ? doc.head.innerHTML : "") + standard;
  const bodyAttrs = doc.body
    ? Array.from(doc.body.attributes)
        .map((a) => `${a.name}="${escapeHtml(a.value)}"`)
        .join(" ")
    : "";
  const body = doc.body ? doc.body.innerHTML : "";
  const empty = !doc.body || (!doc.body.textContent?.trim() && !doc.body.querySelector("img,svg,video,picture,canvas,hr,input,button"));
  const srcdoc = `<!doctype html><html><head><meta charset="utf-8">${headExtra}${head}</head><body ${bodyAttrs}>${body}</body></html>`;
  done();
  return {
    srcdoc, hasRemote, darkStyle, empty,
    get hasQuotes() { return !!(separated || splitHtmlHistory(html)).history; },
  };
}

// Ember's base email typography. It comes before the email's own styles, so it only fills in
// what the sender left unset (plain-looking mail gets Ember's look; designed mail keeps its own).
const BASE_EMAIL_CSS = `
html{background:#fff;color:#000;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;}
body{margin:0;padding:2px 0 6px;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Helvetica Neue",Helvetica,Arial,sans-serif;font-size:14px;line-height:1.57;color:#000;vertical-align:baseline;overflow-wrap:break-word;word-wrap:break-word;}
h1{font-size:24px;font-weight:600;}h2{font-size:16px;font-weight:600;}h3,h4,h5,h6{font-size:14px;font-weight:600;}
b,strong{font-weight:600;}
a{color:#007cff;text-decoration:underline;}a:hover{color:#0053cf;}
img{max-width:100%;height:auto;}
table{max-width:100%;}
pre{white-space:pre-wrap;}
blockquote[type=cite]{margin:8px 0;padding:8px 15px;border:1px solid rgba(0,8,30,.08);border-radius:5px;font-style:italic;line-height:22px;}
`;

/** Plain-text email rendered in the same frame pipeline (keeps one code path for reader layout). */
export function prepareText(text: string, dark: boolean): PreparedHtml {
  const fg = dark ? "#e8e8ed" : "#1d1d1f";
  const bg = dark ? "#1c1c1e" : "#ffffff";
  const quote = dark ? "#9a9aa2" : "#5b6270";
  const link = dark ? "#5aa9ff" : "#0a66d8";
  const css = `html{background:${bg};color:${fg};}body{margin:0;padding:4px 2px 8px;font:15px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;}a{color:${link};}blockquote{margin:6px 0;padding-left:12px;border-left:3px solid ${quote};color:${quote};white-space:pre-wrap;}`;
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src data:`;
  return {
    hasRemote: false,
    srcdoc: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="color-scheme" content="${dark ? "dark" : "light"}"><base target="_blank"><style>${css}</style></head><body>${textToHtml(text.replace(/\s+$/, ""))}</body></html>`,
  };
}

/** Strip an email HTML document down to its <body> content for quoting in replies. */
export function bodyInner(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,base,meta,link,iframe,object,embed,title").forEach((e) => e.remove());
  doc.querySelectorAll("*").forEach((el) => {
    for (const a of Array.from(el.attributes)) if (a.name.toLowerCase().startsWith("on")) el.removeAttribute(a.name);
  });
  return doc.body?.innerHTML || "";
}

/** Separate a trailing reply history while preserving inline responses. */
export function splitQuotedText(text: string): { text: string; quote: string } {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const marker = lines.findIndex((line) => /^(?:On .+wrote:|Am .+schrieb.*:|[-_]{3,}\s*(?:Original Message|Forwarded message)\s*[-_]*|Begin forwarded message:)\s*$/i.test(line.trim()));
  let start = marker;
  if (start < 0) {
    start = lines.findIndex((line) => /^\s*>/.test(line));
    // Non-quoted text after a quote is an inline reply: preserve the whole message.
    if (start >= 0 && lines.slice(start).some((line) => line.trim() && !/^\s*>/.test(line))) start = -1;
  }
  if (start <= 0 || !lines.slice(0, start).join("").trim()) return { text, quote: "" };
  return { text: lines.slice(0, start).join("\n").trimEnd(), quote: lines.slice(start).join("\n") };
}

export function splitMessageHistory(body: Bodies): { current: Bodies; history: Bodies; hasHistory: boolean } {
  const plain = body.text !== undefined ? splitQuotedText(body.text) : undefined;
  const rich = body.html ? perf.measure("spark.split-history", () => splitHtmlHistory(body.html!), { kb: Math.round(body.html.length / 1024) }) : undefined;
  return {
    current: { ...(plain ? { text: plain.text } : {}), ...(rich ? { html: rich.current } : {}) },
    history: { ...(plain?.quote ? { text: plain.quote } : {}), ...(rich?.history ? { html: rich.history } : {}) },
    hasHistory: !!(rich ? rich.history : plain?.quote),
  };
}
