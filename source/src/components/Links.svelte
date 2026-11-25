<script lang="ts">
  // Attachments → Links: shared files and review links (Dropbox, Google Drive, Frame.io, Vimeo …) in
  // received mail, filtered by the same approved sender domains as files.
  import { untrack } from "svelte";
  import { store } from "../lib/store.svelte";
  import { filterLinks, groupLinks, LINK_SERVICES, type LinkGrouping, type LinkService, type ReceivedLink } from "../lib/link-library";
  import { displayName, fullDate, listDate } from "../lib/format";
  import ApprovedDomains from "./ApprovedDomains.svelte";
  import Icon from "./Icon.svelte";

  let query = $state("");
  let managing = $state(false);
  let copied = $state("");
  // Fresh each time the tab opens (the last list stays shown meanwhile).
  $effect(() => { untrack(() => void store.loadLinks()); });

  const links = $derived(filterLinks(store.links, {
    approvedOnly: store.settings.attachmentApprovedOnly,
    domains: store.settings.approvedAttachmentDomains,
    query,
    service: store.settings.linkService,
  }));
  const services = $derived(LINK_SERVICES.filter((s) => store.links.some((l) => l.link.service === s)));
  const STEP = 150;
  let limit = $state(STEP);
  $effect(() => { query; store.settings.linkService; store.settings.attachmentApprovedOnly; store.settings.approvedAttachmentDomains; store.settings.linkGroupBy; limit = STEP; });
  let sentinel: HTMLElement | undefined = $state();
  $effect(() => {
    const el = sentinel;
    if (!el) return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) limit += STEP; }, { rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  });
  const conversationOf = $derived.by(() => {
    const map = new Map<number, (typeof store.conversations)[number]>();
    if (store.settings.linkGroupBy === "conversation") for (const c of store.conversations) for (const id of c.ids) map.set(id, c);
    return map;
  });
  const allGroups = $derived(groupLinks(links, store.settings.linkGroupBy, (message) => { const c = conversationOf.get(message.id); return { key: c?.key || message.headerMessageId || String(message.id), label: c?.latest.subject || message.subject || "(no subject)" }; }));
  const groups = $derived.by(() => {
    let left = limit;
    const out: typeof allGroups = [];
    for (const group of allGroups) { if (left <= 0) break; out.push(group.links.length <= left ? group : { ...group, links: group.links.slice(0, left) }); left -= group.links.length; }
    return out;
  });

  function save<K extends "linkService" | "linkGroupBy">(k: K, value: any) {
    store.setSetting(k, value).catch(() => store.toast({ text: "Couldn't save this filter.", kind: "error" }));
  }
  function showMessage(item: ReceivedLink) {
    const conversation = store.conversations.find((c) => c.ids.includes(item.message.id));
    if (conversation) store.select(conversation.key);
    else store.openMessage(item.message.id);
  }
  async function copy(item: ReceivedLink) {
    try { await navigator.clipboard.writeText(item.link.url); copied = item.key; setTimeout(() => { if (copied === item.key) copied = ""; }, 1500); }
    catch { store.toast({ text: "Couldn't copy the link.", kind: "error" }); }
  }
  const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };
  const ICON: Partial<Record<LinkService, string>> = { "Frame.io": "video", Vimeo: "video", YouTube: "video", Loom: "video", "Google Photos": "image", iCloud: "image" };
</script>

