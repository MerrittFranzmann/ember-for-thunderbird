// In-app composer state + send/save through Thunderbird.
//
// Sending strategy (documented in README):
//  * New messages on TB 153+  -> messages.sendMessage(details): fully in the
//    background, no compose window at all.
//  * Replies / forwards (any TB), and new messages on TB < 153 ->
//    compose.beginReply/beginForward/beginNew(details) so Thunderbird builds the
//    threading headers (In-Reply-To/References) and forward attachments, then
//    compose.sendMessage(tabId). Thunderbird must open its compose window for
//    this; the API has no hidden mode, so we minimize it immediately
//    (windows.update state "minimized") when "Hide compose window" is on.
//  * Drafts: messages.saveMessage on TB 153+ for new mail, otherwise
//    compose.saveMessage + tabs.remove.

import { api, env, mailCache } from "./api";
import { sendSettings } from "./send-settings.svelte";
import { store } from "./store.svelte";
import { perf } from "./perf-recorder";
import { isFileAttachment } from "./attachments";
import { bodyInner, extractBodies, textToHtml } from "./body";
import { displayName, emailOf, escapeHtml, parseAddr, splitAddrs, type Addr } from "./format";
import type { MailIdentity, MessageHeader, MessageId, MessagePart } from "./types";
import { followUpFor } from "./follow-ups";
import { accessOf, sharedLinks } from "./shared-links";
import { correspondence, sendWarnings, warningSignature, type Correspondence, type SendWarning } from "./send-checks";
import { closeComposeTab, openComposeTab, sendThreaded, windowFree } from "./delivery";
import { attachmentWarnings, type ThreadFile } from "./attachment-promises";
import { OutboxStore } from "./outbox-store";
import { queueId, sendTimeText, type QueuedEmail } from "./outbox";

export type ComposeMode = "new" | "reply" | "replyAll" | "forward" | "draft";

export interface Draft {
  mode: ComposeMode;
  relatedId?: MessageId;
  identityId: string;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  showCc: boolean;
  subject: string;
  /** Initial editor HTML (user part + signature). The editor owns it after open. */
  html: string;
  /** Quoted original (reply/forward), appended on send. */
  quoteHtml: string;
  files: File[];
  /** Which signature this email has: Thunderbird's for the From address, none, or a saved one's id. */
  signature: "default" | "none" | string;
  /** Remind me if no reply in this many days (0: no reminder). */
  followUp: number;
  /** Files of the forwarded email: Thunderbird's forward attaches them; shown so it's clear they go along. */
  forwarded?: { name: string; size: number }[];
  /** Replies: everyone in the conversation being answered (for "wasn't in this conversation"). */
  thread?: string[];
  /** A draft that is a reply (has In-Reply-To): it is sent and saved through Thunderbird's composer, which keeps
   *  its threading headers (sending it as new mail would drop them). */
  threaded?: boolean;
  /** Back from the outbox (Undo, Edit): closing it asks first, and its signature block stays as written. */
  restored?: boolean;
  keepSignature?: boolean;
}

/** Settles with `fallback` if `work` takes longer than `ms`. */
function within<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => { const timer = setTimeout(() => resolve(fallback), ms); work.then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(fallback); }); });
}

/** Thunderbird's signature for an address, as HTML (without the "-- " line). */
function identitySignature(idn: MailIdentity | undefined): string {
  if (!idn?.signature) return "";
  return idn.signatureIsPlainText ? escapeHtml(idn.signature).replace(/\n/g, "<br>") : idn.signature;
}

/** The editor's signature block. Names in a signature are not misspellings. */
export function wrapSignature(inner: string): string {
  return inner ? `<div class="moz-signature" spellcheck="false">-- <br>${inner}</div>` : "";
}

/** A signature block's content without its "-- " separator line. */
export function signatureContent(blockHtml: string): string {
  return blockHtml.replace(/^\s*--\s*(&nbsp;)?\s*<br\s*\/?>/i, "").trim();
}

