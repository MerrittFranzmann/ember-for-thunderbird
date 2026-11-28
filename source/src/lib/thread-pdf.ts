// A conversation as one PDF, laid out like Spark's reader: a header with the subject and who took
// part, then each email (oldest first) as a card with its sender's avatar, recipients, date and
// attachments, and its text with Ember's reformatting (standard typography, quoted history dropped).
// Each email's HTML sits in its own shadow root, so one sender's styles can't restyle another's, and it
// flows across pages (iframes would be cut at the page edge). The sparkPrint Experiment prints the
// document to PDF. The string builders are unit-tested (test/thread-pdf.test.ts).
import { avatarColor, escapeHtml, initials, parseAddr } from "./format";

export interface PrintBody {
  styles: string;
  html: string;
  bodyStyle: string;
  /** Ember's standard typography applies to the whole email (body[data-spark-text-body]). */
  standardBody?: boolean;
}
export interface PrintMessage {
  from: string;
  to: string[];
  cc: string[];
  date: string | number | Date;
  attachments: { name: string; size: number }[];
  /** Sanitized email HTML (prepareHtml), or plain text. */
  body: { html: PrintBody } | { text: string };
}

/** An email's CSS for its shadow root: rules for html/body apply to the email's wrapper instead. */
export function scopeEmailCss(css: string): string {
  return css.replace(/(^|[\s,{}>+~(])(html|body)(?=[\s,{.#:[>+~)]|$)/gi, "$1.mail-body");
}

const FONT = `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif`;

const PRINT_CSS = `
html{background:#fff;color:#1c1c1f;-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font:10.5pt/1.5 ${FONT}}
.doc-head{display:flex;flex-direction:column;gap:6pt;padding:0 0 14pt;margin:0 0 14pt;border-bottom:1pt solid #e3e5ea}
.brand{display:flex;align-items:center;gap:5pt;font-size:8pt;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#0a66e8}
.brand i{display:inline-block;width:7pt;height:7pt;border-radius:2pt;background:#0a66e8;transform:rotate(45deg)}
.doc-head h1{margin:0;font-size:19pt;line-height:1.2;font-weight:700;letter-spacing:-.01em}
.doc-meta{color:#5f6168;font-size:9pt}
.people{display:flex;flex-wrap:wrap;gap:4pt 10pt;margin-top:2pt}
.person{display:flex;align-items:center;gap:4pt;font-size:9pt;color:#3d3f45}
.dot{display:inline-grid;place-items:center;width:15pt;height:15pt;border-radius:50%;color:#fff;font-size:6.5pt;font-weight:700;flex:none}
.msg{border:1pt solid #e3e5ea;border-radius:9pt;padding:11pt 13pt 12pt;margin:0 0 10pt;break-inside:avoid;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.msg-head{display:flex;gap:9pt;align-items:flex-start;break-inside:avoid;break-after:avoid;margin-bottom:9pt}
.avatar{display:inline-grid;place-items:center;width:24pt;height:24pt;border-radius:50%;color:#fff;font-size:9pt;font-weight:700;flex:none}
.who{flex:1;min-width:0;display:flex;flex-direction:column;gap:1pt}
.who b{font-size:10.5pt;font-weight:650}
.who b span{font-weight:400;color:#6e7079;font-size:9pt;margin-left:4pt}
.who .to{font-size:8.5pt;color:#6e7079}
.when{font-size:8.5pt;color:#6e7079;white-space:nowrap}
.files{display:flex;flex-wrap:wrap;gap:4pt;margin-top:9pt}
.file{display:inline-flex;align-items:center;gap:4pt;padding:2pt 7pt;border-radius:99pt;background:#f1f3f6;font-size:8.5pt;color:#3d3f45}
.file svg{width:8pt;height:8pt}
.plain{white-space:pre-wrap;overflow-wrap:anywhere;font-size:10.5pt;line-height:1.55}
.foot{margin-top:14pt;font-size:8pt;color:#9a9ca3;text-align:center}
a{color:#0a5fd6}
img{max-width:100%;height:auto}
`;

/** Ember's email typography inside each email (the reader's base), before the email's own styles. */
const BASE_MAIL_CSS = `.mail-body{color:#1c1c1f;font:10.5pt/1.55 ${FONT};overflow-wrap:break-word}
img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}
a{color:#0a5fd6}
blockquote[type=cite]{margin:6pt 0;padding:2pt 10pt;border-left:2pt solid #d6d9df;color:#5f6168}`;

const CLIP = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/></svg>`;

function sizeText(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function when(date: PrintMessage["date"]): string {
  return new Date(date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function nameOf(address: string): string {
  const a = parseAddr(address);
  return a.name || a.email || address;
}

function avatar(address: string, cls: string): string {
  const a = parseAddr(address);
  return `<span class="${cls}" style="background:${avatarColor(a.email || a.name || "?")}">${escapeHtml(initials(a))}</span>`;
}

/** The print document for a conversation. Remote images load only with `allowRemote` (the CSP). */
/** An email's CSS placed inside <style>: "</" can't end the element early (an SVG style's text may hold
 *  "</style></template>…" and reach the rest of the PDF). In CSS "<\/" means the same. */
function cssText(css: string): string { return css.replace(/<\//g, "<\\/"); }

export function buildThreadHtml(subject: string, messages: PrintMessage[], allowRemote: boolean, exportedAt: Date = new Date()): string {
  const csp = `default-src 'none'; img-src data: blob:${allowRemote ? " https: http:" : ""}; style-src 'unsafe-inline'${allowRemote ? " https:" : ""}; font-src data:${allowRemote ? " https:" : ""}`;
  const people = new Map<string, string>();
  for (const m of messages) { const a = parseAddr(m.from); const key = (a.email || a.name || m.from).toLowerCase(); if (!people.has(key)) people.set(key, m.from); }
  const first = messages[0], last = messages[messages.length - 1];
  const span = first && last ? (messages.length > 1 ? `${when(first.date)} – ${when(last.date)}` : when(first.date)) : "";
  const meta = [`${messages.length} ${messages.length === 1 ? "message" : "messages"}`, span].filter(Boolean).join(" · ");
  const shown = Array.from(people.values()).slice(0, 8);
  const peopleHtml = shown.map((p) => `<span class="person">${avatar(p, "dot")}${escapeHtml(nameOf(p))}</span>`).join("") + (people.size > shown.length ? `<span class="person">and ${people.size - shown.length} more</span>` : "");
  const articles = messages.map((m) => {
    const sender = parseAddr(m.from);
    const recipients = [m.to.length ? `to ${m.to.map(nameOf).join(", ")}` : "", m.cc.length ? `cc ${m.cc.map(nameOf).join(", ")}` : ""].filter(Boolean).join(" · ");
    const head = `<div class="msg-head">${avatar(m.from, "avatar")}<div class="who"><b>${escapeHtml(sender.name || sender.email || m.from)}${sender.name && sender.email ? `<span>${escapeHtml(sender.email)}</span>` : ""}</b>${recipients ? `<span class="to">${escapeHtml(recipients)}</span>` : ""}</div><span class="when">${escapeHtml(when(m.date))}</span></div>`;
    const body = "html" in m.body
      ? `<div class="mail"><template shadowrootmode="open"><style>${BASE_MAIL_CSS}</style><style>${cssText(scopeEmailCss(m.body.html.styles))}</style><div class="mail-body"${m.body.html.standardBody ? " data-spark-text-body" : ""} style="${escapeHtml(m.body.html.bodyStyle)}">${m.body.html.html}</div></template></div>`
      : `<div class="plain">${escapeHtml(m.body.text.replace(/\s+$/, ""))}</div>`;
    const files = m.attachments.length
      ? `<div class="files">${m.attachments.map((a) => `<span class="file">${CLIP}${escapeHtml(a.name)}${sizeText(a.size) ? ` · ${sizeText(a.size)}` : ""}</span>`).join("")}</div>`
      : "";
    return `<article class="msg">${head}${body}${files}</article>`;
  }).join("");
  const exported = exportedAt.toLocaleDateString(undefined, { dateStyle: "long" });
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${escapeHtml(subject)}</title><style>${PRINT_CSS}</style></head>` +
    `<body><header class="doc-head"><span class="brand"><i></i>Ember</span><h1>${escapeHtml(subject || "(no subject)")}</h1><span class="doc-meta">${escapeHtml(meta)}</span><div class="people">${peopleHtml}</div></header>${articles}` +
    `<p class="foot">Saved from Ember for Thunderbird on ${escapeHtml(exported)}</p></body></html>`;
}

/** A file name for the PDF: the subject without Re:/Fwd: prefixes. */
export function pdfName(subject: string): string {
  const base = subject.replace(/^(\s*(re|fwd?|aw|wg)\s*:\s*)+/i, "").trim() || "Conversation";
  return `${base.slice(0, 120)}.pdf`;
}
