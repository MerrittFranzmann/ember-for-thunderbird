<script lang="ts">
  import { loadMessage, forgetMessage } from "../lib/message-data";
  import type { MessageAttachment, MessagePart } from "../lib/types";
  import type { QuotedHistoryRequest } from "../lib/quoted-history";
  import { inlineImage } from "../lib/inline-images";
  import type { LoadedMessage } from "../lib/message-loader";
  import { api } from "../lib/api";
  import { store } from "../lib/store.svelte";
  import { composer } from "../lib/compose.svelte";
  import { extractBodies, makeSnippet, prepareHtml, textToHtml, splitMessageHistory } from "../lib/body";
  import { openAttachment, saveAttachment, saveAttachmentsToDownloads } from "../lib/attachment-actions";
  import { attachmentMenuItems, contactLine, personMenuItems, type FileAction, type PersonAction } from "../lib/context-menu";
  import ContextMenu, { type MenuItem } from "./ContextMenu.svelte";
  import { scanner } from "../lib/virustotal-scanner.svelte";
  import { BUSY, reportUrl, scanBadge, scanText, type ScanResult } from "../lib/virustotal";
  import { displayName, emailOf, fileSize, fullDate, listDate, parseAddr } from "../lib/format";
  import { calendarBodies, hasInvitation } from "../lib/calendar-parts";
  // Loaded only for emails with an invitation: it brings the iCalendar parser (ical.js).
  const invitationCard = () => import("./InvitationCard.svelte");
  import Avatar from "./Avatar.svelte";
  import Icon from "./Icon.svelte";
  import HtmlFrame from "./HtmlFrame.svelte";
  import AttachmentPreview from "./AttachmentPreview.svelte";
  import { previewKind } from "../lib/attachment-library";
  import { senderDomain, type ReceivedAttachment } from "../lib/attachments";
  import type { MessageHeader } from "../lib/types";
  import { untrack } from "svelte";
  import { groupsOf, INBOX_LABEL } from "../lib/inboxes";
  import { perf } from "../lib/perf-recorder";

  let {
    msg,
    expanded,
    onToggle,
    dark,
    onHistory,
    historyBusy = false,
    highlighted = false,
  }: { msg: MessageHeader; expanded: boolean; onToggle: () => void; dark: boolean; onHistory: (request: QuotedHistoryRequest) => void; historyBusy?: boolean; highlighted?: boolean } = $props();

  perf.record("message.mount", { expanded: untrack(() => expanded) });
  // Raw: the MIME tree is large and read-only; deep proxies would only add cost.
  let loaded = $state.raw<LoadedMessage | null>(null);
  let loadError = $state<string | null>(null);
  let allowRemote = $state(false);
  let cidMap = $state<Map<string, string>>(new Map());
  let imagesPending = $state(false);
  let showDetails = $state(false);

  let thumbs = $state<Record<string, string>>({});
  let preview = $state<ReceivedAttachment | null>(null);
  // The reader re-creates header objects on every store update; work keyed on the
  // id (a primitive) does not re-run for an unchanged message.
  const messageId = $derived(msg.id);

  // Thumbnail lifetimes follow this message, including in-flight requests at unmount.
  $effect(() => {
    const list = visibleAtts.filter((a) => a.contentType?.startsWith("image/") && a.size < 8 * 1024 * 1024);
    const urls: string[] = [];
    let active = true;
    const id = messageId;
    for (const a of list) {
      api.messages.getAttachmentFile(id, a.partName).then((file: File) => {
        if (!active) return;
        const url = URL.createObjectURL(file);
        urls.push(url);
        thumbs = { ...thumbs, [a.partName]: url };
      }).catch(() => {});
    }
    return () => { active = false; urls.forEach((url) => URL.revokeObjectURL(url)); };
  });

  const fromMe = $derived(store.me.has(emailOf(msg.author)));
  const cat = $derived(store.categoryOf(msg));
  // Work and Personal inboxes: "Always put this sender in…" (a rule for this sender in this email's inbox).
  const senderInbox = $derived(fromMe ? null : store.inboxOfAccount(msg.folder?.accountId));
  const senderRule = $derived(senderInbox ? store.settings.senderGroups[senderInbox]?.[emailOf(msg.author)] ?? "" : "");
  async function setSenderGroup(group: string) {
    if (!senderInbox) return;
    const who = parseAddr(msg.author).email;
    try {
      await store.setSenderGroup(senderInbox, emailOf(msg.author), group || null);
      const label = groupsOf(senderInbox, store.settings).find((g) => g.id === group)?.label;
      store.toast({ text: label ? `Mail from ${who} will go to ${label}.` : `Ember will sort mail from ${who} again.`, kind: "success" });
    } catch { store.toast({ text: "Couldn't save where this sender goes.", kind: "error" }); }
  }

  let retryTick = $state(0);
  $effect(() => {
    retryTick;
    if (!expanded) return;
    const id = messageId;
    let active = true;
    const first = perf.span("spark.message-body");
    const all = perf.span("spark.message-load");
    const show = (body: LoadedMessage) => { first(); if (active && loaded !== body) loaded = body; };
    loadMessage(api, id, show)
      .then((result) => { all(); show(result); })
      .catch((error) => { if (active) loadError = error?.message || String(error); });
    return () => { active = false; };
  });
  function retryLoad() {
    forgetMessage(msg.id);
    loaded = null;
    cidMap = new Map();
    loadError = null;
    retryTick++;
  }
  function openInThunderbird() {
    // In Ember-only mode the tab opens in the hidden Thunderbird window; show it, or the tab is never
    // seen (and Thunderbird restores it, rebuilding its folder's view, at every start).
    api.messageDisplay?.open?.({ messageId: msg.id, location: "tab", active: true })
      .then(() => api.runtime.sendMessage({ type: "spark:show-thunderbird" })).catch(() => {});
  }

  // Attachment details re-publish `loaded` with the same MIME tree; don't re-extract for that.
  const full = $derived(loaded?.full);
  let bodies = $derived(full ? extractBodies(full) : null);

  // Text paints first. Inline resources arrive independently and are reused on reopen.
  $effect(() => {
    if (!loaded || !bodies?.html) return;
    messageId;
    const message = untrack(() => msg); const html = bodies.html;
    const inline = loaded.atts.filter((attachment) => attachment.contentId && html.includes(attachment.contentId.replace(/^<|>$/g, "")));
    if (!inline.length) { imagesPending = false; return; }
    let active = true; let next = 0; let timer: ReturnType<typeof setTimeout> | undefined;
    const resolved = new Map<string, string>();
    imagesPending = true;
    const publish = () => { if (active && resolved.size) cidMap = new Map(resolved); };
    const worker = async () => {
      while (active && next < inline.length) {
        const attachment = inline[next++];
        try {
          const url = await inlineImage(api, message, attachment);
          if (!active) return;
          resolved.set(attachment.contentId!.replace(/^<|>$/g, ""), url);
          if (!timer) timer = setTimeout(() => { timer = undefined; publish(); }, 50);
        } catch { /* An unavailable image never prevents text or other images from rendering. */ }
      }
    };
    void Promise.all([worker(), worker()]).then(() => { clearTimeout(timer); publish(); if (active) imagesPending = false; });
    return () => { active = false; clearTimeout(timer); };
  });

  let prepared = $derived.by(() => {
    if (!bodies?.html) return null;
    // Inline images are applied by HtmlFrame, so arriving images never rebuild the document.
    return prepareHtml(historyParts.current.html || bodies.html, { allowRemote: allowRemote || store.settings.loadRemoteImages, standardizeText: store.settings.standardizeEmailText });
  });

  let historyParts = $derived(splitMessageHistory(bodies || {}));
  const inviteOnly = $derived(!!full && !bodies?.text?.trim() && (!bodies?.html || !!prepared?.empty) && calendarBodies(full).length > 0);

  let visibleAtts = $derived.by(() => {
    if (!loaded) return [];
    const html = bodies?.html || "";
    return loaded.atts.filter((a) => {
      if (a.contentId && html.includes(a.contentId.replace(/^<|>$/g, ""))) return false;
      return true;
    });
  });

  let snippet = $derived.by(() => {
    store.metaRev;
    return store.meta.get(msg)?.snippet ?? (bodies ? makeSnippet(bodies) : "");
  });

  $effect(() => {
    messageId;
    if (!expanded) untrack(() => store.meta.requestCached(msg));
  });

  // The first three recipients by name (each right-clickable), then "+N".
  const recipientsShown = $derived.by(() => {
    const all = [...(msg.recipients || []), ...(msg.ccList || [])];
    return { first: all.slice(0, 3).map((raw) => { const a = parseAddr(raw); return { raw, label: store.me.has(a.email.toLowerCase()) ? "me" : displayName(a) }; }), more: Math.max(0, all.length - 3) };
  });

  // Spam (spam.ts): this email's conversation (or just this email) marked either way.
  const inSpamFolder = $derived(store.roleOfFolder(msg.folder?.id) === "junk" && !store.me.has(emailOf(msg.author).toLowerCase()));
  function spamVerdict(spam: boolean) {
    const conv = store.conversations.find((c) => c.ids.includes(msg.id)) || { key: `message:${msg.id}`, ids: [msg.id], latest: msg } as any;
    return spam ? store.markSpam([conv]) : store.notSpam([conv]);
  }

  // Right-clicks (context-menu.ts): a sender or recipient (anything marked data-address), or an attachment.
  let menu = $state<{ x: number; y: number; items: MenuItem[]; label: string } | null>(null);
  const copyText = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); store.toast({ text: `${what} copied`, kind: "success", timeout: 2000 }); }
    catch (e: any) { store.toast({ text: `Couldn't copy: ${e?.message || e}`, kind: "error" }); }
  };
  function personMenu(e: MouseEvent) {
    const el = (e.target as Element | null)?.closest?.("[data-address]");
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    const who = parseAddr(el.getAttribute("data-address") || "");
    const isMe = store.me.has(who.email.toLowerCase());
    const run = (action: PersonAction) => {
      if (action === "write-to") composer.openNew([{ name: who.name, email: who.email }]);
      else if (action === "copy-address") void copyText(who.email, "Email address");
      else if (action === "copy-contact") void copyText(contactLine(who.name, who.email), "Name and address");
      else { store.searchText = who.email; void store.searchMail(who.email, "local"); }
    };
    const items = personMenuItems({ name: who.name, email: who.email, isMe }).map((i) => ({ label: i.label, icon: i.icon, run: () => run(i.action) }));
    if (items.length) menu = { x: e.clientX, y: e.clientY, items, label: `Actions for ${who.email}` };
  }
  function attachmentMenu(e: MouseEvent, a: MessageAttachment) {
    e.preventDefault(); e.stopPropagation();
    const others = visibleAtts.filter((x) => x.partName !== a.partName);
    const run = async (action: FileAction) => {
      if (action === "preview") guarded(a, "preview");
      else if (action === "open") guarded(a, "open");
      else if (action === "save") guarded(a, "save");
      else if (action === "copy-name") void copyText(a.name || "attachment", "File name");
      else if (action === "save-all") {
        // A file VirusTotal flagged isn't saved without asking: it's left out here.
        const safe = visibleAtts.filter((x) => scanOf(x)?.status !== "flagged");
        const skipped = visibleAtts.length - safe.length;
        try {
          const n = await saveAttachmentsToDownloads(msg.id, safe);
          store.toast({ text: `Saved ${n} ${n === 1 ? "file" : "files"} to Downloads${skipped ? ` (${skipped} flagged by VirusTotal left out)` : ""}`, kind: "success" });
        } catch (error: any) { store.toast({ text: `Couldn't save the attachments: ${error?.message || error}`, kind: "error" }); }
      }
    };
    const items = attachmentMenuItems({ canPreview: !!previewKind(a), others: others.length }).map((i) => ({ label: i.label, icon: i.icon, run: () => run(i.action) }));
    menu = { x: e.clientX, y: e.clientY, items, label: `Actions for ${a.name || "attachment"}` };
  }

  // VirusTotal (virustotal-scanner.svelte.ts): each file is looked up by its fingerprint when the email opens (the
  // file isn't sent); a flagged one asks before it opens, previews or saves; one VirusTotal hasn't seen can be
  // uploaded after a warning.
  let askUpload = $state<string | null>(null);
  let askOpen = $state<{ a: MessageAttachment; then: "open" | "save" | "preview" } | null>(null);
  $effect(() => {
    if (!expanded || !scanner.on || !store.settings.virusTotalAuto) return;
    const atts = visibleAtts, id = msg.id;
    untrack(() => { for (const a of atts) void scanner.check(id, a); });
  });
  const scanOf = (a: MessageAttachment): ScanResult | undefined => scanner.result(msg.id, a);
  function scanIcon(r: ScanResult | undefined) {
    return r?.status === "flagged" || r?.status === "suspicious" ? "shieldAlert" : r?.status === "clean" ? "shieldCheck" : "shield";
  }
  function scanClick(a: MessageAttachment) {
    const r = scanOf(a);
    if (r && BUSY.includes(r.status)) return;
    if (!r || r.status === "error") { void scanner.check(msg.id, a, { force: !!r }); return; }
    if (r.status === "unknown") { askUpload = a.partName; return; }
    if (r.sha256) void Promise.resolve(api.windows?.openDefaultBrowser?.(reportUrl(r.sha256))).catch(() => {});
  }
  function guarded(a: MessageAttachment, then: "open" | "save" | "preview", sure = false) {
    if (!sure && scanOf(a)?.status === "flagged") { askOpen = { a, then }; return; }
    askOpen = null;
    if (then === "open") void openAtt(a);
    else if (then === "save") void saveAtt(a);
    else preview = { key: `${msg.id}:${a.partName}`, message: msg, attachment: a, domain: senderDomain(msg.author) || "" };
  }

  async function openAtt(a: MessageAttachment) {
    try {
      await openAttachment(msg.id, a);
    } catch (e: any) {
      store.toast({ text: `Couldn't open attachment: ${e?.message || e}`, kind: "error" });
    }
  }

  async function saveAtt(a: MessageAttachment) {
    try {
      await saveAttachment(msg.id, a);
    } catch (e: any) {
      store.toast({ text: `Couldn't save attachment: ${e?.message || e}`, kind: "error" });
    }
  }

  function attIcon(a: MessageAttachment) {
    if (a.contentType?.startsWith("image/")) return "image";
    return "clip";
  }

  function ext(a: MessageAttachment) {
    const m = (a.name || "").match(/\.([a-z0-9]{1,5})$/i);
    return m ? m[1].toUpperCase() : (a.contentType || "").split("/")[1]?.toUpperCase() || "FILE";
  }
