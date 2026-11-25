<script lang="ts">
  import AttachmentPreview from "./AttachmentPreview.svelte";
  import { FILE_KINDS, groupFiles, previewKind, type FileKind, type FileGrouping } from "../lib/attachment-library";
  import { store } from "../lib/store.svelte";
  import { filterAttachments, type ReceivedAttachment } from "../lib/attachments";
  import { openAttachment, saveAttachment } from "../lib/attachment-actions";
  import { displayName, fileSize, fullDate, listDate } from "../lib/format";
  import Icon from "./Icon.svelte";
  import ApprovedDomains from "./ApprovedDomains.svelte";
  import Links from "./Links.svelte";
  import ContextMenu, { type MenuItem } from "./ContextMenu.svelte";
  import { attachmentMenuItems, type FileAction } from "../lib/context-menu";

  let query = $state("");
  let preview = $state<ReceivedAttachment | null>(null);
  let managing = $state(false);
  let busy = $state<Record<string, boolean>>({});
  const files = $derived(filterAttachments(store.attachments, {
    approvedOnly: store.settings.attachmentApprovedOnly,
    domains: store.settings.approvedAttachmentDomains,
    query,
    type: store.settings.attachmentFileType,
  }));
  // Thousands of files would mean tens of thousands of nodes at once: render in steps as the list scrolls.
  const STEP = 150;
  let limit = $state(STEP);
  // Start over only when the filters change (not while a scan adds files below).
  $effect(() => { query; store.settings.attachmentFileType; store.settings.attachmentApprovedOnly; store.settings.approvedAttachmentDomains; store.settings.attachmentGroupBy; limit = STEP; });
  let sentinel: HTMLElement | undefined = $state();
  $effect(() => {
    const el = sentinel;
    if (!el) return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) limit += STEP; }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  });
  // Message → conversation, built once (a search per file is files × conversations on a large mailbox).
  const conversationOf = $derived.by(() => {
    const map = new Map<number, (typeof store.conversations)[number]>();
    if (store.settings.attachmentGroupBy === "conversation") for (const c of store.conversations) for (const id of c.ids) map.set(id, c);
    return map;
  });
  const allGroups = $derived(groupFiles(files, store.settings.attachmentGroupBy, (message) => { const c = conversationOf.get(message.id); return { key: c?.key || message.headerMessageId || String(message.id), label: c?.latest.subject || message.subject || "(no subject)" }; }));
  const groups = $derived.by(() => {
    let left = limit;
    const out: typeof allGroups = [];
    for (const group of allGroups) { if (left <= 0) break; out.push(group.files.length <= left ? group : { ...group, files: group.files.slice(0, left) }); left -= group.files.length; }
    return out;
  });

  async function setting(k: "attachmentApprovedOnly", value: boolean) {
    try { await store.setSetting(k, value); }
    catch { store.toast({ text: "Couldn't save attachment preferences. Try again.", kind: "error" }); }
  }
  function tab(value: "files" | "links") {
    if (value !== store.settings.attachmentTab) void store.setSetting("attachmentTab", value).catch(() => {});
  }
  async function act(item: ReceivedAttachment, action: "open" | "save") {
    const key = `${item.key}:${action}`;
    busy[key] = true;
    try { await (action === "open" ? openAttachment : saveAttachment)(item.message.id, item.attachment); }
    catch (e: any) { store.toast({ text: `Couldn't ${action} ${item.attachment.name}: ${e?.message || e}`, kind: "error" }); }
    finally { busy[key] = false; }
  }
  // Right-click a file (context-menu.ts): Quick Look, Open, Save…, Copy file name, Show the email.
  let menu = $state<{ x: number; y: number; items: MenuItem[]; label: string } | null>(null);
  function fileMenu(e: MouseEvent, item: ReceivedAttachment) {
    e.preventDefault(); e.stopPropagation();
    const a = item.attachment;
    const run = async (action: FileAction) => {
      if (action === "preview") preview = item;
      else if (action === "open" || action === "save") void act(item, action);
      else if (action === "show-email") showMessage(item);
      else if (action === "copy-name") {
        try { await navigator.clipboard.writeText(a.name || "attachment"); store.toast({ text: "File name copied", kind: "success", timeout: 2000 }); }
        catch (error: any) { store.toast({ text: `Couldn't copy: ${error?.message || error}`, kind: "error" }); }
      }
    };
    const items = attachmentMenuItems({ canPreview: !!previewKind(a), inLibrary: true }).map((i) => ({ label: i.label, icon: i.icon, run: () => run(i.action) }));
    menu = { x: e.clientX, y: e.clientY, items, label: `Actions for ${a.name || "attachment"}` };
  }
  function showMessage(item: ReceivedAttachment) {
    const conversation = store.conversations.find((c) => c.ids.includes(item.message.id));
    if (conversation) store.select(conversation.key);
  }
</script>

