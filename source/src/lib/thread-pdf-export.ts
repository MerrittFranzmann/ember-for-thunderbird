// Save the open conversation as PDF (Reader's button): load each email, lay the conversation out
// (thread-pdf.ts), print it with the sparkPrint Experiment, offer the Save dialog.
import { api } from "./api";
import { store } from "./store.svelte";
import { loadMessage } from "./message-data";
import { extractBodies, prepareHtml, splitMessageHistory } from "./body";
import { inlineImage } from "./inline-images";
import { isFileAttachment } from "./attachments";
import { saveFile } from "./attachment-actions";
import { buildThreadHtml, pdfName, type PrintBody, type PrintMessage } from "./thread-pdf";
import type { MessageHeader } from "./types";

const cidOf = (id: string) => id.replace(/^<|>$/g, "");

/** The sanitized email document's styles, body content and body colours, for its shadow root. */
function printBody(srcdoc: string): PrintBody {
  const doc = new DOMParser().parseFromString(srcdoc, "text/html");
  const styles = Array.from(doc.querySelectorAll("style"), (s) => s.textContent || "").join("\n");
  doc.querySelectorAll("style").forEach((s) => s.remove());
  const body = doc.body;
  const bodyStyle = [body.getAttribute("style") || "", body.getAttribute("bgcolor") ? `background-color:${body.getAttribute("bgcolor")}` : "", body.getAttribute("text") ? `color:${body.getAttribute("text")}` : ""].filter(Boolean).join(";");
  return { styles, html: body.innerHTML, bodyStyle, standardBody: body.hasAttribute("data-spark-text-body") };
}

async function printMessage(h: MessageHeader, allowRemote: boolean): Promise<PrintMessage> {
  const loaded = await loadMessage(api, h.id);
  const bodies = extractBodies(loaded.full);
  // Without the quoted history the reader also hides: each earlier email is in the PDF already.
  const current = splitMessageHistory(bodies).current;
  const html = current.html || bodies.html;
  let body: PrintMessage["body"];
  if (html) {
    const cid = new Map<string, string>();
    for (const a of loaded.atts) {
      if (!a.contentId || !html.includes(cidOf(a.contentId))) continue;
      try { cid.set(cidOf(a.contentId), await inlineImage(api, h, a)); } catch { /* the image is left out */ }
    }
    body = { html: printBody(prepareHtml(html, { allowRemote, cid, standardizeText: store.settings.standardizeEmailText }).srcdoc) };
  } else body = { text: current.text ?? bodies.text ?? "" };
  const attachments = loaded.atts.filter((a) => isFileAttachment(a) && !(a.contentId && html?.includes(cidOf(a.contentId)))).map((a) => ({ name: a.name || "attachment", size: a.size || 0 }));
  return { from: h.author, to: h.recipients || [], cc: h.ccList || [], date: h.date, attachments, body };
}

/** US Letter where it's the norm, else A4. */
const paper = () => (/^(en|es|fr)-(US|CA|MX|PH)$/i.test(navigator.language) ? "letter" : "a4");

/** Save these emails (oldest first) as one PDF; the Save dialog picks where. */
export async function saveConversationPdf(subject: string, headers: MessageHeader[]) {
  const allowRemote = store.settings.loadRemoteImages;
  const messages: PrintMessage[] = [];
  // Up to 6 emails load at once (one at a time took ~5 s for a 60-email thread); order is kept.
  let next = 0;
  const worker = async () => { while (next < headers.length) { const i = next++; messages[i] = await printMessage(headers[i], allowRemote); } };
  await Promise.all(Array.from({ length: Math.min(6, headers.length) }, worker));
  // The Experiment loads the document in a hidden browser without scripts and prints it.
  const bytes: Uint8Array<ArrayBuffer> = await api.sparkPrint.htmlToPDF(buildThreadHtml(subject, messages, allowRemote), { paper: paper() });
  await saveFile(new Blob([bytes], { type: "application/pdf" }), pdfName(subject));
}