</script>

<article class="msg" class:history-highlight={highlighted} data-message-id={msg.id} class:expanded class:collapsed={!expanded} aria-label="Message from {displayName(msg.author)}" oncontextmenu={personMenu}>
  <button class="head" onclick={onToggle} aria-expanded={expanded}>
    <span class="person-ref" data-address={msg.author}><Avatar from={msg.author} {cat} size={36} /></span>
    <span class="who">
      <span class="name-line">
        <span class="name" title={msg.author} data-address={msg.author}>{fromMe ? "Me" : displayName(msg.author)}</span>
        {#if expanded && !fromMe}<span class="email" data-address={msg.author}>{parseAddr(msg.author).email}</span>{/if}
        {#if msg.read === false}<span class="unread-dot" aria-label="Unread"></span>{/if}
      </span>
      {#if expanded}
        <span class="to" title={[...(msg.recipients || []), ...(msg.ccList || [])].length > 3 ? [...(msg.recipients || []), ...(msg.ccList || [])].join("\n") + "\n\nAll recipients: … (Details)" : undefined}>to {#each recipientsShown.first as r, i (i)}{i ? ", " : ""}<span class="person" data-address={r.raw}>{r.label}</span>{/each}{#if recipientsShown.more} +{recipientsShown.more}{/if}</span>
      {:else}
        <span class="snip">{snippet}</span>
      {/if}
    </span>
    <span class="when">
      {#if msg.flagged}<span class="pinned"><Icon name="pin" size={13} stroke={2} /></span>{/if}
      {expanded ? fullDate(msg.date) : listDate(msg.date)}
    </span>
  </button>

  {#if expanded}
    <div class="tools">
      <button class="icon-btn" title="Details" aria-label="Show details" aria-pressed={showDetails} onclick={() => (showDetails = !showDetails)}><Icon name="more" stroke={2.6} /></button>
    </div>
    {#if showDetails}
      <dl class="details">
        <dt>From</dt><dd><span class="person" data-address={msg.author}>{msg.author}</span></dd>
        {#if msg.recipients?.length}<dt>To</dt><dd>{#each msg.recipients as raw, i (i)}{i ? ", " : ""}<span class="person" data-address={raw}>{raw}</span>{/each}</dd>{/if}
        {#if msg.ccList?.length}<dt>Cc</dt><dd>{#each msg.ccList as raw, i (i)}{i ? ", " : ""}<span class="person" data-address={raw}>{raw}</span>{/each}</dd>{/if}
        <dt>Date</dt><dd>{new Date(msg.date).toLocaleString()}</dd>
        {#if msg.folder}<dt>Folder</dt><dd>{msg.folder.name}</dd>{/if}
        <dt>Subject</dt><dd>{msg.subject}</dd>
        {#if senderInbox}
          <dt>Group</dt>
          <dd><label class="sender-group">Always put this sender in
            <select class="field" aria-label="Always put {parseAddr(msg.author).email} in" value={senderRule} onchange={(e) => setSenderGroup((e.currentTarget as HTMLSelectElement).value)}>
              <option value="">Let Ember decide</option>
              {#each groupsOf(senderInbox, store.settings) as group (group.id)}<option value={group.id}>{group.label} ({INBOX_LABEL[senderInbox]})</option>{/each}
            </select>
          </label></dd>
        {/if}
      </dl>
    {/if}

    <div class="body">
      {#if inSpamFolder}
        <div class="remote-bar spam-bar" role="status">
          <Icon name="junk" size={16} />
          <span>This email is in Spam.</span>
          <button class="pill sm" onclick={() => spamVerdict(false)}>Not spam</button>
        </div>
      {:else if store.spamAsk(msg)}
        <div class="remote-bar spam-bar" role="status">
          <Icon name="junk" size={16} />
          <span>{store.isJunkGuess(msg) ? "Thunderbird's junk filter thinks this may be spam." : "Ember's AI thinks this may be spam."}</span>
          <button class="pill sm" onclick={() => spamVerdict(true)}>Move to Spam</button>
          <button class="pill sm" onclick={() => spamVerdict(false)}>Not spam</button>
        </div>
      {/if}
      {#if loaded && hasInvitation(loaded.full, loaded.atts)}
        {#await invitationCard() then { default: InvitationCard }}
          <InvitationCard messageId={msg.id} accountId={msg.folder?.accountId} date={msg.date} subject={msg.subject} full={loaded.full} attachments={loaded.atts} />
        {/await}
      {/if}
      {#if loadError}
        <div class="error" role="alert">
          <p>Couldn't load this message from the server. Thunderbird may still be downloading it, or the server is busy.</p>
          <p class="error-detail">{loadError}</p>
          <div class="error-actions">
            <button class="pill sm" onclick={retryLoad}>Try again</button>
            <button class="pill sm ghost" onclick={openInThunderbird}>Open in Thunderbird</button>
          </div>
        </div>
      {:else if !loaded}
        <div class="skeleton" aria-label="Loading message"><span></span><span></span><span style="width:60%"></span></div>
      {:else if inviteOnly}
        <!-- An empty meeting response or invitation: the calendar card above says it all. -->
      {:else if prepared}
        {#if prepared.hasRemote && !allowRemote && !store.settings.loadRemoteImages}
          <div class="remote-bar" role="status">
            <Icon name="image" size={16} />
            <span>Remote images are blocked to protect your privacy.</span>
            <button class="pill sm" onclick={() => (allowRemote = true)}>Load images</button>
          </div>
        {/if}
        {#key dark}
          <HtmlFrame srcdoc={prepared.srcdoc} cid={cidMap} {dark} darkStyle={store.settings.emailDarkMode === "paper" ? "paper" : prepared.darkStyle} title="Message from {displayName(msg.author)}" />
        {/key}
      {:else if bodies?.text !== undefined}
        <div class="plain">{@html textToHtml((historyParts.current.text ?? bodies.text).replace(/\s+$/, ""))}</div>
      {:else if bodies?.html}
        <div class="skeleton"><span></span></div>
      {:else}
        <p class="muted">(This message has no text content.)</p>
      {/if}

      {#if historyParts.hasHistory}
        <div class="history-actions">
          <button class="history-link" disabled={historyBusy} onclick={() => onHistory({ message: msg, history: historyParts.history, cid: cidMap || new Map() })}>
            <Icon name={store.settings.quotedHistoryMode === "panel" ? "historyPanel" : "historyJump"} size={15} />
            {historyBusy ? "Finding original messages…" : store.settings.quotedHistoryMode === "panel" ? "View quoted history" : "View quoted messages"}
          </button>
          {#if store.settings.quotedHistoryMode === "jump"}
            <button class="history-link secondary" onclick={() => onHistory({ message: msg, history: historyParts.history, cid: cidMap || new Map(), forcePanel: true })}>Show quoted text</button>
          {/if}
        </div>
      {/if}

      {#if loaded?.attachmentsPending}<p class="resource-status" role="status">Checking attachments…</p>{/if}
      {#if imagesPending}<p class="resource-status" role="status">Loading inline images…</p>{/if}
      {#if loaded?.attachmentError}
        <div class="error" role="status"><p>Attachments couldn't be loaded: {loaded.attachmentError}</p><button class="pill sm" onclick={retryLoad}>Retry attachments</button></div>
      {/if}
      {#if visibleAtts.length}
        <ul class="atts" aria-label="Attachments">
          {#each visibleAtts as a (a.partName)}
            {@const scan = scanOf(a)}
            <li class="att" class:flagged={scan?.status === "flagged"} oncontextmenu={(e) => attachmentMenu(e, a)}>
              <!-- Images and PDFs preview in Spark (like Spark's quick look); other files open. -->
              <button class="att-main" title={previewKind(a) ? `Preview ${a.name}` : `Open ${a.name}`} onclick={() => guarded(a, previewKind(a) ? "preview" : "open")}>
                {#if thumbs[a.partName]}
                  <img class="att-thumb" src={thumbs[a.partName]} alt="" />
                {:else}
                  <span class="att-ic" aria-hidden="true">
                    <Icon name={attIcon(a)} size={16} />
                    <span class="ext">{ext(a)}</span>
                  </span>
                {/if}
                <span class="att-text">
                  <span class="att-name" title={a.name}>{a.name || "attachment"}</span>
                  <span class="att-size">{fileSize(a.size)}{#if scan}{" · "}<span class="scan-badge {scan.status}" title={scanText(scan)}>{scanBadge(scan)}</span>{/if}</span>
                </span>
              </button>
              {#if scanner.on}
                <button class="icon-btn sm scan {scan?.status || ''}" title={scan ? `${scanText(scan)}${scan.status === "unknown" ? " · Upload it to scan…" : scan.sha256 && !BUSY.includes(scan.status) && scan.status !== "error" ? " · See VirusTotal's report" : ""}` : "Check with VirusTotal"} aria-label="VirusTotal: {scan ? scanText(scan) : 'check'} ({a.name})" onclick={() => scanClick(a)}><Icon name={scanIcon(scan)} size={16} /></button>
              {/if}
              <button class="icon-btn sm" title="Open" aria-label="Open {a.name}" onclick={() => guarded(a, "open")}><Icon name="open" size={16} /></button>
              <button class="icon-btn sm" title="Save" aria-label="Save {a.name}" onclick={() => guarded(a, "save")}><Icon name="download" size={16} /></button>
            </li>
          {/each}
        </ul>
        {#if askOpen}
          {@const r = scanOf(askOpen.a)}
          <div class="scan-ask danger" role="alert">
            <Icon name="shieldAlert" size={18} />
            <p><b>VirusTotal: {scanText(r)}.</b> “{askOpen.a.name}” may be harmful. {askOpen.then === "save" ? "Save" : "Open"} it only if you trust it.</p>
            <button class="pill sm danger" onclick={() => askOpen && guarded(askOpen.a, askOpen.then, true)}>{askOpen.then === "save" ? "Save anyway" : askOpen.then === "preview" ? "Preview anyway" : "Open anyway"}</button>
            {#if r?.sha256}<button class="pill sm" onclick={() => r?.sha256 && api.windows?.openDefaultBrowser?.(reportUrl(r.sha256))}>Report</button>{/if}
            <button class="pill sm" onclick={() => (askOpen = null)}>Cancel</button>
          </div>
        {/if}
        {#if askUpload}
          {@const a = visibleAtts.find((x) => x.partName === askUpload)}
          {#if a}
            <div class="scan-ask" role="alert">
              <Icon name="shield" size={18} />
              <p><b>Upload “{a.name}” to VirusTotal to scan it?</b> VirusTotal hasn't seen this file. Uploaded files are shared with security companies and VirusTotal's paying customers, so don't upload anything confidential.</p>
              <button class="pill sm primary" onclick={() => { const file = a; askUpload = null; void scanner.upload(msg.id, file); }}>Upload</button>
              <button class="pill sm" onclick={() => (askUpload = null)}>Cancel</button>
            </div>
          {/if}
        {/if}
      {/if}
      <!-- Reply, Reply all and Forward live only here, under each open email (R, A and F answer the newest). -->
      {#if expanded}
        <div class="reply-bar">
          <button class="pill" data-action="reply" onclick={() => composer.openReply(msg.id, false)}><Icon name="reply" size={16} /> Reply</button>
          <button class="pill" data-action="replyAll" onclick={() => composer.openReply(msg.id, true)}><Icon name="replyAll" size={16} /> Reply all</button>
          <button class="pill" data-action="forward" onclick={() => composer.openForward(msg.id)}><Icon name="forward" size={16} /> Forward</button>
        </div>
      {/if}
    </div>
  {/if}
</article>

{#if preview}<AttachmentPreview item={preview} onClose={() => (preview = null)} />{/if}
{#if menu}<ContextMenu x={menu.x} y={menu.y} items={menu.items} label={menu.label} onclose={() => (menu = null)} />{/if}

<style>
  .person-ref { display: contents; }
  .spam-bar { border-color: color-mix(in srgb, var(--danger) 35%, transparent); background: color-mix(in srgb, var(--danger) 8%, transparent); }
  .resource-status { color: var(--text-2); font-size: 11px; margin: 8px 0; }
  .history-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; margin: 12px 0 2px; }
  .history-link { display: inline-flex; align-items: center; gap: 6px; color: var(--accent-text); font-size: 12px; padding: 5px 0; }
  .history-link.secondary { color: var(--text-2); }
  .history-link:hover { text-decoration: underline; }
  .msg.history-highlight { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
  .msg {
    background: var(--card);
    border: 1px solid var(--sep);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-sm);
    position: relative;
    transition: box-shadow var(--med) var(--ease);
  }
  .msg + :global(.msg) {
    margin-top: 10px;
  }
  .msg.collapsed:hover {
    box-shadow: var(--shadow);
  }
  .head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 18px;
    text-align: left;
    border-radius: var(--radius-lg);
  }
  .expanded .head {
    padding: 18px 18px 8px;
    align-items: flex-start;
  }
  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .name-line {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }
  .name {
    font-weight: 650;
    font-size: 14.5px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    /* Never shrinks while the address can: even a weighted sub-pixel share would show an ellipsis. */
    flex: 0 0 auto;
    max-width: 100%;
  }
  .email {
    font-size: 12.5px;
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
    flex: 0 1000 auto; /* gives way before the name does */
  }
  .unread-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--unread);
    align-self: center;
    flex: none;
  }
  .to,
  .snip {
    font-size: 13px;
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .when {
    font-size: 12.5px;
    color: var(--text-2);
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: 6px;
    padding-top: 2px;
  }
  .pinned {
    color: var(--star);
  }
  .tools {
    position: absolute;
    right: 14px;
    top: 40px;
    display: flex;
    gap: 2px;
  }
  .details {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 4px 12px;
    margin: 4px 18px 8px 70px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--surface-2);
    font-size: 12.5px;
  }
  .sender-group { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .sender-group select { font: inherit; padding: 2px 6px; }
  .details dt {
    color: var(--text-2);
  }
  .details dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  /* Content spans the card, aligned with the avatar (as in Ember). */
  .body {
    padding: 10px 18px 18px;
  }
  .reply-bar {
    display: flex;
    justify-content: flex-start;
    gap: 8px;
    margin-top: 18px;
  }
  /* Ember's plain-text typography: system font, 14px / 1.57, black (light text on dark). */
  .plain {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Helvetica Neue", Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.57;
    color: var(--email-text);
    padding-top: 4px;
    tab-size: 8;
  }
  .plain :global(blockquote) {
    margin: 6px 0;
    padding-left: 12px;
    border-left: 3px solid var(--sep-strong);
    color: var(--text-2);
    white-space: pre-wrap;
  }
  .plain :global(a) {
    color: var(--email-link);
    text-decoration: underline;
  }
  .plain :global(a:hover) {
    color: #0053cf;
  }
  .remote-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 8px 8px 12px;
    margin-bottom: 10px;
    border-radius: 10px;
    background: var(--accent-softer);
    border: 1px solid var(--accent-soft);
    color: var(--text);
    font-size: 13px;
  }
  .remote-bar > span {
    flex: 1;
  }
  .remote-bar :global(.icon) {
    color: var(--accent-text);
  }
  .pill.sm {
    height: 28px;
    padding: 0 12px;
    font-size: 12.5px;
  }
  .skeleton {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 8px 0;
  }
  .skeleton span {
    height: 12px;
    border-radius: 6px;
    background: linear-gradient(90deg, var(--surface-2), var(--surface-3), var(--surface-2));
    background-size: 200% 100%;
    animation: shimmer 1.2s linear infinite;
  }
  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }
  .error p {
    margin: 0 0 6px;
    color: var(--text);
  }
  .error .error-detail {
    color: var(--text-2);
    font-size: 12px;
  }
  .error-actions {
    display: flex;
    gap: 8px;
    margin-top: 10px;
  }
  .muted {
    color: var(--text-2);
  }
  .atts {
    list-style: none;
    margin: 14px 0 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .att {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 6px 6px 8px;
    border-radius: 12px;
    border: 1px solid var(--sep-strong);
    background: var(--surface-2);
    min-width: 220px;
    max-width: 320px;
  }
  .att-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; text-align: left; border-radius: 8px; }
  .att-main:hover .att-name { text-decoration: underline; }
  .att-ic {
    width: 36px;
    height: 36px;
    border-radius: 9px;
    background: var(--accent-soft);
    color: var(--accent-text);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .att-thumb {
    width: 36px;
    height: 36px;
    border-radius: 9px;
    object-fit: cover;
    flex: none;
    border: 1px solid var(--sep);
  }
  .ext {
    font-size: 8.5px;
    font-weight: 700;
    letter-spacing: 0.03em;
  }
  .att-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .att-name {
    font-size: 13px;
    font-weight: 550;
    /* Two lines before truncating: similar long names ("…-section-07-…") stay distinguishable. */
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    overflow-wrap: anywhere;
    line-height: 1.3;
  }
  .att-size {
    font-size: 12px;
    color: var(--text-2);
  }
  .icon-btn.sm {
    width: 28px;
    height: 28px;
  }
  .att.flagged { border-color: color-mix(in srgb, var(--danger) 55%, transparent); background: color-mix(in srgb, var(--danger) 7%, var(--surface-2)); }
  .scan-badge.clean, .scan.clean { color: var(--success); }
  .scan-badge.flagged, .scan.flagged { color: var(--danger); font-weight: 600; }
  .scan-badge.suspicious, .scan.suspicious { color: var(--warning-text); }
  .scan-badge.error { color: var(--text-3); }
  .scan-ask { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; margin-top: 10px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--sep-strong); background: var(--surface-2); font-size: 12.5px; color: var(--text-2); }
  .scan-ask > :global(svg) { color: var(--accent-text); }
  .scan-ask p { flex: 1 1 260px; margin: 0; line-height: 1.45; }
  .scan-ask b { color: var(--text); font-weight: 600; }
  .scan-ask.danger { border-color: color-mix(in srgb, var(--danger) 45%, transparent); background: color-mix(in srgb, var(--danger) 7%, var(--surface-2)); }
  .scan-ask.danger > :global(svg) { color: var(--danger); }
  .pill.sm.danger { background: var(--danger); color: #fff; border-color: transparent; }
</style>
