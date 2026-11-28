<script lang="ts">
  import { composer, signatureContent } from "../lib/compose.svelte";
  import { FOLLOW_UP_DAYS } from "../lib/follow-ups";
  import { freeTimes, matchCommands, opensMenu, type SlashCommand } from "../lib/slash-commands";
  import { api, env } from "../lib/api";
  import { untrack } from "svelte";
  import { store } from "../lib/store.svelte";
  import { fileSize } from "../lib/format";
  import RecipientInput from "./RecipientInput.svelte";
  import Icon from "./Icon.svelte";
  import HtmlFrame from "./HtmlFrame.svelte";
  import { prepareHtml } from "../lib/body";
  import { accessOf, sharedLinks } from "../lib/shared-links";
  import { sendLaterChoices, sendTimeText } from "../lib/outbox";

  let editor: HTMLDivElement | undefined = $state();
  let fileInput: HTMLInputElement | undefined = $state();
  let showQuote = $state(false);
  let allForwarded = $state(false);
  let dialog: HTMLDivElement | undefined = $state();
  let linkOpen = $state(false);
  let linkUrl = $state("https://");
  let savedRange: Range | null = null;
  let fmt = $state<Record<string, boolean>>({});
  let initialized = false;
  let confirmDiscard = $state(false);
  let initialHtml = "";
  let sigOpen = $state(false);
  /** The From menu (Ember's own, like Signature: the system dropdown is drawn in Thunderbird's style). */
  let fromOpen = $state(false);
  const fromIdentity = $derived(store.identities.find((i) => i.id === d?.identityId) || store.identities[0]);
  function pickFrom(id: string) { composer.setIdentity(id); fromOpen = false; }
  let remindOpen = $state(false);
  // Send later: a few times from now, or one picked (datetime-local, in local time).
  let laterOpen = $state(false);
  let laterChoices = $state(sendLaterChoices());
  let laterPicking = $state(false);
  let laterValue = $state("");
  const localInput = (ms: number) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
  function openLater() {
    laterOpen = !laterOpen; sigOpen = false; remindOpen = false; laterPicking = false;
    laterChoices = sendLaterChoices();
    laterValue = localInput(Date.now() + 3600000);
  }
  function sendLater(at: number) {
    if (!(at > Date.now() + 30000)) { store.toast({ text: "Pick a time in the future.", kind: "info" }); return; }
    laterOpen = false;
    void composer.send(false, at);
  }
  const dayText = (n: number) => (n === 7 ? "1 week" : n === 1 ? "1 day" : `${n} days`);
  let sigNaming = $state(false);
  let sigName = $state("");

  let d = $derived(composer.draft);
  let quotePrepared = $derived(d?.quoteHtml && showQuote ? prepareHtml(d.quoteHtml, { allowRemote: store.settings.loadRemoteImages }).srcdoc : "");
  const titles: Record<string, string> = { new: "New message", reply: "Reply", replyAll: "Reply all", forward: "Forward", draft: "Draft" };

  // Fill the editor once per draft, then let contenteditable own its content.
  $effect(() => {
    if (!editor || !d || initialized) return;
    initialized = true;
    editor.innerHTML = d.html;
    initialHtml = editor.innerHTML;
    checkLinksSoon();
    composer.getEditorHtml = () => editor?.innerHTML || "";
    const focusTo = !d.to.length;
    setTimeout(() => {
      if (!focusTo || d.mode !== "new") {
        editor?.focus();
        const sel = getSelection();
        const r = document.createRange();
        r.setStart(editor!, 0);
        r.collapse(true);
        sel?.removeAllRanges();
        sel?.addRange(r);
      }
      // "Share my availability" (the reader's email strip): the free times go in first.
      if (composer.afterOpen === "availability") { composer.afterOpen = null; void insertAvailability(); }
    }, 40);
  });

  // Replace the signature block when the From address (Thunderbird's signature) or the chosen signature changes.
  $effect(() => {
    const rev = composer.sigRev;
    if (!editor || !d) return;
    untrack(() => {
      // Back from the outbox: the email's signature stays as it was written.
      if (d!.keepSignature) { d!.keepSignature = false; return; }
      // The user's own signature, never one inside quoted text (a reply quotes the sender's signature too).
      const sig = [...editor!.querySelectorAll(".moz-signature")].find((s) => !s.closest("blockquote"));
      const html = composer.signatureFor(d!.identityId, d!.signature);
      if (sig) {
        if (html) sig.outerHTML = html;
        else sig.remove();
      } else if (html && rev > 0) {
        editor!.insertAdjacentHTML("beforeend", `<div><br></div>${html}`);
      }
    });
  });

  // ---- Signature menu: choose, edit in this email, save as / update a saved signature ----
  const savedSig = $derived(store.settings.signatures.find((s) => s.id === d?.signature));
  const sigLabel = $derived(!d ? "" : d.signature === "none" ? "No signature" : savedSig ? savedSig.name : "Signature");
  function currentSignature(): string {
    const block = editor?.querySelector(".moz-signature");
    return block ? signatureContent(block.innerHTML) : "";
  }
  function pickSignature(choice: string) {
    sigOpen = false;
    composer.chooseSignature(choice);
  }
  function editSignatureHere() {
    sigOpen = false;
    if (!editor) return;
    let block = editor.querySelector(".moz-signature");
    if (!block) {
      editor.insertAdjacentHTML("beforeend", `<div><br></div><div class="moz-signature" spellcheck="false">-- <br><br></div>`);
      block = editor.querySelector(".moz-signature");
    }
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(block!);
    range.collapse(false);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    block!.scrollIntoView({ block: "nearest" });
  }
  async function saveSignatureAs() {
    const html = currentSignature();
    if (!html) return;
    const name = sigName.trim() || "Signature";
    try {
      await composer.saveSignature(name, html);
      store.toast({ text: `Saved signature “${name}”`, kind: "success" });
    } catch (e: any) { store.toast({ text: `Couldn't save the signature: ${e?.message || e}`, kind: "error" }); }
    sigOpen = false;
    sigNaming = false;
    sigName = "";
  }
  async function updateSavedSignature() {
    const html = currentSignature();
    if (!savedSig || !html) return;
    const name = savedSig.name;
    try {
      await composer.updateSignature(savedSig.id, html);
      store.toast({ text: `Updated signature “${name}”`, kind: "success" });
    } catch (e: any) { store.toast({ text: `Couldn't update the signature: ${e?.message || e}`, kind: "error" }); }
    sigOpen = false;
  }

  function exec(cmd: string, val?: string) {
    editor?.focus();
    document.execCommand(cmd, false, val);
    updateFmt();
  }

  function updateFmt() {
    try {
      fmt = {
        bold: document.queryCommandState("bold"),
        italic: document.queryCommandState("italic"),
        underline: document.queryCommandState("underline"),
        ul: document.queryCommandState("insertUnorderedList"),
        ol: document.queryCommandState("insertOrderedList"),
      };
    } catch {
      /* ignore */
    }
  }

  function quote() {
    editor?.focus();
    const v = String(document.queryCommandValue("formatBlock") || "").toLowerCase();
    document.execCommand("formatBlock", false, v === "blockquote" ? "div" : "blockquote");
  }

  // ---- Slash commands (Notion-style): "/" at a line start or after a space opens a menu at the cursor ----
  let slash = $state<{ node: Text; offset: number; query: string; x: number; y: number; up: boolean; index: number } | null>(null);
  const slashItems = $derived(slash ? matchCommands(slash.query).filter((c) => c.id !== "availability" || env.hasCalendarResponses) : []);
  const slashGrouped = $derived(!!slash && !slash.query);

  function caret(): { node: Text; offset: number; rect: DOMRect } | null {
    const sel = getSelection();
    if (!sel?.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE || !editor?.contains(range.startContainer)) return null;
    return { node: range.startContainer as Text, offset: range.startOffset, rect: range.getBoundingClientRect() };
  }
  /** The text before the "/" on its line (an inline element just before counts; a block or <br> starts a line). */
  function lineBefore(node: Text, offset: number): string {
    const text = node.data.slice(0, offset);
    if (text) return text;
    const prev = node.previousSibling;
    if (!prev || prev.nodeName === "BR") return "";
    return prev.nodeType === Node.TEXT_NODE || (prev instanceof HTMLElement && getComputedStyle(prev).display.startsWith("inline")) ? prev.textContent || "" : "";
  }
  // Shared-file links are checked while writing (a SharePoint answer can take seconds), so Send needn't wait.
  let linkTimer: ReturnType<typeof setTimeout> | undefined;
  function checkLinksSoon() {
    clearTimeout(linkTimer);
    if (!store.settings.checkLinks) return;
    linkTimer = setTimeout(() => { for (const link of sharedLinks(editor?.innerHTML || "").slice(0, 8)) void accessOf(link.url); }, 1200);
  }
  function onEditorInput(e: Event) {
    checkLinksSoon();
    const input = e as InputEvent;
    const c = caret();
    if (!slash) {
      if (input.inputType !== "insertText" || input.data !== "/" || !c || !dialog) return;
      if (!opensMenu(lineBefore(c.node, c.offset - 1))) return;
      const box = dialog.getBoundingClientRect();
      const up = c.rect.bottom + 320 > box.bottom; // near the bottom: open above the line
      slash = { node: c.node, offset: c.offset - 1, query: "", x: Math.max(12, Math.min(c.rect.left - box.left, box.width - 300)), y: up ? box.bottom - c.rect.top + 6 : c.rect.bottom - box.top + 6, up, index: 0 };
      return;
    }
    if (!c || c.node !== slash.node || c.offset <= slash.offset || slash.node.data[slash.offset] !== "/") { slash = null; return; }
    const query = c.node.data.slice(slash.offset + 1, c.offset);
    // A space right after "/", or a query nothing matches followed by a space, means it was just text.
    if (/^\s/.test(query) || query.length > 24 || (/\s$/.test(query) && !matchCommands(query).length)) { slash = null; return; }
    slash = { ...slash, query, index: 0 };
  }
  function onSlashKey(e: KeyboardEvent): boolean {
    if (!slash) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = slashItems.length || 1;
      slash = { ...slash, index: (slash.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n };
      return true;
    }
    if ((e.key === "Enter" || e.key === "Tab") && slashItems.length) {
      e.preventDefault();
      void runSlash(slashItems[slash.index] ?? slashItems[0]);
      return true;
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); slash = null; return true; }
    return false;
  }
  /** Put the caret at the end of `el` (or in its first empty cell). */
  function caretInto(el: Node | null | undefined) {
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(el.textContent ? false : true);
    const sel = getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
  /** Insert a block element where the caret is, splitting nothing else, then put the caret inside it. */
  function insertBlock(html: string, focus = ":scope") {
    document.execCommand("insertHTML", false, `<div data-slash-insert>${html}</div>`);
    const wrapper = editor?.querySelector("[data-slash-insert]");
    if (!wrapper) return;
    const target = focus === ":scope" ? wrapper.firstElementChild : wrapper.querySelector(focus);
    wrapper.replaceWith(...Array.from(wrapper.childNodes));
    caretInto(target);
  }
  async function runSlash(cmd: SlashCommand) {
    const s = slash;
    slash = null;
    if (!s || !editor || !d) return;
    // Remove the typed "/query" first.
    const end = Math.min(s.node.length, s.offset + 1 + s.query.length);
    if (s.node.isConnected && s.node.data[s.offset] === "/") {
      const range = document.createRange();
      range.setStart(s.node, s.offset);
      range.setEnd(s.node, end);
      range.deleteContents();
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    editor.focus();
    const ink = "color:#1c1c1f;";
    switch (cmd.id) {
      case "heading": document.execCommand("formatBlock", false, "h2"); break;
      case "subheading": document.execCommand("formatBlock", false, "h3"); break;
      case "bullets": document.execCommand("insertUnorderedList"); break;
      case "numbers": document.execCommand("insertOrderedList"); break;
      case "todo": insertBlock(`<ul style="list-style:none;padding-left:2px;margin:4px 0"><li>☐&nbsp;</li></ul><div><br></div>`, "li"); break;
      case "quote": document.execCommand("formatBlock", false, "blockquote"); break;
      case "divider": insertBlock(`<hr style="border:0;border-top:1px solid #d0d4dc;margin:12px 0"><div><br></div>`, "div"); break;
      case "code": insertBlock(`<pre style="${ink}font-family:ui-monospace,Menlo,monospace;font-size:13px;background:#f3f4f6;border-radius:6px;padding:10px 12px;white-space:pre-wrap;margin:6px 0"><br></pre><div><br></div>`, "pre"); break;
      case "callout": insertBlock(`<div style="${ink}background:#eef4ff;border-radius:8px;padding:10px 14px;margin:6px 0"><br></div><div><br></div>`); break;
      case "table": {
        const cell = `<td style="border:1px solid #d0d4dc;padding:6px 8px;min-width:80px"><br></td>`;
        insertBlock(`<table style="border-collapse:collapse;margin:6px 0"><tbody>${`<tr>${cell}${cell}</tr>`.repeat(3)}</tbody></table><div><br></div>`, "td");
        break;
      }
      case "link": startLink(); break;
      case "attach": fileInput?.click(); break;
      case "date": document.execCommand("insertText", false, new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })); break;
      case "time": document.execCommand("insertText", false, new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })); break;
      case "availability": await insertAvailability(); break;
      case "cc": d.showCc = true; break;
      case "remind": remindOpen = true; sigOpen = false; break;
      case "signature": sigOpen = true; remindOpen = false; break;
      case "draft": void composer.saveDraft(); break;
    }
    updateFmt();
  }
  /** "My free times": the next three working days' open slots (9–5) from the Exchange calendars. */
  async function insertAvailability() {
    const now = Date.now();
    try {
      const view = await api.sparkCalendar.calendarView(new Date(now).toISOString(), new Date(now + 14 * 86400000).toISOString());
      if (view.accounts && view.errors?.length >= view.accounts) throw new Error(view.errors[0]?.message || "calendar unavailable");
      const busy = (view.events || [])
        .filter((ev: any) => !ev.cancelled && ev.response !== "decline" && ev.freeBusy !== "Free" && !(ev.allDay && ev.freeBusy !== "OOF"))
        .map((ev: any) => ({ start: Date.parse(ev.start), end: Date.parse(ev.end) }))
        .filter((b: { start: number; end: number }) => b.start && b.end);
      const lines = freeTimes(busy, now);
      if (!lines.length) { store.toast({ text: "No free time in the next two weeks' working hours.", kind: "info" }); return; }
      const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
      document.execCommand("insertHTML", false, `<div>I'm free at these times (${esc(Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g, " "))}):</div><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul><div><br></div>`);
    } catch (e: any) {
      store.toast({ text: `Couldn't read your calendar: ${e?.message || e}`, kind: "error" });
    }
  }

  function startLink() {
    const sel = getSelection();
    savedRange = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    linkUrl = "https://";
    linkOpen = true;
  }

  function applyLink() {
    linkOpen = false;
    editor?.focus();
    if (savedRange) {
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(savedRange);
    }
    const url = linkUrl.trim();
    if (!url || url === "https://") return;
    if (!/^(https?:|mailto:)/i.test(url)) return;
    if (savedRange && savedRange.collapsed) {
      document.execCommand("insertHTML", false, `<a href="${url.replace(/"/g, "&quot;")}">${url.replace(/</g, "&lt;")}</a>`);
    } else document.execCommand("createLink", false, url);
  }

  function addFiles(list: FileList | null) {
    if (!list || !d) return;
    d.files = [...d.files, ...Array.from(list)];
  }

  function removeFile(i: number) {
    if (d) d.files = d.files.filter((_, j) => j !== i);
  }

  function onKey(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === "Enter") {
      e.preventDefault();
      // With "Before you send" open, ⌘↵ again sends anyway.
      if (composer.review) composer.sendAnyway(); else composer.send();
    } else if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      composer.saveDraft();
    } else if (e.key === "Escape" && !linkOpen) {
      e.preventDefault();
      if (composer.review) composer.review = null;
      else if (fromOpen || sigOpen || remindOpen || laterOpen) { fromOpen = false; sigOpen = false; sigNaming = false; remindOpen = false; laterOpen = false; }
      else if (confirmDiscard) confirmDiscard = false;
      else discard();
    } else if (e.key === "Tab" && dialog) {
      // Focus trap
      const f = Array.from(dialog.querySelectorAll<HTMLElement>("button:not([disabled]),input,select,[contenteditable=true],[tabindex='0']")).filter((x) => x.offsetParent !== null);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) {
        f[f.length - 1].focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
        f[0].focus();
        e.preventDefault();
      }
    }
    e.stopPropagation();
  }

  function discard(force = false) {
    const dirty = (editor?.innerHTML || "") !== initialHtml || !!d?.files.length || !!d?.restored;
    if (dirty && !force) {
      confirmDiscard = true;
      return;
    }
    confirmDiscard = false;
    initialized = false;
    composer.close();
  }

  function onDrop(e: DragEvent) {
    if (e.dataTransfer?.files?.length) {
      e.preventDefault();
      addFiles(e.dataTransfer.files);
    }
  }

  $effect(() => {
    if (!composer.open) initialized = false;
  });
  // "Attach a file" in "Before you send" opens the file picker (still within the click's user activation).
  let picks = composer.pickFiles;
  $effect(() => {
    if (composer.pickFiles === picks) return;
    picks = composer.pickFiles;
    fileInput?.click();
  });
  // "Before you send" follows changes to the recipients and files while it's open.
  $effect(() => {
    if (!d || !composer.review) return;
    JSON.stringify([d.to, d.cc, d.bcc, d.identityId, d.files.map((f) => f.name)]);
    const timer = setTimeout(() => void composer.recheck(), 250);
    return () => clearTimeout(timer);
  });
  // A different email's attachments start collapsed again.
  $effect(() => { d?.relatedId; d?.mode; allForwarded = false; });