<section class="library" aria-label="Received links">
  <div class="filters">
    <p class="intro">Shared files and review links received in the last 90 days · All accounts</p>
    <label class="search-files"><Icon name="search" size={16} /><input type="search" placeholder="Find a link, sender or subject" aria-label="Search links" bind:value={query} /></label>
    <ApprovedDomains bind:managing />
    <div class="browse-controls">
      <label>Service<select aria-label="Link service" value={store.settings.linkService} onchange={(e) => save("linkService", e.currentTarget.value as LinkService | "all")}><option value="all">All services</option>{#each services as s (s)}<option value={s}>{s}</option>{/each}{#if store.settings.linkService !== "all" && !services.includes(store.settings.linkService)}<option value={store.settings.linkService}>{store.settings.linkService}</option>{/if}</select></label>
      <label>Group by<select aria-label="Group links" value={store.settings.linkGroupBy} onchange={(e) => save("linkGroupBy", e.currentTarget.value as LinkGrouping)}><option value="none">Newest first</option><option value="service">Service</option><option value="sender">Sender</option><option value="conversation">Conversation</option></select></label>
    </div>
    <div class="summary" role="status" aria-live="polite">
      {links.length.toLocaleString()} {links.length === 1 ? "link" : "links"}
      {#if store.links.length > links.length} · {store.links.length - links.length} hidden by filters{/if}
      {#if store.linksPhase === "loading"} · Finding links…{/if}
    </div>
  </div>

  <div class="file-scroll">
    {#if store.linksPhase === "error"}
      <div class="empty" role="alert"><p>Couldn't find links: {store.linksError}</p><button class="pill" onclick={() => store.loadLinks()}>Try again</button></div>
    {:else if links.length}
      {#each groups as group (group.key)}
        <section class="file-group" aria-label={group.label || "Links"}>
          {#if group.label}<h2 class="file-group-heading">{group.label}<span>{group.links.length}</span></h2>{/if}
          <ul class="files" aria-label="Links">
            {#each group.links as item (item.key)}
              {@const approved = store.settings.approvedAttachmentDomains.includes(item.domain)}
              <li class="file link-row">
                <span class="file-icon"><Icon name={ICON[item.link.service] || "link"} size={21} /><span>{item.link.service.length > 9 ? item.link.service.split(/[ .]/)[0] : item.link.service}</span></span>
                <div class="file-info">
                  <a class="filename" href={item.link.url} target="_blank" rel="noopener noreferrer" title={item.link.url}>{item.title}</a>
                  <div class="sender" title={item.message.author}>{displayName(item.message.author)} <span>· {item.link.kind} · {host(item.link.url)} · <time title={fullDate(item.message.date)}>{listDate(item.message.date)}</time>{#if item.mentions > 1}{` · in ${item.mentions} emails`}{/if}</span></div>
                  <button class="source" title={item.message.subject} onclick={() => showMessage(item)}>{item.message.subject || "(no subject)"}</button>
                  {#if item.domain}<span class="domain" class:trusted={approved}>{item.domain}{approved ? " · Approved" : ""}</span>{/if}
                </div>
                <div class="file-actions">
                  <a class="icon-btn" href={item.link.url} target="_blank" rel="noopener noreferrer" title="Open link" aria-label="Open {item.title}"><Icon name="open" size={17} /></a>
                  <button class="icon-btn" title={copied === item.key ? "Copied" : "Copy link"} aria-label="Copy link to {item.title}" onclick={() => copy(item)}><Icon name={copied === item.key ? "check" : "link"} size={17} /></button>
                  <button class="icon-btn" title="Show source conversation" aria-label="Show email for {item.title}" onclick={() => showMessage(item)}><Icon name="mail" size={17} /></button>
                </div>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
      {#if limit < links.length}<div class="more-files" bind:this={sentinel}>Loading more links… ({limit} of {links.length})</div>{/if}
    {:else}
      <div class="empty">
        <Icon name="link" size={32} />
        {#if store.linksPhase === "loading" || store.linksPhase === "idle"}<h2>Finding your links…</h2><p>The first time, Ember reads your saved mail for links. This can take a moment.</p>
        {:else if store.settings.attachmentApprovedOnly && !store.settings.approvedAttachmentDomains.length}
          <h2>Choose your approved domains</h2><p>Add the sender domains you trust to see their links here.</p><button class="pill" onclick={() => (managing = true)}>Add approved domains</button><button class="pill" onclick={() => store.setSetting("attachmentApprovedOnly", false)}>Show all received links</button>
        {:else}<h2>No matching links</h2><p>{query ? "Try a different name, sender or subject." : "No received links match these filters in the last 90 days."}</p>{/if}
      </div>
    {/if}
  </div>
  <p class="footnote">Dropbox, Google Drive, OneDrive, SharePoint, Box, WeTransfer, iCloud, Frame.io, Vimeo, YouTube, Loom, Figma, Canva, Adobe and Notion links from saved mail. Sent mail, Trash, Spam and quoted replies are left out.</p>
</section>

<style>
  .library { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .filters { padding: 16px 20px 10px; border-bottom: 1px solid var(--sep); }
  .intro { margin: 0 0 14px; color: var(--text-2); font-size: 13px; }
  .search-files { display: flex; align-items: center; gap: 8px; border: 1px solid var(--sep-strong); border-radius: 10px; padding: 8px 12px; background: var(--surface-2); color: var(--text-2); }
  .search-files input { min-width: 0; width: 100%; color: var(--text); background: transparent; border: 0; font: inherit; }
  .browse-controls { display: flex; flex-wrap: wrap; gap: 14px; margin: 8px 0 12px; }
  .browse-controls label { display: flex; align-items: center; gap: 7px; color: var(--text-2); font-size: 12px; }
  .browse-controls select { padding: 5px 8px; border: 1px solid var(--sep-strong); background: var(--surface); color: var(--text); border-radius: 6px; font: inherit; }
  .summary, .footnote { font-size: 12px; color: var(--text-2); }
  .summary { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  .file-scroll { flex: 1; min-height: 0; overflow-y: auto; }
  .file-group-heading { display: flex; justify-content: space-between; gap: 10px; margin: 0; padding: 13px 20px; background: var(--surface-2); border-bottom: 1px solid var(--sep); font-size: 12px; font-weight: 600; }
  .file-group-heading span { color: var(--text-2); }
  .files { list-style: none; padding: 0 20px; margin: 0; }
  .file { display: flex; align-items: center; gap: 14px; padding: 16px 0; border-bottom: 1px solid var(--sep); }
  .file-icon { flex: none; width: 52px; height: 56px; border-radius: 10px; background: var(--surface-2); color: var(--accent); display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 5px; }
  .file-icon span { font-size: 9px; font-weight: 700; max-width: 48px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .filename, .source { text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .filename { font-weight: 650; font-size: 14px; color: var(--text); text-decoration: none; }
  .filename:hover, .source:hover { color: var(--accent); text-decoration: underline; }
  .sender { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sender span, .source, .domain { color: var(--text-2); font-size: 12px; }
  .domain { font-size: 11px; }
  .trusted { color: var(--accent); }
  .file-actions { display: flex; flex: none; justify-content: flex-end; }
  .file-actions a.icon-btn { display: inline-flex; align-items: center; justify-content: center; color: inherit; }
  .more-files { padding: 16px; text-align: center; font-size: 12px; color: var(--text-3); }
  .empty { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 60px 24px; color: var(--text-2); }
  .empty h2 { font-size: 16px; color: var(--text); margin-bottom: 0; }
  .empty p { font-size: 13px; max-width: 350px; line-height: 1.5; }
  .empty .pill { margin-top: 8px; }
  .footnote { margin: 0; padding: 12px 20px; border-top: 1px solid var(--sep); line-height: 1.5; }
</style>