<div class="library-tabs" role="tablist" aria-label="Attachments">
  <button role="tab" aria-selected={store.settings.attachmentTab !== "links"} onclick={() => tab("files")}><Icon name="clip" size={15} /> Files</button>
  <button role="tab" aria-selected={store.settings.attachmentTab === "links"} onclick={() => tab("links")}><Icon name="link" size={15} /> Links</button>
</div>
{#if store.settings.attachmentTab === "links"}
<Links />
{:else}
<section class="library" aria-label="Received attachments">
  <div class="filters">
    <p class="intro">Files received in the last 90 days · All accounts</p>
    <label class="search-files"><Icon name="search" size={16} /><input type="search" placeholder="Find a file, sender or subject" aria-label="Search attachments" bind:value={query} /></label>
    <ApprovedDomains bind:managing />
    <div class="browse-controls">
      <label>File type<select aria-label="Attachment file type" value={store.settings.attachmentFileType} onchange={(event) => store.setSetting("attachmentFileType", event.currentTarget.value as FileKind | "all").catch(() => store.toast({ text: "Couldn't save file filter.", kind: "error" }))}>{#each FILE_KINDS as [kind, label]}<option value={kind}>{label}</option>{/each}</select></label>
      <label>Group by<select aria-label="Group attachments" value={store.settings.attachmentGroupBy} onchange={(event) => store.setSetting("attachmentGroupBy", event.currentTarget.value as FileGrouping).catch(() => store.toast({ text: "Couldn't save grouping.", kind: "error" }))}><option value="none">Newest first</option><option value="sender">Sender</option><option value="conversation">Conversation</option></select></label>
    </div>
    <div class="summary" role="status" aria-live="polite">
      {files.length.toLocaleString()} {files.length === 1 ? "file" : "files"}
      {#if store.attachments.length > files.length} · {store.attachments.length - files.length} hidden by filters{/if}
      {#if store.loading}
        {#if store.attachmentPhase === "query"} · Finding messages…{:else} · Checked {store.attachmentsScanned} / {store.loadedCount} messages{/if}
        <button class="pill sm" onclick={() => store.stopAttachmentScan()}>Stop scan</button>
      {/if}
    </div>
  </div>

  <div class="file-scroll">
    {#if store.error}
      <div class="empty" role="alert"><p>Couldn't load attachments: {store.error}</p><button class="pill" onclick={() => store.refresh()}>Try again</button></div>
    {/if}
    {#if store.attachmentFailures || store.attachmentDeferred}
      <div class="failure" role="status">{store.attachmentFailures + store.attachmentDeferred} messages couldn't be checked. Showing files found so far. Thunderbird may be offline or busy. <button class="pill sm" onclick={() => store.refresh()}>Retry</button></div>
    {/if}
    {#if store.attachmentStopped}<div class="failure" role="status">Scan stopped. Showing files found so far. <button class="pill sm" onclick={() => store.refresh()}>Resume scan</button></div>{/if}
    {#if files.length}
      {#each groups as group (group.key)}
      <section class="file-group" aria-label={group.label || "Attachment files"}>
      {#if group.label}<h2 class="file-group-heading">{group.label}<span>{group.files.length}</span></h2>{/if}
      <ul class="files" aria-label="Attachment files">
        {#each group.files as item (item.key)}
          {@const a = item.attachment}
          {@const approved = store.settings.approvedAttachmentDomains.includes(item.domain)}
          <li class="file" oncontextmenu={(e) => fileMenu(e, item)}>
            <span class="file-icon"><Icon name={a.contentType.startsWith("image/") ? "image" : "clip"} size={23} /><span>{a.name.split(".").length > 1 ? a.name.split(".").pop()?.slice(0, 7).toUpperCase() : "FILE"}</span></span>
            <div class="file-info">
              <button class="filename" title={a.name} disabled={busy[`${item.key}:open`]} onclick={() => previewKind(a) ? preview = item : act(item, "open")}>{a.name || "Attachment"}</button>
              <div class="sender" title={item.message.author}>{displayName(item.message.author)} <span>· {fileSize(a.size)} · <time title={fullDate(item.message.date)}>{listDate(item.message.date)}</time></span></div>
              <button class="source" title={item.message.subject} onclick={() => showMessage(item)}>{item.message.subject || "(no subject)"}</button>
              {#if item.domain}<span class="domain" class:trusted={approved}>{item.domain}{approved ? " · Approved" : ""}</span>{/if}
            </div>
            <div class="file-actions">
              {#if previewKind(a)}<button class="icon-btn" title="Preview attachment" aria-label="Preview {a.name}" onclick={() => (preview = item)}><Icon name="search" size={17} /></button>{/if}
              <button class="icon-btn" title="Open attachment" aria-label="Open {a.name}" disabled={busy[`${item.key}:open`]} onclick={() => act(item, "open")}><Icon name="open" size={17} /></button>
              <button class="icon-btn" title="Save attachment" aria-label="Save {a.name}" disabled={busy[`${item.key}:save`]} onclick={() => act(item, "save")}><Icon name="download" size={17} /></button>
              <button class="icon-btn" title="Show source conversation" aria-label="Show email for {a.name}" onclick={() => showMessage(item)}><Icon name="mail" size={17} /></button>
            </div>
          </li>
        {/each}
      </ul>
      </section>
      {/each}
      {#if limit < files.length}<div class="more-files" bind:this={sentinel}>Loading more files… ({limit} of {files.length})</div>{/if}
    {:else if !store.error}
      <div class="empty">
        <Icon name="clip" size={32} />
        {#if store.settings.attachmentApprovedOnly && !store.settings.approvedAttachmentDomains.length}
          <h2>Choose your approved domains</h2><p>Add the sender domains you trust to see their files here.</p><button class="pill" onclick={() => (managing = true)}>Add approved domains</button><button class="pill" onclick={() => setting("attachmentApprovedOnly", false)}>Show all received files</button>
        {:else if store.loading}<h2>Finding your files…</h2><p>Files appear as they are found. You can stop and resume the scan.</p>
        {:else}<h2>No matching attachments</h2><p>{query ? "Try a different filename, sender or subject." : "No received files match these filters in the last 90 days."}</p>{/if}
      </div>
    {/if}
  </div>
  <p class="footnote">Sent mail, drafts, Trash, Spam and inline images are excluded.</p>
</section>
{/if}

{#if preview}<AttachmentPreview item={preview} onClose={() => (preview = null)} onSource={() => { if (preview) showMessage(preview); preview = null; }} />{/if}
{#if menu}<ContextMenu x={menu.x} y={menu.y} items={menu.items} label={menu.label} onclose={() => (menu = null)} />{/if}

<style>
  .library-tabs { display: flex; gap: 4px; padding: 10px 20px 0; border-bottom: 1px solid var(--sep); }
  .library-tabs button { display: flex; align-items: center; gap: 6px; padding: 7px 12px 9px; font-size: 13px; color: var(--text-2); border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .library-tabs button[aria-selected="true"] { color: var(--text); font-weight: 600; border-bottom-color: var(--accent); }
  .library-tabs button:hover { color: var(--text); }
  .more-files { padding: 16px; text-align: center; font-size: 12px; color: var(--text-3); }
  .browse-controls { display: flex; flex-wrap: wrap; gap: 14px; margin: 8px 0 12px; }
  .browse-controls label { display: flex; align-items: center; gap: 7px; color: var(--text-2); font-size: 12px; }
  .browse-controls select { padding: 5px 8px; border: 1px solid var(--sep-strong); background: var(--surface); color: var(--text); border-radius: 6px; font: inherit; }
  .file-group-heading { display: flex; justify-content: space-between; gap: 10px; margin: 0; padding: 13px 20px; background: var(--surface-2); border-bottom: 1px solid var(--sep); font-size: 12px; font-weight: 600; }
  .file-group-heading span { color: var(--text-2); }
  .library { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .filters { padding: 16px 20px 10px; border-bottom: 1px solid var(--sep); }
  .intro { margin: 0 0 14px; color: var(--text-2); font-size: 13px; }
  .search-files { display: flex; align-items: center; gap: 8px; border: 1px solid var(--sep-strong); border-radius: 10px; padding: 8px 12px; background: var(--surface-2); color: var(--text-2); }
  input:not([type=checkbox]) { min-width: 0; width: 100%; color: var(--text); background: transparent; border: 0; font: inherit; }
  .summary { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  .empty .pill { margin-top: 8px; }
  .summary, .footnote { font-size: 12px; color: var(--text-2); }
  .file-scroll { flex: 1; min-height: 0; overflow-y: auto; }
  .files { list-style: none; padding: 0 20px; margin: 0; }
  .file { display: flex; align-items: center; gap: 14px; padding: 18px 0; border-bottom: 1px solid var(--sep); }
  .file-icon { flex: none; width: 52px; height: 62px; border-radius: 10px; background: var(--surface-2); color: var(--accent); display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 5px; }
  .file-icon span { font-size: 9px; font-weight: 700; }
  .file-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .filename, .source { text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .filename { font-weight: 650; font-size: 14px; }
  .filename:hover, .source:hover { color: var(--accent); text-decoration: underline; }
  .sender { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sender span, .source, .domain { color: var(--text-2); font-size: 12px; }
  .domain { font-size: 11px; }
  .trusted { color: var(--accent); }
  .file-actions { display: flex; flex: none; justify-content: flex-end; }
  .empty { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 60px 24px; color: var(--text-2); }
  .empty h2 { font-size: 16px; color: var(--text); margin-bottom: 0; }
  .empty p { font-size: 13px; max-width: 350px; line-height: 1.5; }
  .failure { padding: 12px 20px; background: var(--surface-2); font-size: 13px; }
  .footnote { margin: 0; padding: 12px 20px; border-top: 1px solid var(--sep); }
</style>