export function fmtAddr(a: Addr): string {
  if (!a.name) return a.email;
  const n = /[",;<>@()]/.test(a.name) ? `"${a.name.replace(/"/g, '\\"')}"` : a.name;
  return `${n} <${a.email}>`;
}

class Composer {
  /** Something to put in the new draft once it's open ("availability": the user's free times). */
  afterOpen: "availability" | null = null;
  open = $state(false);
  draft = $state<Draft | null>(null);
  busy = $state<"" | "sending" | "saving">("");
  error = $state<string | null>(null);
  /** Bumped to ask the editor to replace its signature block. */
  sigRev = $state(0);
  /** "Before you send" (send-checks.ts): shown instead of sending until the user sends anyway or fixes them. */
  review = $state<SendWarning[] | null>(null);
  checking = $state(false);
  /** Bumped by "Attach a file" in "Before you send": the composer opens its file picker. */
  pickFiles = $state(0);
  /** The warnings the user already chose to send anyway. */
  private accepted = "";
  private known: Correspondence | null = null;
  /** Domains Thunderbird's search found in older mail (beyond the saved 90 days), by domain. */
  private olderDomains = new Map<string, Promise<boolean>>();
  /** Emails waiting in Ember's outbox (Undo send, Send later), soonest first. */
  outbox = $state.raw<QueuedEmail[]>([]);
  private outboxStore = new OutboxStore(api);
  /** The Send later time chosen while "Before you send" is open. */
  pendingAt = $state<number | undefined>(undefined);
  /** The live editor HTML is read through this getter, set by the Composer component. */
  getEditorHtml: () => string = () => this.draft?.html || "";

  identities() {
    return store.identities;
  }

  identity(id?: string): MailIdentity | undefined {
    return store.identities.find((i) => i.id === (id ?? this.draft?.identityId));
  }

  defaultIdentityFor(h?: MessageHeader): MailIdentity | undefined {
    const ids = store.identities;
    if (!ids.length) return undefined;
    if (h) {
      const addrs = [...(h.recipients || []), ...(h.ccList || []), ...(h.bccList || []), h.author].map(emailOf);
      const hit = ids.find((i) => addrs.includes((i.email || "").toLowerCase()));
      if (hit) return hit;
      const acct = h.folder?.accountId;
      const byAcct = ids.find((i) => i.accountId === acct);
      if (byAcct) return byAcct;
    }
    return ids[0];
  }

  /** The signature block for a choice: Thunderbird's for the From address, a saved one, or none. */
  signatureFor(identityId: string, choice: Draft["signature"] = "default") {
    if (choice === "none") return "";
    if (choice === "default") return wrapSignature(identitySignature(this.identity(identityId)));
    const saved = store.settings.signatures.find((s) => s.id === choice);
    return saved ? wrapSignature(saved.html) : wrapSignature(identitySignature(this.identity(identityId)));
  }

  /** Whether the From address has a signature in Thunderbird. */
  hasIdentitySignature(identityId?: string) {
    return !!identitySignature(this.identity(identityId));
  }

  /** Use another signature in this email (replaces the signature block, keeps the rest). */
  chooseSignature(choice: Draft["signature"]) {
    if (!this.draft) return;
    this.draft.signature = choice;
    this.sigRev++;
  }

  async saveSignature(name: string, html: string): Promise<string> {
    const id = `sig-${Date.now().toString(36)}`;
    await store.setSetting("signatures", [...store.settings.signatures, { id, name: name.trim() || "Signature", html }]);
    if (this.draft) this.draft.signature = id;
    return id;
  }

  async updateSignature(id: string, html: string) {
    await store.setSetting("signatures", store.settings.signatures.map((s) => (s.id === id ? { ...s, html } : s)));
  }

  private start(d: Omit<Draft, "html" | "signature" | "followUp"> & { html?: string }) {
    const sig = this.signatureFor(d.identityId);
    this.draft = { ...d, signature: "default", followUp: 0, html: d.html ?? `<div><br></div>${sig ? `<div><br></div>${sig}` : ""}` } as Draft;
    this.error = null;
    this.review = null;
    this.accepted = "";
    this.known = null;
    this.busy = "";
    this.open = true;
  }

  openNew(to: Addr[] = []) {
    perf.record("composer.open", { kind: "new" });
    const idn = this.defaultIdentityFor();
    this.start({ mode: "new", identityId: idn?.id || "", to, cc: [], bcc: [], showCc: false, subject: "", quoteHtml: "", files: [] });
  }

  private async original(id: MessageId): Promise<{ h: MessageHeader; full: MessagePart }> {
    const [h, full] = await Promise.all([api.messages.get(id), api.messages.getFull(id)]);
    return { h, full };
  }

  private quote(h: MessageHeader, full: MessagePart, forward: boolean): string {
    const b = extractBodies(full);
    const inner = b.html !== undefined ? bodyInner(b.html) : textToHtml(b.text || "").replace(/\n/g, "<br>");
    if (forward) {
      const rows = [
        ["From", h.author],
        ["Date", new Date(h.date).toLocaleString()],
        ["Subject", h.subject],
        ["To", (h.recipients || []).join(", ")],
      ]
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${escapeHtml(String(v))}<br>`)
        .join("");
      return `<div class="moz-forward-container"><br>-------- Forwarded Message --------<br>${rows}<br>${inner}</div>`;
    }
    const who = escapeHtml(displayName(h.author));
    const when = new Date(h.date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    return `<div class="moz-cite-prefix">On ${escapeHtml(when)}, ${who} wrote:<br></div><blockquote type="cite">${inner}</blockquote>`;
  }

  async openReply(id: MessageId, all: boolean, insert: "availability" | null = null) {
    perf.record("composer.open", { kind: all ? "reply-all" : "reply" });
    this.afterOpen = insert;
    try {
      const { h, full } = await this.original(id);
      const headers: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(full.headers || {})) headers[k.toLowerCase()] = v as string[];
      const idn = this.defaultIdentityFor(h);
      const me = store.me;
      const fromMe = me.has(emailOf(h.author));
      const replyTo = splitAddrs(headers["reply-to"]?.[0]);
      let to: Addr[] = fromMe ? (h.recipients || []).map(parseAddr) : replyTo.length ? replyTo : [parseAddr(h.author)];
      let cc: Addr[] = [];
      if (all) {
        const extraTo = fromMe ? [] : (h.recipients || []).map(parseAddr);
        to = [...to, ...extraTo];
        cc = (h.ccList || []).map(parseAddr);
      }
      const seen = new Set<string>();
      const dedupe = (xs: Addr[]) =>
        xs.filter((a) => {
          const e = a.email.toLowerCase();
          if (!e || seen.has(e) || (me.has(e) && !fromMe)) return false;
          seen.add(e);
          return true;
        });
      to = dedupe(to);
      cc = dedupe(cc);
      const subject = /^\s*re\s*:/i.test(h.subject) ? h.subject : `Re: ${h.subject}`;
      const thread = new Set(store.threadPeople(id));
      for (const raw of [h.author, ...(h.recipients || []), ...(h.ccList || []), ...(h.bccList || []), ...(headers["reply-to"] || [])]) for (const addr of splitAddrs(raw)) if (addr.email) thread.add(addr.email.toLowerCase());
      this.start({
        mode: all ? "replyAll" : "reply",
        thread: [...thread],
        relatedId: id,
        identityId: idn?.id || "",
        to,
        cc,
        bcc: [],
        showCc: cc.length > 0,
        subject,
        quoteHtml: this.quote(h, full, false),
        files: [],
      });
    } catch (e: any) {
      store.toast({ text: `Couldn't open reply: ${e?.message || e}`, kind: "error" });
    }
  }

  async openForward(id: MessageId) {
    perf.record("composer.open", { kind: "forward" });
    try {
      const { h, full } = await this.original(id);
      const idn = this.defaultIdentityFor(h);
      const subject = /^\s*fwd?\s*:/i.test(h.subject) ? h.subject : `Fwd: ${h.subject}`;
      this.start({
        mode: "forward",
        relatedId: id,
        identityId: idn?.id || "",
        to: [],
        cc: [],
        bcc: [],
        showCc: false,
        subject,
        quoteHtml: this.quote(h, full, true),
        files: [],
      });
      // From the local cache, so this doesn't delay opening.
      const files = await api.messages.listAttachments(id).catch(() => []);
      const forwarded = (files || []).filter(isFileAttachment).map((f: any) => ({ name: f.name || "attachment", size: f.size || 0 }));
      if (forwarded.length && this.draft?.mode === "forward" && this.draft.relatedId === id) this.draft.forwarded = forwarded;
    } catch (e: any) {
      store.toast({ text: `Couldn't open forward: ${e?.message || e}`, kind: "error" });
    }
  }

  /** An agent's reply (plain text) as the reply's HTML: one block per paragraph, line breaks kept. */
  static agentHtml(text: string): string {
    return String(text).replace(/\r\n/g, "\n").trim().split(/\n{2,}/).map((para) => `<div>${escapeHtml(para).replace(/\n/g, "<br>")}</div>`).join("<div><br></div>");
  }

  /** Save a reply to an email as a draft (never sent): Thunderbird's own reply, so it is threaded and addressed
   *  like one, from the matching identity with its signature, quoting the original. For agents (MCP), so it
   *  doesn't touch the in-app composer. Returns the draft's header. One at a time (each opens a compose window,
   *  minimized when Settings say so). */
  private draftQueue: Promise<unknown> = Promise.resolve();
  saveReplyDraft(id: MessageId, text: string, all = false): Promise<MessageHeader | null> {
    const run = async () => {
      const started = Date.now();
      const { h, full } = await this.original(id);
      const idn = this.defaultIdentityFor(h);
      const signature = this.signatureFor(idn?.id || "");
      const body = `<!DOCTYPE html><html><head><meta http-equiv="content-type" content="text/html; charset=UTF-8"></head><body>` +
        Composer.agentHtml(text) + (signature ? `<div><br></div>${signature}` : "") + `<br>${this.quote(h, full, false)}</body></html>`;
      const tab = await api.compose.beginReply(id, all ? "replyToAll" : "replyToSender", { body, isPlainText: false, ...(idn?.id ? { identityId: idn.id } : {}) });
      try {
        if (store.settings.minimizeCompose && tab?.windowId) await api.windows.update(tab.windowId, { state: "minimized" }).catch(() => {});
        const saved = await api.compose.saveMessage(tab.id, { mode: "draft" });
        // With Drafts on the server (IMAP, Exchange) Thunderbird may not hand back the saved copy: find it there.
        return (saved?.messages?.[0] as MessageHeader | undefined) ?? await this.findSavedDraft(h, idn?.accountId, started);
      } finally { await this.closeComposeTab(tab); }
    };
    const next = this.draftQueue.then(run, run);
    this.draftQueue = next.catch(() => {});
    return next;
  }

  /** The reply draft just saved for an email: newest in the account's Drafts with its subject, looked for over
   *  about ten seconds (a server copy takes a moment to appear). Null when it doesn't show up. */
  private async findSavedDraft(original: MessageHeader, accountId: string | undefined, since: number): Promise<MessageHeader | null> {
    const folders = store.foldersForRole("drafts", accountId);
    const subject = original.subject.replace(/^\s*((re|aw|sv)\s*:\s*)+/i, "").trim();
    for (let attempt = 0; attempt < 10; attempt++) {
      for (const folder of folders) {
        const page = await api.messages.query({ folderId: folder.id, fromDate: new Date(since - 120000) }).catch(() => null);
        const match = (page?.messages || []).filter((m: MessageHeader) => m.subject.replace(/^\s*((re|aw|sv)\s*:\s*)+/i, "").trim() === subject)
          .sort((a: MessageHeader, b: MessageHeader) => +new Date(b.date) - +new Date(a.date))[0];
        if (match) return match;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return null;
  }

  /** Open an existing draft (Drafts folder) in the in-app composer. */
  async openDraft(id: MessageId) {
    perf.record("composer.open", { kind: "draft" });
    try {
      const { h, full } = await this.original(id);
      const b = extractBodies(full);
      const html = b.html !== undefined ? bodyInner(b.html) : textToHtml(b.text || "").replace(/\n/g, "<br>");
      const header = (name: string) => (full.headers?.[name] || full.headers?.[name.toLowerCase()] || [])[0] || "";
      this.start({
        mode: "draft",
        relatedId: id,
        threaded: !!header("in-reply-to"),
        identityId: this.defaultIdentityFor(h)?.id || "",
        to: (h.recipients || []).map(parseAddr),
        cc: (h.ccList || []).map(parseAddr),
        bcc: (h.bccList || []).map(parseAddr),
        showCc: !!(h.ccList?.length || h.bccList?.length),
        // Thunderbird's header list drops "Re:" from subjects; the draft's own Subject keeps it.
        subject: header("subject") || h.subject,
        html,
        quoteHtml: "",
        files: [],
      });
    } catch (e: any) {
      store.toast({ text: `Couldn't open draft: ${e?.message || e}`, kind: "error" });
    }
  }

  setIdentity(id: string) {
    if (!this.draft) return;
    this.draft.identityId = id;
    // Thunderbird's signature follows the From address; a chosen one stays.
    if (this.draft.signature === "default") this.sigRev++;
  }

  close() {
    this.open = false;
    this.draft = null;
    this.error = null;
    this.review = null;
    this.busy = "";
  }

  /** Whether any saved or older email involves a domain (older: Thunderbird's search of its headers, once). */
  private async everUsed(domain: string): Promise<boolean> {
    if ((this.known?.domains.get(domain) || 0) > 0) return true;
    let answer = this.olderDomains.get(domain);
    if (!answer) {
      answer = typeof api.sparkSearch?.search === "function"
        ? Promise.resolve(api.sparkSearch.search(`@${domain}`, { headersOnly: true, limit: 1 })).then((r: any) => !!r?.messages?.length || !!r?.interrupted, () => true)
        : Promise.resolve(false);
      this.olderDomains.set(domain, answer);
    }
    return answer;
  }

  /** What "Before you send" would say about this draft now (settings: checkRecipients, checkLinks). */
  async warnings(d: Draft): Promise<SendWarning[]> {
    const { checkRecipients, checkLinks, checkAttachments } = store.settings;
    const attachments = checkAttachments ? await within(this.attachmentWarnings(d), 4000, []) : [];
    if (!checkRecipients && !checkLinks) return attachments;
    this.known ||= correspondence(mailCache.all(), emailOf);
    const links = checkLinks ? sharedLinks(this.getEditorHtml()).slice(0, 8) : [];
    const checked = await within(Promise.all(links.map(async (link) => ({ link, access: await accessOf(link.url) }))), 5000, []);
    let warnings = sendWarnings({
      mode: d.mode, from: this.identity(d.identityId)?.email || "", to: d.to, cc: d.cc, bcc: d.bcc,
      me: store.me, known: this.known, thread: d.thread, links: checked,
    });
    if (!checkRecipients) warnings = warnings.filter((w) => w.kind === "linkAccess" || w.kind === "linkMissing");
    if (!checkLinks) warnings = warnings.filter((w) => w.kind !== "linkAccess" && w.kind !== "linkMissing");
    // Saved mail covers 90 days: a domain (or "typo") found in older mail isn't new.
    const domainOf = (w: SendWarning) => w.kind === "newDomain" ? w.key.slice(4) : w.kind === "typo" ? w.key.slice(5).split("@")[1] : "";
    const older = await within(Promise.all(warnings.map((w) => domainOf(w) ? this.everUsed(domainOf(w)) : Promise.resolve(false))), 3000, warnings.map(() => true));
    return [...attachments, ...warnings.filter((w, i) => !domainOf(w) || !older[i])];
  }

  /** Files the email promises but lacks, and files older than the conversation's (attachment-promises.ts). */
  private async attachmentWarnings(d: Draft): Promise<SendWarning[]> {
    const doc = new DOMParser().parseFromString(this.getEditorHtml(), "text/html");
    doc.querySelectorAll(".moz-signature, blockquote, .moz-cite-prefix, .moz-forward-container").forEach((el) => el.remove());
    doc.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
    doc.querySelectorAll("p, div, li").forEach((el) => el.append("\n"));
    const text = doc.body.textContent || "";
    const links = [...doc.querySelectorAll("a[href]")].map((a) => a.getAttribute("href") || "");
    const files = [...d.files.map((f) => ({ name: f.name })), ...(d.forwarded || []).map((f) => ({ name: f.name }))];
    const thread: ThreadFile[] = [];
    if (files.length && d.relatedId !== undefined) {
      const messages = (store.threadIds?.(d.relatedId) || [d.relatedId]).map((id) => store.get?.(id)).filter(Boolean) as MessageHeader[];
      for (const m of messages.sort((a, b) => +new Date(b.date) - +new Date(a.date)).slice(0, 25)) {
        const list = await api.messages.listAttachments(m.id).catch(() => []);
        for (const a of (list || []).filter(isFileAttachment)) thread.push({ name: a.name, from: displayName(m.author), date: +new Date(m.date), messageId: m.id, partName: a.partName });
      }
    }
    return attachmentWarnings({ text, files, links, thread });
  }

  /** Re-check after a fix or a change of recipients; "Before you send" closes when nothing is left. */
  async recheck() {
    const d = this.draft;
    if (!d || !this.review) return;
    const warnings = await this.warnings(d);
    if (this.draft !== d || !this.review) return;
    this.review = warnings.length ? warnings : null;
  }

  async fix(warning: SendWarning) {
    const d = this.draft;
    const fix = warning.fix;
    if (!d || !fix) return;
    if (fix.attach) { this.pickFiles++; return; }
    if (fix.swap) {
      const { name, messageId, partName } = fix.swap;
      try {
        const newer: File = await api.messages.getAttachmentFile(messageId, partName);
        const file = new File([newer], fix.swap.with, { type: newer.type });
        d.files = d.files.map((f) => (f.name === name ? file : f));
      } catch (e: any) { this.error = `Couldn't get ${fix.swap.with}: ${e?.message || e}`; }
      await this.recheck();
      return;
    }
    const edit = (list: Addr[]) => list.flatMap((addr) => {
      const email = addr.email.toLowerCase();
      if (fix.remove && email === fix.remove) return [];
      if (fix.replace && email === fix.replace.email) return [{ ...addr, email: fix.replace.with }];
      return [addr];
    });
    d.to = edit(d.to); d.cc = edit(d.cc); d.bcc = edit(d.bcc);
    await this.recheck();
  }

  /** "Send anyway": these warnings won't stop this email again. */
  sendAnyway() {
    if (this.review) this.accepted = warningSignature(this.review);
    this.review = null;
    return this.send(true, this.pendingAt);
  }

  private details(d: Draft): any {
    const userHtml = this.getEditorHtml();
    const body =
      `<!DOCTYPE html><html><head><meta http-equiv="content-type" content="text/html; charset=UTF-8"></head><body>` +
      userHtml +
      (d.quoteHtml ? `<br>${d.quoteHtml}` : "") +
      `</body></html>`;
    const det: any = {
      to: d.to.map(fmtAddr),
      cc: d.cc.map(fmtAddr),
      bcc: d.bcc.map(fmtAddr),
      subject: d.subject,
      body,
      isPlainText: false,
    };
    if (d.identityId) det.identityId = d.identityId;
    if (d.files.length) det.attachments = d.files.map((f) => ({ file: f, name: f.name }));
    return det;
  }

  private openComposeTab(d: Draft, det: any): Promise<any> {
    return openComposeTab(api, d.mode, d.relatedId, det, d.threaded, store.settings.minimizeCompose);
  }

  private closeComposeTab(tab: any) {
    return closeComposeTab(api, tab);
  }

  private async deleteOldDraft(d: Draft) {
    if (d.mode !== "draft" || !d.relatedId) return;
    try {
      // Only ever a message in Drafts (Thunderbird may already have removed the draft and the id moved on).
      const old = await api.messages.get(d.relatedId).catch(() => null);
      if (!old || store.roleOfFolder?.(old.folder?.id) !== "drafts") return;
      await api.messages.delete([d.relatedId], env.hasUserAction ? { deletePermanently: true } : true);
    } catch {
      /* keep the old draft */
    }
  }

  validate(d: Draft): string | null {
    if (!d.to.length && !d.cc.length && !d.bcc.length) return "Add at least one recipient.";
    const bad = [...d.to, ...d.cc, ...d.bcc].find((a) => !/^[^@\s]+@[^@\s]+$/.test(a.email));
    if (bad) return `“${bad.email}” doesn't look like an email address.`;
    if (!d.identityId && !store.identities.length) return "No sending identity — add a mail account in Thunderbird first.";
    return null;
  }

  /** Send, or (with `sendAt`) send later. With Settings → Undo send on, the email waits in the outbox first. */
  async send(confirmed = false, sendAt?: number): Promise<boolean> {
    const d = this.draft;
    if (!d || this.busy || this.checking) return false;
    this.pendingAt = sendAt;
    const problem = this.validate(d);
    if (problem) {
      this.error = problem;
      return false;
    }
    this.busy = "sending";
    this.error = null;
    let tab: any = null;
    try {
      if (windowFree(d.mode, d.threaded) && env.tb >= 153 && !env.hasBackgroundSend) {
        // messages.send is optional-only. Never silently fall back to opening
        // a native composer after the user declines this permission.
        // (First: Thunderbird asks only while handling the click, not after the checks below.)
        if (!await sendSettings.enable()) {
          this.error = sendSettings.error;
          this.busy = "";
          return false;
        }
        if (!this.open || this.draft !== d) { this.busy = ""; return false; }
      }
      if (!confirmed) {
        this.busy = "";
        this.checking = true;
        const warnings = await this.warnings(d).catch(() => []).finally(() => { this.checking = false; });
        if (!this.open || this.draft !== d || this.busy) return false;
        if (warnings.length && warningSignature(warnings) !== this.accepted) {
          perf.record("composer.review", { kinds: warnings.map((w) => w.kind).join(",") });
          this.review = warnings;
          return false;
        }
        this.busy = "sending";
      }
      this.review = null;
      const delay = (store.settings.undoSend || 0) * 1000;
      if (sendAt || delay) return await this.queue(d, sendAt ?? Date.now() + delay, sendAt ? "later" : "undo");
      const det = this.details(d);
      let sent: any;
      if (windowFree(d.mode, d.threaded) && env.hasBackgroundSend) {
        sent = await api.messages.sendMessage(det, { mode: "sendNow" });
      } else if (!(sent = await sendThreaded(api, d.mode, d.relatedId, det, d.threaded))) {
        tab = await this.openComposeTab(d, det);
        sent = await api.compose.sendMessage(tab.id, { mode: "sendNow" });
        tab = null; // TB closes the compose window after a successful send
      }
      await this.deleteOldDraft(d);
      this.close();
      const reminder = d.followUp ? await this.remindIfNoReply(d, sent?.headerMessageId) : "";
      store.toast({ text: `Message sent${reminder}`, kind: "success" });
      return true;
    } catch (e: any) {
      // Keep everything the user wrote; surface the error.
      this.error = `Couldn't send: ${e?.message || e}`;
      this.busy = "";
      await this.closeComposeTab(tab);
      return false;
    }
  }

  /** Into the outbox: the background sends it at `sendAt` (outbox-service.ts) unless it's taken back first. */
  private async queue(d: Draft, sendAt: number, kind: QueuedEmail["kind"]): Promise<boolean> {
    const related = d.relatedId !== undefined ? { id: d.relatedId, mid: (await api.messages.get(d.relatedId).catch(() => null))?.headerMessageId } : undefined;
    const email: QueuedEmail = {
      id: queueId(), sendAt, queuedAt: Date.now(), kind, state: "waiting",
      subject: d.subject, to: [...d.to, ...d.cc, ...d.bcc].map(fmtAddr), mode: d.mode, threaded: d.threaded, related,
      details: this.details(d), followUp: d.followUp,
      draft: { ...$state.snapshot(d), html: this.getEditorHtml(), restored: undefined, keepSignature: undefined },
    };
    await this.outboxStore.put(email);
    await Promise.resolve(api.runtime.sendMessage({ type: "spark:outbox", action: "schedule" })).catch(() => {});
    this.close();
    const undo = store.rememberUndo(kind === "undo" ? "Send" : "Send later", () => this.takeBack(email.id));
    const seconds = Math.round((sendAt - Date.now()) / 1000);
    store.toast({
      text: kind === "later" ? `Sends ${sendTimeText(sendAt).replace(/^Today, /, "today at ").replace(/^Tomorrow, /, "tomorrow at ")}` : `Sending in ${seconds >= 60 ? `${Math.round(seconds / 60)} min` : `${seconds} s`}`,
      kind: "success", action: { label: "Undo", run: undo }, timeout: kind === "undo" ? Math.min(sendAt - Date.now(), 10000) : 6000,
    });
    perf.record("composer.queue", { kind });
    return true;
  }

  /** Undo / Edit: an email out of the outbox and back in the composer (false when it's already being sent). */
  async takeBack(id: string): Promise<boolean> {
    if (this.open) { store.toast({ text: "Close the email you're writing first.", kind: "info" }); return false; }
    const email = await this.outboxStore.take(id).catch(() => null);
    if (!email) { store.toast({ text: "Too late: it's already being sent.", kind: "info" }); return false; }
    const saved = email.draft as Draft;
    let relatedId = saved.relatedId;
    // The email it answers may have moved since (a new id): find it again by its Message-ID.
    if (email.related?.mid) {
      const found = await api.messages.query({ headerMessageId: email.related.mid }).catch(() => null);
      const copies: MessageHeader[] = found?.messages || [];
      const hit = (email.mode === "draft" ? copies.find((m) => store.roleOfFolder?.(m.folder?.id) === "drafts") : undefined) ?? copies.find((m) => m.id === saved.relatedId) ?? copies[0];
      if (hit) relatedId = hit.id;
    }
    this.start({ ...saved, relatedId, files: saved.files || [], html: saved.html });
    if (this.draft) Object.assign(this.draft, { signature: saved.signature, followUp: saved.followUp || 0, restored: true, keepSignature: true });
    await this.refreshOutbox();
    return true;
  }

  /** Send a waiting (or failed) email now. */
  async sendNow(id: string) {
    await Promise.resolve(api.runtime.sendMessage({ type: "spark:outbox", action: "send-now", id })).catch((error: any) => store.toast({ text: `Couldn't send: ${error?.message || error}`, kind: "error" }));
  }

  async refreshOutbox() {
    this.outbox = await this.outboxStore.all().catch(() => this.outbox);
  }

  /** The Ember page follows the outbox: its list, and a toast when the background sent (or couldn't send) one. */
  watchOutbox() {
    void this.refreshOutbox();
    api.storage.onChanged?.addListener((changes: any, area: string) => {
      if (area !== "local") return;
      if (changes.outboxRev) void this.refreshOutbox();
      const event = changes.outboxEvent?.newValue;
      if (event && Date.now() - event.at < 60000) store.toast(event.ok ? { text: event.text, kind: "success" } : { text: event.text, kind: "error", timeout: 10000 });
    });
  }

  /** Register "remind me if no reply" for a sent email; returns the toast's addition. */
  private async remindIfNoReply(d: Draft, headerMessageId: string | undefined): Promise<string> {
    if (!headerMessageId) return " · couldn't set the reminder";
    const to = [...d.to, ...d.cc].map(fmtAddr);
    try {
      await api.runtime.sendMessage({ type: "spark:follow-up", add: followUpFor(headerMessageId, d.subject, to, Date.now(), d.followUp) });
      return ` · reminder in ${d.followUp === 1 ? "1 day" : `${d.followUp} days`} if no reply`;
    } catch { return " · couldn't set the reminder"; }
  }

  async saveDraft(): Promise<boolean> {
    const d = this.draft;
    if (!d || this.busy) return false;
    this.busy = "saving";
    this.error = null;
    const det = this.details(d);
    let tab: any = null;
    try {
      if (windowFree(d.mode, d.threaded) && env.hasBackgroundSave) {
        await api.messages.saveMessage(det, { mode: "draft" });
      } else {
        tab = await this.openComposeTab(d, det);
        await api.compose.saveMessage(tab.id, { mode: "draft" });
      }
      await this.deleteOldDraft(d);
      await this.closeComposeTab(tab);
      this.close();
      store.toast({ text: "Draft saved", kind: "success" });
      return true;
    } catch (e: any) {
      this.error = `Couldn't save draft: ${e?.message || e}`;
      this.busy = "";
      await this.closeComposeTab(tab);
      return false;
    }
  }
}

export const composer = new Composer();