</script>

{#if composer.open && d}
  <div class="scrim" role="presentation" onmousedown={(e) => e.target === e.currentTarget && null}>
    <div
      class="sheet"
      role="dialog"
      aria-modal="true"
      aria-labelledby="compose-title"
      tabindex="-1"
      bind:this={dialog}
      onkeydown={onKey}
      ondragover={(e) => e.preventDefault()}
      ondrop={onDrop}>
      <header class="head">
        <h2 id="compose-title">{titles[d.mode]}</h2>
        <button class="icon-btn" aria-label="Discard" title="Discard (Esc)" onclick={() => discard()}><Icon name="x" /></button>
      </header>

      {#if store.identities.length > 1}
        <div class="field from">
          <span class="lbl" id="c-from-label">From</span>
          <div class="from-wrap">
            <button id="c-from" class="from-btn" aria-haspopup="menu" aria-expanded={fromOpen} aria-labelledby="c-from-label c-from"
              onclick={() => { fromOpen = !fromOpen; sigOpen = false; remindOpen = false; laterOpen = false; }}>
              {#if fromIdentity?.name}<span class="from-name">{fromIdentity.name}</span>{/if}
              <span class="from-addr">{fromIdentity?.email}</span>
              <Icon name="chevronDown" size={13} />
            </button>
            {#if fromOpen}
              <div class="sig-menu from-menu" role="menu" aria-label="Send from">
                {#each store.identities as idn (idn.id)}
                  <button role="menuitemradio" aria-checked={idn.id === d.identityId} data-identity={idn.id} onclick={() => pickFrom(idn.id)}>
                    <span class="tick">{idn.id === d.identityId ? "✓" : ""}</span>
                    {#if idn.name}<span class="from-name">{idn.name}</span>{/if}<span class="from-addr">{idn.email}</span>
                  </button>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      {:else if store.identities.length === 1}
        <div class="field from">
          <span class="lbl">From</span>
          <span class="from-static">{store.identities[0].name} &lt;{store.identities[0].email}&gt;</span>
        </div>
      {/if}

      <div class="to-row" class:has-cc-toggle={!d.showCc}>
        <RecipientInput id="c-to" label="To" bind:value={d.to} autofocus={!d.to.length} />
        {#if !d.showCc}
          <button class="cc-toggle" onclick={() => d && (d.showCc = true)}>Cc/Bcc</button>
        {/if}
      </div>
      {#if d.showCc}
        <RecipientInput id="c-cc" label="Cc" bind:value={d.cc} />
        <RecipientInput id="c-bcc" label="Bcc" bind:value={d.bcc} />
      {/if}
      <div class="field">
        <label class="lbl" for="c-subj">Subject</label>
        <input id="c-subj" class="subject" bind:value={d.subject} autocomplete="off" />
      </div>

      <div class="toolbar" role="toolbar" aria-label="Formatting">
        <button class="icon-btn" aria-label="Bold" title="Bold (⌘B)" aria-pressed={!!fmt.bold} onmousedown={(e) => e.preventDefault()} onclick={() => exec("bold")}><Icon name="bold" size={16} stroke={2} /></button>
        <button class="icon-btn" aria-label="Italic" title="Italic (⌘I)" aria-pressed={!!fmt.italic} onmousedown={(e) => e.preventDefault()} onclick={() => exec("italic")}><Icon name="italic" size={16} stroke={2} /></button>
        <button class="icon-btn" aria-label="Underline" title="Underline (⌘U)" aria-pressed={!!fmt.underline} onmousedown={(e) => e.preventDefault()} onclick={() => exec("underline")}><Icon name="underline" size={16} stroke={2} /></button>
        <span class="tsep"></span>
        <button class="icon-btn" aria-label="Insert link" title="Link (⌘K)" onmousedown={(e) => e.preventDefault()} onclick={startLink}><Icon name="link" size={16} stroke={2} /></button>
        <button class="icon-btn" aria-label="Bulleted list" title="Bulleted list" aria-pressed={!!fmt.ul} onmousedown={(e) => e.preventDefault()} onclick={() => exec("insertUnorderedList")}><Icon name="listUl" size={16} stroke={2} /></button>
        <button class="icon-btn" aria-label="Numbered list" title="Numbered list" aria-pressed={!!fmt.ol} onmousedown={(e) => e.preventDefault()} onclick={() => exec("insertOrderedList")}><Icon name="listOl" size={16} stroke={2} /></button>
        <button class="icon-btn" aria-label="Quote" title="Quote" onmousedown={(e) => e.preventDefault()} onclick={quote}><Icon name="quote" size={16} stroke={2} /></button>
        <span class="tsep"></span>
        <button class="icon-btn" aria-label="Attach files" title="Attach files" onclick={() => fileInput?.click()}><Icon name="clip" size={16} stroke={2} /></button>
        <input type="file" multiple bind:this={fileInput} class="sr-only" tabindex="-1" aria-hidden="true" onchange={(e) => { addFiles((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ""; }} />
        {#if linkOpen}
          <div class="link-pop" role="dialog" aria-label="Insert link">
            <!-- svelte-ignore a11y_autofocus -->
            <input bind:value={linkUrl} autofocus aria-label="Link URL" onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyLink(); } if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); linkOpen = false; editor?.focus(); } }} />
            <button class="pill primary sm" onclick={applyLink}>Add</button>
          </div>
        {/if}
      </div>

      <div class="body-scroll">
        <div
          class="editor"
          bind:this={editor}
          contenteditable="true"
          role="textbox"
          aria-multiline="true"
          aria-label="Message body"
          tabindex="0"
          onkeyup={updateFmt}
          onmouseup={updateFmt}
          oninput={onEditorInput}
          onblur={() => setTimeout(() => { if (document.activeElement !== editor) slash = null; }, 150)}
          onkeydown={(e) => {
            if (onSlashKey(e)) return;
            const mod = e.metaKey || e.ctrlKey;
            const k = e.key.toLowerCase();
            if (mod && k === "k") { e.preventDefault(); startLink(); }
            else if (mod && !e.shiftKey && (k === "b" || k === "i" || k === "u")) {
              e.preventDefault();
              exec(k === "b" ? "bold" : k === "i" ? "italic" : "underline");
            }
          }}></div>
        {#if slash}
          <div class="slash-menu" class:up={slash.up} role="listbox" aria-label="Commands" style="left:{slash.x}px;{slash.up ? `bottom:${slash.y}px` : `top:${slash.y}px`}">
            {#if !slashItems.length}
              <p class="slash-empty">No command “{slash.query}”</p>
            {/if}
            {#each slashItems as cmd, i (cmd.id)}
              {#if slashGrouped && (i === 0 || slashItems[i - 1].group !== cmd.group)}<p class="slash-group">{cmd.group}</p>{/if}
              <button role="option" aria-selected={i === slash.index} class:on={i === slash.index} onmousedown={(e) => e.preventDefault()} onmouseenter={() => slash && (slash = { ...slash, index: i })} onclick={() => runSlash(cmd)}>
                <span class="slash-label">{cmd.label}</span>{#if cmd.hint}<span class="slash-hint">{cmd.hint}</span>{/if}
              </button>
            {/each}
          </div>
        {/if}
        {#if d.quoteHtml}
          <div class="quote-toggle">
            <button class="pill ghost sm" aria-expanded={showQuote} onclick={() => (showQuote = !showQuote)}>
              <Icon name="more" size={16} stroke={2.6} /> {showQuote ? "Hide" : "Show"} {d.mode === "forward" ? "forwarded message" : "quoted text"}
            </button>
          </div>
          {#if showQuote && quotePrepared}
            <div class="quoted"><HtmlFrame srcdoc={quotePrepared} title="Quoted message" /></div>
          {/if}
        {/if}
      </div>

      {#if d.forwarded?.length}
        <ul class="files forwarded" aria-label="Forwarded attachments">
          {#each allForwarded || d.forwarded.length <= 6 ? d.forwarded : d.forwarded.slice(0, 5) as f, i (f.name + i)}
            <li class="file" title="Forwarded with this message">
              <Icon name="clip" size={14} />
              <span class="fname">{f.name}</span>
              <span class="fsize">{fileSize(f.size)}</span>
            </li>
          {/each}
          {#if !allForwarded && d.forwarded.length > 6}
            <li><button class="file more" onclick={() => (allForwarded = true)}>+{d.forwarded.length - 5} more</button></li>
          {/if}
        </ul>
      {/if}
      {#if d.files.length}
        <ul class="files" aria-label="Attachments">
          {#each d.files as f, i (f.name + i)}
            <li class="file">
              <Icon name="clip" size={14} />
              <span class="fname">{f.name}</span>
              <span class="fsize">{fileSize(f.size)}</span>
              <button class="x" aria-label="Remove {f.name}" onclick={() => removeFile(i)}>×</button>
            </li>
          {/each}
        </ul>
      {/if}

      {#if confirmDiscard}
        <div class="confirm" role="alertdialog" aria-label="Discard message?">
          <span>Discard this message? Your text will be lost.</span>
          <button class="pill ghost sm" onclick={() => (confirmDiscard = false)}>Keep editing</button>
          <button class="pill sm danger" onclick={() => discard(true)}>Discard</button>
        </div>
      {/if}

      {#if composer.review}
        <div class="review" role="alertdialog" aria-labelledby="review-title">
          <p class="review-title" id="review-title"><Icon name="alert" size={15} /> Before you send</p>
          <ul>
            {#each composer.review as w (w.key)}
              <li class={w.kind}>
                <span class="what"><b>{w.text}</b>{#if w.detail}<small>{w.detail}</small>{/if}</span>
                {#if w.fix}<button class="pill ghost sm" onclick={() => composer.fix(w)}>{w.fix.label}</button>{/if}
              </li>
            {/each}
          </ul>
          <div class="review-actions">
            <button class="pill ghost sm" onclick={() => (composer.review = null)}>Keep editing</button>
            <button class="pill primary sm" onclick={() => composer.sendAnyway()} disabled={!!composer.busy}>{composer.pendingAt ? "Schedule anyway" : "Send anyway"}</button>
          </div>
        </div>
      {/if}

      {#if composer.error}
        <div class="error" role="alert">{composer.error}</div>
      {/if}

      <footer class="foot">
        <button class="pill primary send" onclick={() => composer.send()} disabled={!!composer.busy || composer.checking}>
          <Icon name="send" size={16} stroke={2} />
          {composer.busy === "sending" ? "Sending…" : composer.checking ? "Checking…" : "Send"}
        </button>
        <div class="sig-wrap">
          <button class="pill ghost later-btn" aria-haspopup="menu" aria-expanded={laterOpen} aria-label="Send later" title="Send later" disabled={!!composer.busy || composer.checking} onclick={openLater}><Icon name="clock" size={16} /></button>
          {#if laterOpen}
            <div class="sig-menu left later-menu" role="menu" aria-label="Send later">
              <p class="menu-title">Send later</p>
              {#each laterChoices as choice (choice.label)}
                <button role="menuitem" onclick={() => sendLater(choice.at)}><span class="tick"></span><span class="later-label">{choice.label}</span><span class="later-time">{sendTimeText(choice.at)}</span></button>
              {/each}
              <hr />
              {#if laterPicking}
                <div class="sig-name">
                  <input type="datetime-local" bind:value={laterValue} min={localInput(Date.now())} aria-label="Send at" onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); sendLater(+new Date(laterValue)); } }} />
                  <button class="pill primary sm" onclick={() => sendLater(+new Date(laterValue))}>Schedule</button>
                </div>
              {:else}
                <button role="menuitem" onclick={() => (laterPicking = true)}><span class="tick"></span>Pick a date and time…</button>
              {/if}
            </div>
          {/if}
        </div>
        <span class="hint"><kbd>⌘</kbd> <kbd>↵</kbd></span>
        <div class="sig-wrap">
          <button class="pill ghost sig-btn" class:on={!!d.followUp} aria-haspopup="menu" aria-expanded={remindOpen} title="Remind me if nobody replies" onclick={() => { remindOpen = !remindOpen; sigOpen = false; laterOpen = false; }}>
            <Icon name="bell" size={15} /> {d.followUp ? `If no reply in ${dayText(d.followUp)}` : "Remind me"}
          </button>
          {#if remindOpen}
            <div class="sig-menu left" role="menu" aria-label="Remind me if no reply">
              <p class="menu-title">Remind me if nobody replies in…</p>
              {#each FOLLOW_UP_DAYS as n (n)}
                <button role="menuitemradio" aria-checked={d.followUp === n} onclick={() => { d.followUp = n; remindOpen = false; }}><span class="tick">{d.followUp === n ? "✓" : ""}</span>{dayText(n)}</button>
              {/each}
              <button role="menuitemradio" aria-checked={!d.followUp} onclick={() => { d.followUp = 0; remindOpen = false; }}><span class="tick">{!d.followUp ? "✓" : ""}</span>Don't remind me</button>
            </div>
          {/if}
        </div>
        <span class="spacer"></span>
        <div class="sig-wrap">
          <button class="pill ghost sig-btn" aria-haspopup="menu" aria-expanded={sigOpen} title="Signature for this email" onclick={() => { sigOpen = !sigOpen; sigNaming = false; remindOpen = false; laterOpen = false; }}>
            <Icon name="compose" size={15} /> {sigLabel} <Icon name="chevronDown" size={13} />
          </button>
          {#if sigOpen}
            <div class="sig-menu" role="menu" aria-label="Signature">
              <button role="menuitemradio" aria-checked={d.signature === "default"} onclick={() => pickSignature("default")}><span class="tick">{d.signature === "default" ? "✓" : ""}</span>{composer.hasIdentitySignature(d.identityId) ? "Thunderbird signature" : "Thunderbird signature (none set)"}</button>
              {#each store.settings.signatures as s (s.id)}
                <button role="menuitemradio" aria-checked={d.signature === s.id} onclick={() => pickSignature(s.id)}><span class="tick">{d.signature === s.id ? "✓" : ""}</span>{s.name}</button>
              {/each}
              <button role="menuitemradio" aria-checked={d.signature === "none"} onclick={() => pickSignature("none")}><span class="tick">{d.signature === "none" ? "✓" : ""}</span>No signature</button>
              <hr />
              <button role="menuitem" onclick={editSignatureHere}><span class="tick"></span>Edit signature in this email</button>
              {#if sigNaming}
                <div class="sig-name">
                  <!-- svelte-ignore a11y_autofocus -->
                  <input bind:value={sigName} placeholder="Name, e.g. Short" aria-label="Signature name" autofocus onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); void saveSignatureAs(); } }} />
                  <button class="pill primary sm" onclick={saveSignatureAs}>Save</button>
                </div>
              {:else}
                <button role="menuitem" onclick={() => { if (currentSignature()) sigNaming = true; else store.toast({ text: "This email has no signature to save. Use Edit signature first.", kind: "info" }); }}><span class="tick"></span>Save as new signature…</button>
              {/if}
              {#if savedSig}
                <button role="menuitem" onclick={updateSavedSignature}><span class="tick"></span>Update “{savedSig.name}” with this version</button>
              {/if}
            </div>
          {/if}
        </div>
        <button class="pill ghost" onclick={() => composer.saveDraft()} disabled={!!composer.busy}>
          {composer.busy === "saving" ? "Saving…" : "Save draft"}
        </button>
        <button class="icon-btn" aria-label="Discard" title="Discard" onclick={() => discard()}><Icon name="trash" /></button>
      </footer>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: var(--scrim);
    display: grid;
    place-items: center;
    z-index: 50;
    animation: fade var(--med) var(--ease);
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .sheet {
    width: min(760px, calc(100vw - 48px));
    height: min(720px, calc(100vh - 48px));
    background: var(--surface);
    border-radius: 16px;
    box-shadow: var(--shadow-lg);
    border: 1px solid var(--sep);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    animation: pop var(--med) var(--ease);
  }
  @keyframes pop {
    from {
      transform: translateY(10px) scale(0.985);
      opacity: 0;
    }
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 12px 8px 20px;
  }
  .head h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
  }
  .field {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 20px;
    border-bottom: 1px solid var(--sep);
    min-height: 44px;
  }
  .lbl {
    width: 44px;
    flex: none;
    color: var(--text-2);
    font-size: 13px;
  }
  .from-wrap { position: relative; flex: 1; min-width: 0; }
  .from-btn { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; height: 30px; padding: 0 8px; margin-left: -8px; border: 0; border-radius: 7px; background: transparent; color: var(--text); font: inherit; font-size: 14px; cursor: pointer; }
  .from-btn:hover, .from-btn[aria-expanded="true"] { background: var(--hover); }
  .from-btn :global(svg) { flex: none; color: var(--text-3); }
  .from-name { font-weight: 500; white-space: nowrap; }
  .from-addr { color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .sig-menu.from-menu { top: 34px; bottom: auto; left: -8px; right: auto; min-width: 320px; }
  .sig-menu.from-menu > button { gap: 6px; }
  .from-static {
    font-size: 14px;
  }
  .to-row {
    position: relative;
  }
  /* The floating Cc/Bcc button needs its own room at the end of the To field. */
  .to-row.has-cc-toggle :global(.field) { padding-right: 84px; }
  .cc-toggle {
    position: absolute;
    right: 16px;
    top: 10px;
    font-size: 12.5px;
    color: var(--text-2);
    padding: 4px 8px;
    border-radius: 6px;
  }
  .cc-toggle:hover {
    background: var(--hover);
    color: var(--text);
  }
  .subject {
    flex: 1;
    height: 30px;
    border: 0;
    background: transparent;
    font-size: 15px;
    font-weight: 600;
  }
  .subject:focus-visible {
    box-shadow: none;
  }
  .toolbar {
    position: relative;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 6px 14px;
    border-bottom: 1px solid var(--sep);
  }
  .toolbar .icon-btn {
    width: 30px;
    height: 30px;
  }
  .tsep {
    width: 1px;
    height: 18px;
    background: var(--sep-strong);
    margin: 0 6px;
  }
  .link-pop {
    position: absolute;
    left: 110px;
    top: 40px;
    z-index: 5;
    display: flex;
    gap: 6px;
    padding: 8px;
    border-radius: 12px;
    background: var(--surface);
    border: 1px solid var(--sep-strong);
    box-shadow: var(--shadow-lg);
  }
  .link-pop input {
    width: 280px;
    height: 30px;
    padding: 0 10px;
    border-radius: 8px;
    border: 1px solid var(--sep-strong);
    background: var(--surface-2);
  }
  .pill.sm {
    height: 30px;
    padding: 0 12px;
    font-size: 12.5px;
  }
  .body-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 14px 20px 18px;
  }
  .editor {
    min-height: 180px;
    font-size: 15px;
    line-height: 1.55;
    outline: none;
    overflow-wrap: anywhere;
  }
  .editor:focus-visible {
    box-shadow: none;
  }
  .editor :global(blockquote) {
    margin: 6px 0;
    padding-left: 12px;
    border-left: 3px solid var(--sep-strong);
    color: var(--text-2);
  }
  .editor :global(a) {
    color: var(--accent-text);
  }
  .editor :global(.moz-signature) {
    color: var(--text-2);
  }
  .quote-toggle {
    margin-top: 8px;
  }
  .quoted {
    margin-top: 8px;
    max-height: 360px;
    overflow: auto;
    border-radius: 10px;
    border: 1px solid var(--sep);
  }
  .confirm {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 20px 8px;
    padding: 8px 8px 8px 12px;
    border-radius: 10px;
    background: var(--surface-2);
    border: 1px solid var(--sep-strong);
    font-size: 13px;
  }
  .confirm span {
    flex: 1;
  }
  .pill.danger {
    background: var(--danger);
    color: #fff;
    border-color: transparent;
  }
  .files {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin: 0;
    padding: 8px 20px;
    border-top: 1px solid var(--sep);
  }
  .file {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    padding: 0 6px 0 10px;
    border-radius: 999px;
    background: var(--chip);
    font-size: 12.5px;
  }
  /* Read-only: they come from the forwarded email. */
  .forwarded .file { padding-right: 10px; background: transparent; box-shadow: inset 0 0 0 1px var(--sep-strong); }
  .forwarded .more { border: 0; color: var(--accent); font: inherit; font-size: 12.5px; cursor: pointer; }
  .fname {
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fsize {
    color: var(--text-2);
  }
  .x {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    color: var(--text-2);
    font-size: 15px;
  }
  .x:hover {
    background: var(--hover);
  }
  .error {
    margin: 0 20px 8px;
    padding: 8px 12px;
    border-radius: 10px;
    background: color-mix(in srgb, var(--danger) 12%, transparent);
    color: var(--danger);
    font-size: 13px;
    font-weight: 500;
  }
  .review {
    margin: 0 20px 8px;
    padding: 10px 10px 8px 12px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--warning-text) 7%, var(--surface));
    border: 1px solid color-mix(in srgb, var(--warning-text) 30%, transparent);
    max-height: 40%;
    overflow-y: auto;
  }
  .review-title { display: flex; align-items: center; gap: 6px; margin: 0 0 6px; font-size: 12.5px; font-weight: 600; color: var(--warning-text); }
  .review ul { list-style: none; margin: 0; padding: 0; }
  .review li { display: flex; align-items: center; gap: 10px; padding: 5px 0; border-top: 1px solid var(--sep); }
  .review li:first-child { border-top: 0; }
  .review .what { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; font-size: 13px; }
  .review .what b { font-weight: 600; overflow-wrap: anywhere; }
  .review .what small { font-size: 12px; color: var(--text-2); }
  .review li .pill { flex: none; }
  .review-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 6px; }
  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px 12px 20px;
    border-top: 1px solid var(--sep);
  }
  .send {
    height: 36px;
    padding: 0 18px;
    font-size: 14px;
    font-weight: 600;
  }
  .hint {
    display: flex;
    gap: 3px;
  }
  .spacer {
    flex: 1;
  }
  .sig-wrap { position: relative; }
  .sheet { position: relative; }
  .slash-menu { position: absolute; z-index: 8; width: 280px; max-height: 300px; overflow-y: auto; padding: 6px; border-radius: 12px; background: var(--surface); border: 1px solid var(--sep-strong); box-shadow: var(--shadow-lg); }
  .slash-menu button { display: flex; align-items: baseline; gap: 10px; width: 100%; padding: 7px 10px; border-radius: 7px; text-align: left; font-size: 13.5px; }
  .slash-menu button.on { background: var(--accent-soft); }
  .slash-label { flex: none; }
  .slash-hint { flex: 1; min-width: 0; text-align: right; font-size: 12px; color: var(--text-2); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .slash-group { margin: 6px 10px 2px; font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--text-3); }
  .slash-group:first-child { margin-top: 2px; }
  .slash-empty { margin: 6px 10px; font-size: 13px; color: var(--text-2); }
  .sig-btn { display: inline-flex; align-items: center; gap: 6px; max-width: 220px; }
  .sig-menu {
    position: absolute; right: 0; bottom: 44px; z-index: 6; min-width: 260px; max-height: 360px; overflow-y: auto;
    padding: 6px; border-radius: 12px; background: var(--surface); border: 1px solid var(--sep-strong); box-shadow: var(--shadow-lg);
  }
  .sig-menu > button { display: flex; align-items: center; width: 100%; padding: 7px 10px 7px 4px; border-radius: 7px; font-size: 13px; text-align: left; }
  .sig-menu > button:hover { background: var(--hover); }
  .sig-menu.left { right: auto; left: 0; }
  .sig-btn.on { color: var(--accent-text); }
  .later-btn { width: 36px; height: 36px; padding: 0; display: inline-grid; place-items: center; }
  .later-menu { min-width: 300px; }
  .later-label { flex: 1; }
  .later-time { font-size: 12px; color: var(--text-2); font-variant-numeric: tabular-nums; }
  .menu-title { margin: 4px 10px 6px; font-size: 12px; color: var(--text-2); }
  .sig-menu .tick { width: 20px; flex: none; text-align: center; color: var(--accent); }
  .sig-menu hr { border: 0; border-top: 1px solid var(--sep); margin: 5px 4px; }
  .sig-name { display: flex; gap: 6px; padding: 4px; }
  .sig-name input { flex: 1; height: 30px; padding: 0 10px; border-radius: 8px; border: 1px solid var(--sep-strong); background: var(--surface-2); }
</style>
