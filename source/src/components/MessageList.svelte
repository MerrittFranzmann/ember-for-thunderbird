<script lang="ts">
  import { store } from "../lib/store.svelte";
  import { composer } from "../lib/compose.svelte";
  import { listDate, displayName } from "../lib/format";
  import Avatar from "./Avatar.svelte";
  import { BRIEF_DAYS } from "../lib/meeting-brief";
  import { CATEGORY_LABEL } from "../lib/inbox";
  import Icon from "./Icon.svelte";
  import type { Conversation, InboxCategory } from "../lib/types";
  import { navigationKey } from "../lib/view-cache";
  import { responseSubject, responseTally } from "../lib/meeting-subjects";
  import { rowWindow, stableWindow, type RowWindow } from "../lib/virtual-list";
  import { api, mailCache } from "../lib/api";
  import { tick, onDestroy, untrack } from "svelte";

  let { onMove }: { onMove: (c: Conversation[]) => void } = $props();

  const H = { bucket: 40, header: 34, card: 88, conv: 86, older: 64 } as const;
  const OVERSCAN = 6;

  let viewport: HTMLDivElement | undefined = $state();
  let height = $state(600);
  let range = $state<RowWindow>({ start: 0, end: 0 });
  let scrolling = $state(false);
  let scrollFrame = 0;
  let idleTimer: ReturnType<typeof setTimeout>;
  let releaseScroll: (() => void) | undefined;

  let items = $derived(store.items);
  let offsets = $derived.by(() => {
    const o = new Float64Array(items.length + 1);
    for (let i = 0; i < items.length; i++) o[i + 1] = o[i] + H[items[i].type];
    return o;
  });
  let total = $derived(offsets[items.length] || 0);

  function updateWindow() {
    range = stableWindow(range, rowWindow(offsets, viewport?.scrollTop || 0, height, OVERSCAN));
  }

  let visible = $derived(items.slice(range.start, range.end).map((it, k) => ({ it, i: range.start + k })));

  // Preview only the viewport after the gesture settles, not every overscan row.
  let reqTimer: ReturnType<typeof setTimeout>;
  function schedulePreviews() {
    clearTimeout(reqTimer);
    if (scrolling) return;
    reqTimer = setTimeout(() => {
      if (scrolling || !viewport) return;
      const shown = rowWindow(offsets, viewport.scrollTop, height, 0);
      const convs = items.slice(shown.start, shown.end).flatMap((it) => it.type === "conv" ? [it.conv] : it.type === "card" ? it.convs.slice(0, 3) : []);
      store.requestVisible(convs);
    }, 60);
  }

  $effect(() => {
    items; offsets; height; viewport;
    untrack(() => { updateWindow(); schedulePreviews(); });
  });

  // Keep the selected row in view when navigating with the keyboard.
  $effect(() => {
    const requestedKey = store.selectedKey;
    const element = viewport;
    if (!requestedKey || !element) return;
    // Metadata may replace every item object. Only a selection change should
    // reveal the row; scrolling and preview updates must not pull it back.
    untrack(() => {
      const key = store.selected?.key || requestedKey;
      const i = items.findIndex((it) => it.key === key);
      if (i < 0) return;
      const top = offsets[i], bottom = offsets[i + 1];
      if (top < element.scrollTop) element.scrollTop = Math.max(0, top - 8);
      else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight + 8;
    });
  });

  // Restore each visited mailbox/lens to its previous scroll position.
  let restoring = false;
  let scrollRequest = 0;
  onDestroy(() => { scrollRequest++; clearTimeout(reqTimer); clearTimeout(idleTimer); cancelAnimationFrame(scrollFrame); releaseScroll?.(); });
  let lastView = "";
  $effect(() => {
    const v = navigationKey(store.view);
    if (v !== lastView) {
      lastView = v;
      const request = ++scrollRequest;
      restoring = true;
      tick().then(() => {
        if (request !== scrollRequest || !viewport) return;
        viewport.scrollTop = store.listScroll();
        userScrollAt = 0; // the restored position isn't the user scrolling (even right after a shortcut)
        updateWindow();
        setTimeout(() => { if (request === scrollRequest) restoring = false; }, 0);
      });
    }
  });

  $effect(() => {
    const element = viewport;
    if (!element) return;
    const capture = () => { if (lastView) store.saveListScroll(element.scrollTop, lastView); };
    store.captureListScroll = capture;
    return () => { if (store.captureListScroll === capture) store.captureListScroll = undefined; };
  });

  // When the user last scrolled the list themselves (wheel, touch, scrollbar, keys). A restored scroll
  // position isn't the user reaching the end of the list.
  let userScrollAt = 0;
  const userScrolled = () => { userScrollAt = performance.now(); };
  function onScroll() {
    if (!viewport) return;
    if (menu) closeMenu();
    clearTimeout(reqTimer);
    if (!scrolling) {
      scrolling = true;
      store.meta.clearVisible();
      const releaseMeta = store.meta.hold();
      const releaseCache = mailCache.hold();
      releaseScroll = () => { releaseMeta(); releaseCache(); };
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      scrolling = false;
      releaseScroll?.(); releaseScroll = undefined;
      schedulePreviews();
      // Scrolled to the end of the cached 90 days: list older mail once, when the user scrolled there. A short
      // list (older date groups collapsed) always shows its end, and the scroll restored on every visit then
      // listed all older mail each time (seconds of Thunderbird walking the folder); it has a button instead.
      if (performance.now() - userScrollAt < 2000 && items.at(-1)?.type === "older" && range.end >= items.length) void store.loadOlder();
    }, 180);
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      updateWindow();
      if (viewport && !restoring) store.saveListScroll(viewport.scrollTop, lastView);
    });
  }

  /** Several answers to one meeting: "Responses: X" and a tally instead of one person's subject. */
  function responses(c: Conversation): { title: string; tally: string } | null {
    if (c.count < 2) return null;
    const first = responseSubject(c.latest.subject);
    if (!first) return null;
    const subjects = c.ids.map((id) => store.get(id)?.subject || "");
    return subjects.every((s) => responseSubject(s)) ? { title: first.title, tally: responseTally(subjects) } : null;
  }

  function snippet(c: Conversation): string {
    store.metaRev;
    const m = store.get(c.ids[0]);
    let s = (m && store.meta.get(m)?.snippet) || "";
    // Automated mail often repeats the subject (and a masthead) at the top of the body.
    const subj = (c.latest.subject || "").trim();
    if (subj.length > 6) {
      const i = s.indexOf(subj);
      if (i >= 0 && i < 60) s = s.slice(i + subj.length).replace(/^[\s:–—.,;!?|·-]+/, "");
    }
    // …and the sender's name as a masthead.
    const name = displayName(c.latest.author);
    if (name.length > 2 && s.startsWith(name + " ")) s = s.slice(name.length + 1);
    return s;
  }

  function senderLine(c: Conversation): string {
    if (((store.view.kind === "folder" && ["sent", "drafts"].includes(store.roleOfFolder(c.latest.folder?.id) || "")) || (store.view.kind === "mailbox" && ["sent", "drafts"].includes(store.view.role)))) {
      const r = c.latest.recipients?.[0];
      return r ? `To: ${displayName(r)}` : "(no recipients)";
    }
    const s = c.senders.slice(0, 3).join(", ");
    return s || displayName(c.latest.author);
  }

  function open(c: Conversation) {
    if (((store.view.kind === "folder" && store.roleOfFolder(c.latest.folder?.id) === "drafts") || (store.view.kind === "mailbox" && store.view.role === "drafts"))) {
      // The draft itself, not another message of its conversation (sending deletes what was opened as the draft).
      composer.openDraft(c.ids.find((id) => store.roleOfFolder(store.get(id)?.folder?.id) === "drafts") ?? c.ids[0]);
      return;
    }
    store.select(c.key);
  }

  /** ⌘-click picks or unpicks, Shift-click picks a range (bulk actions); a plain click opens one. */
  function rowClick(e: MouseEvent, c: Conversation) {
    if (e.metaKey || e.ctrlKey) { store.togglePick(c.key); return; }
    if (e.shiftKey) { store.pickRange(c.key); return; }
    store.clearPicks();
    open(c);
  }

  /** Open the reply draft an agent wrote for this conversation in Ember's composer. */
  async function openAgentDraft(c: Conversation) {
    const draftId = store.agentDraftOf(c);
    if (!draftId) return;
    const found = await api.messages.query({ headerMessageId: draftId }).catch(() => null);
    const draft = found?.messages?.find((m: any) => store.roleOfFolder(m.folder?.id) === "drafts");
    if (draft) return composer.openDraft(draft.id);
    store.toast({ text: "That reply draft was sent or deleted.", kind: "info" });
    void store.clearAgentDraft(c);
  }

  function cardTitle(cat: string) {
    return CATEGORY_LABEL[cat as InboxCategory] || "Newsletters";
  }

  function cardSenders(convs: Conversation[]) {
    const seen: string[] = [];
    for (const c of convs) {
      const n = displayName(c.latest.author);
      if (!seen.includes(n)) seen.push(n);
      if (seen.length >= 3) break;
    }
    return seen;
  }

  function distinctSenders(convs: Conversation[]) {
    const s = new Set<string>();
    for (const c of convs) s.add(displayName(c.latest.author));
    return s.size;
  }

  function onListKey(e: KeyboardEvent) {
    if ((e.target as HTMLElement)?.closest("button")) return;
    if (e.key === "ArrowDown") {
      store.move(1);
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      store.move(-1);
      e.preventDefault();
    } else if (e.key === "Enter" && store.selected) {
      open(store.selected);
      e.preventDefault();
    }
  }

  // Right-click menu with the row actions (replaces the hover toolbar).
  let menu = $state<{ x: number; y: number; conv: Conversation } | null>(null);
  let menuEl: HTMLDivElement | undefined = $state();
  function openMenu(e: MouseEvent, c: Conversation) {
    e.preventDefault();
    // A picked row's menu acts on every picked conversation; another row's on that row alone.
    if (!store.picked.has(c.key)) store.clearPicks();
    menu = { x: Math.min(e.clientX, innerWidth - 220), y: Math.min(e.clientY, innerHeight - 230), conv: c };
    tick().then(() => {
      // Kept on screen by its real height (it grows with the items that apply).
      const h = menuEl?.offsetHeight || 0;
      if (menu && menu.y + h > innerHeight - 8) menu.y = Math.max(8, innerHeight - h - 8);
      menuEl?.querySelector<HTMLButtonElement>("button")?.focus();
    });
  }
  function closeMenu() { menu = null; }
  // A different view or selection (keyboard, notification, search) leaves no row for the menu.
  $effect(() => { store.view; store.selectedKey; untrack(closeMenu); });
  function act(run: (c: Conversation) => unknown) { const c = menu?.conv; closeMenu(); if (c) run(c); }
  /** What the menu's archive, pin, read, move and delete act on. */
  const menuTargets = $derived(menu ? (store.picked.has(menu.conv.key) ? store.pickedConversations : [menu.conv]) : []);
  function actAll(run: (convs: Conversation[]) => unknown) { const convs = menuTargets; closeMenu(); if (convs.length) run(convs); }
  function menuKey(e: KeyboardEvent) {
    const items = Array.from(menuEl?.querySelectorAll<HTMLButtonElement>("button") || []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") { closeMenu(); viewport?.focus(); }
    else if (e.key === "ArrowDown") items[(i + 1) % items.length]?.focus();
    else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length]?.focus();
    else return;
    e.preventDefault(); e.stopPropagation();
  }

  let activeId = $derived(store.selected ? "row-" + cssId(store.selected.key) : undefined);
  function cssId(k: string) {
    return k.replace(/[^a-zA-Z0-9_-]/g, "_");
  }
</script>

<div
  class="viewport"
  class:scrolling
  bind:this={viewport}
  bind:clientHeight={height}
  onscroll={onScroll}
  onwheel={userScrolled}
  ontouchmove={userScrolled}
  onpointerdown={userScrolled}
  role="listbox"
  tabindex="0"
  aria-label={store.viewTitle}
  aria-activedescendant={activeId}
  onkeydown={onListKey}>
  {#if !items.some((it) => it.type !== "older")}
    <div class="empty">
      {#if store.loading}
        <div class="spinner" aria-hidden="true"></div>
        <p>Loading mail…</p>
      {:else if store.error}
        <p class="err">Couldn't load this view: {store.error}</p>
      {:else if store.view.kind === "search" && store.view.meeting}
        <Icon name="calendar" size={36} stroke={1.3} />
        <p>No email with these people in the last {BRIEF_DAYS} days</p>
      {:else if store.view.kind === "search"}
        <Icon name="search" size={36} stroke={1.3} />
        <p>No results for “{store.view.query}”</p>
      {:else if !store.isInboxView()}
        <div class="zero"><Icon name="folder" size={28} stroke={1.8} /></div>
        <p class="zero-title">{store.olderAvailable ? "Nothing in the last 90 days" : "No emails here"}</p>
        {#if store.olderAvailable}<button class="older" onclick={() => store.loadOlder()}>Show older mail</button>{/if}
      {:else}
        <div class="zero"><Icon name="done" size={30} stroke={2} /></div>
        <p class="zero-title">You're all done</p>
        <p class="zero-sub">Nothing left here. Enjoy the calm.</p>
        {#if store.olderAvailable}<button class="older" onclick={() => store.loadOlder()}>Show mail older than 90 days</button>{/if}
      {/if}
    </div>
  {/if}
  <div class="spacer" style="height:{total}px">
    {#each visible as { it, i } (it.key)}
      {#if it.type === "bucket"}
        <div class="bucket-row" style="transform:translateY({offsets[i]}px)" role="presentation">
          <button class="bucket-toggle" aria-expanded={it.expanded} aria-label="{it.label}, {it.count} conversations" onclick={() => store.toggleTimeBucket(it.bucketId, !it.expanded)}>
            <span class="bucket-chevron" class:closed={!it.expanded}><Icon name="chevronDown" size={13} /></span>
            <span>{it.label}</span><span class="bucket-count">{it.count.toLocaleString()}</span>
          </button>
        </div>
      {:else if it.type === "header"}
        <div class="sec" style="transform:translateY({offsets[i]}px)" role="presentation">
          <span>{it.label}</span>
        </div>
      {:else if it.type === "card"}
        {@const unread = it.unread}
        <div class="card-wrap" style="transform:translateY({offsets[i]}px)" role="presentation">
          <button class="card" class:has-unread={unread > 0} onclick={() => store.openCategory(it.cat)} aria-label="{cardTitle(it.cat)}: {it.convs.length} conversations, {unread} unread">
            <span class="card-ic {it.cat}"><Icon name={it.cat === "notification" ? "bell" : it.cat === "calendar" ? "calendar" : "news"} size={20} /></span>
            <span class="card-body">
              <span class="card-top">
                <span class="card-title">{cardTitle(it.cat)}</span>
                {#if unread}<span class="badge">{unread} new</span>{/if}
                <span class="date">{listDate(it.convs[0].latest.date)}</span>
              </span>
              <span class="card-senders">
                <span class="names">{cardSenders(it.convs).join(", ")}</span>
                {#if distinctSenders(it.convs) > 3}<span class="more">+{distinctSenders(it.convs) - 3}</span>{/if}
              </span>
              <span class="card-sub">{it.convs[0].latest.subject}</span>
            </span>
            <span class="card-chev"><Icon name="chevronRight" size={16} /></span>
          </button>
        </div>
      {:else if it.type === "older"}
        {#if items.length > 1}<!-- an empty list shows this in its empty state instead -->
          <div class="older-row" style="transform:translateY({offsets[i]}px)" role="presentation">
            <button class="older" onclick={() => store.loadOlder()}>Show mail older than 90 days</button>
          </div>
        {/if}
      {:else}
        {@const c = it.conv}
        {@const sel = store.selected?.key === c.key}
        {@const picked = store.picked.has(c.key)}
        {@const answers = responses(c)}
        <div
          id={"row-" + cssId(c.key)}
          class="row"
          class:unread={c.unread > 0}
          class:selected={sel}
          class:picked
          class:picking={store.picked.size > 0}
          class:menu-target={menu?.conv.key === c.key}
          style="transform:translateY({offsets[i]}px)"
          role="option"
          aria-selected={sel || picked}
          tabindex="-1"
          onmousedown={(e) => { if (e.shiftKey) e.preventDefault(); }}
          onclick={(e) => rowClick(e, c)}
          oncontextmenu={(e) => openMenu(e, c)}
          onkeydown={(e) => e.key === "Enter" && open(c)}>
          <span class="dot" class:on={c.unread > 0} aria-hidden="true"></span>
          <span class="avatar-wrap">
            <Avatar from={c.latest.author} cat={c.cat} size={38} />
            <button class="pick" class:on={picked} role="checkbox" aria-checked={picked} aria-label="Select {senderLine(c)}" tabindex="-1" onclick={(e) => { e.stopPropagation(); store.togglePick(c.key); }}><Icon name="check" size={15} stroke={2.6} /></button>
          </span>
          <div class="main">
            <div class="line1">
              <span class="from">{senderLine(c)}</span>
              {#if c.count > 1}<span class="cnt" aria-label="{c.count} messages">{c.count}</span>{/if}
              <span class="meta">
                {#if store.aiRev >= 0 && store.agentDraftOf(c)}<button class="sig draft" title="Open the reply draft an agent wrote" aria-label="Open reply draft" onclick={(e) => { e.stopPropagation(); void openAgentDraft(c); }}>Draft</button>{/if}
                {#if store.aiRev >= 0 && store.spamAsk(c.latest)}<span class="sig spam" title={store.isJunkGuess(c.latest) ? "Thunderbird's junk filter thinks this may be spam: open it to say Spam or Not spam" : "Ember's AI thinks this may be spam: open it to say Spam or Not spam"} aria-label="May be spam">Spam?</span>{/if}
                {#if store.aiRev >= 0 && store.aiSignalOf(c, "important")}<span class="sig important" title="Important (sorted with AI)" aria-label="Important">!</span>{/if}
                {#if store.aiRev >= 0 && store.aiSignalOf(c, "reply")}<span class="sig reply" title="Needs a reply (sorted with AI)" aria-label="Needs a reply"><Icon name="reply" size={12} stroke={2.2} /></span>{/if}
                {#if c.hasAttachment}<span class="att" title="Has attachments"><Icon name="clip" size={14} /></span>{/if}
                {#if c.flagged}<span class="star" title="Pinned"><Icon name="pin" size={14} fill={false} stroke={2} /></span>{/if}
                <span class="date">{listDate(c.latest.date)}</span>
              </span>
            </div>
            <div class="subject">{answers ? `Responses: ${answers.title}` : c.latest.subject || "(no subject)"}</div>
            <div class="snippet">{answers ? answers.tally : snippet(c) || " "}</div>
          </div>
        </div>
      {/if}
    {/each}
  </div>
</div>

<!-- The menu belongs to one row: any outside click, key press (J/K, E…) or window blur dismisses it. -->
<svelte:window onpointerdown={(e) => { if (menu && !menuEl?.contains(e.target as Node)) closeMenu(); }} onkeydowncapture={(e) => { userScrolled(); if (menu && !menuEl?.contains(e.target as Node)) closeMenu(); }} onblur={closeMenu} />
{#if menu}
  {@const c = menu.conv}
  {@const many = menuTargets.length > 1}
  {@const anyUnread = menuTargets.some((x) => x.unread > 0)}
  <div class="context-menu" role="menu" tabindex="-1" aria-label={many ? `Actions for ${menuTargets.length} conversations` : "Conversation actions"} bind:this={menuEl} style="left:{menu.x}px; top:{menu.y}px" onkeydown={menuKey}>
    {#if many}<div class="menu-title">{menuTargets.length} conversations</div>{/if}
    <button role="menuitem" onclick={() => actAll((xs) => store.archive(xs))}><Icon name="done" size={15} stroke={2} /><span>Archive</span><kbd>E</kbd></button>
    <button role="menuitem" onclick={() => actAll((xs) => store.toggleStar(xs))}><Icon name="pin" size={15} /><span>{menuTargets.every((x) => x.flagged) ? "Unpin" : "Pin"}</span><kbd>S</kbd></button>
    {#if !many && store.aiRev >= 0 && store.agentDraftOf(c)}
      <button role="menuitem" onclick={() => act((x) => openAgentDraft(x))}><Icon name="draft" size={15} /><span>Open reply draft</span></button>
    {/if}
    {#if !many && store.isInboxView() && store.view.kind !== "category"}
      {#if store.aiRev >= 0 && store.isTop(c)}
        <button role="menuitem" onclick={() => act((x) => store.removeFromTop(x))}><Icon name="toTop" size={15} /><span>Remove from top</span></button>
      {:else}
        <button role="menuitem" onclick={() => act((x) => store.moveToTop(x))}><Icon name="toTop" size={15} /><span>Move to top</span></button>
      {/if}
    {/if}
    <button role="menuitem" onclick={() => actAll((xs) => store.toggleRead(xs))}><Icon name={anyUnread ? "mailOpen" : "mail"} size={15} /><span>{anyUnread ? "Mark as read" : "Mark as unread"}</span><kbd>U</kbd></button>
    <button role="menuitem" onclick={() => actAll((xs) => onMove(xs))}><Icon name="move" size={15} /><span>Move to…</span><kbd>M</kbd></button>
    {#if menuTargets.every((x) => store.inSpam(x))}
      <button role="menuitem" onclick={() => actAll((xs) => store.notSpam(xs))}><Icon name="inbox" size={15} /><span>Not spam</span></button>
    {:else}
      <button role="menuitem" onclick={() => actAll((xs) => store.markSpam(xs))}><Icon name="junk" size={15} /><span>Mark as spam</span></button>
    {/if}
    {#if !many && store.mailLinkStatus?.url}
      <button role="menuitem" onclick={() => act((x) => store.copyLink(x))}><Icon name="link" size={15} /><span>Copy link</span></button>
    {/if}
    <div class="menu-sep" role="separator"></div>
    <button role="menuitem" class="danger" onclick={() => actAll((xs) => store.trash(xs))}><Icon name="trash" size={15} /><span>Delete</span><kbd>#</kbd></button>
  </div>
{/if}

<style>
  .viewport {
    position: relative;
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
    contain: strict;
  }
  .viewport:focus-visible {
    box-shadow: inset 0 0 0 2px var(--accent-soft);
    border-radius: 0;
  }
  .spacer {
    position: relative;
    width: 100%;
  }
  .bucket-row,
  .sec,
  .card-wrap,
  .row {
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    will-change: transform;
  }
  .bucket-row { height: 40px; }
  .older-row { position: absolute; left: 0; right: 0; top: 0; height: 64px; display: grid; place-items: center; }
  .older { font-size: 12px; color: var(--accent-text); padding: 6px 12px; border-radius: 999px; }
  .older:hover { background: var(--hover); }
  .bucket-toggle { width: 100%; height: 40px; padding: 0 18px; display: flex; align-items: center; gap: 8px; border-bottom: 1px solid var(--sep); color: var(--text-2); font-size: 12px; font-weight: 600; text-align: left; }
  .bucket-toggle:hover { background: var(--hover); }
  .bucket-count { margin-left: auto; font-weight: 500; font-variant-numeric: tabular-nums; }
  .bucket-chevron { display: grid; transition: transform var(--fast) var(--ease); }
  .bucket-chevron.closed { transform: rotate(-90deg); }
  .sec {
    height: 34px;
    display: flex;
    align-items: flex-end;
    padding: 0 20px 6px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--text-2);
  }
  .card-wrap {
    height: 88px;
    padding: 4px 10px;
  }
  .card {
    width: 100%;
    height: 80px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 12px 0 14px;
    border-radius: 12px;
    background: var(--surface-2);
    border: 1px solid var(--sep);
    text-align: left;
    transition: background var(--fast) var(--ease), border-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease);
  }
  .card:hover {
    background: var(--surface-3);
  }
  .card:focus-visible {
    border-radius: 12px;
  }
  .card-ic {
    width: 38px;
    height: 38px;
    border-radius: 11px;
    display: grid;
    place-items: center;
    flex: none;
  }
  .card-ic.notification {
    background: rgba(232, 133, 0, 0.14);
    color: #b05e00;
  }
  .card-ic.newsletter {
    background: rgba(122, 63, 209, 0.13);
    color: #6a33bd;
  }
  :global(:root[data-theme="dark"]) .card-ic.notification {
    background: rgba(255, 170, 60, 0.18);
    color: #ffb85c;
  }
  :global(:root[data-theme="dark"]) .card-ic.newsletter {
    background: rgba(170, 120, 255, 0.2);
    color: #c4a2ff;
  }
  .card-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .card-top {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .card-title {
    font-weight: 650;
    font-size: 14px;
  }
  .badge {
    font-size: 11px;
    font-weight: 650;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--on-accent);
  }
  .card-top .date {
    margin-left: auto;
  }
  .card-senders {
    display: flex;
    gap: 6px;
    font-size: 13px;
    color: var(--text);
    min-width: 0;
  }
  .card-senders .names {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .card-senders .more {
    flex: none;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--text-2);
    background: var(--chip);
    border-radius: 6px;
    padding: 1px 6px;
  }
  .card-sub {
    font-size: 12.5px;
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .card-chev {
    color: var(--text-3);
  }

  .row {
    height: 86px;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 13px 14px 0 8px;
    cursor: default;
    border-radius: 0;
    transition: background var(--fast) var(--ease);
  }
  .row::after {
    content: "";
    position: absolute;
    left: 66px;
    right: 0;
    bottom: 0;
    border-bottom: 1px solid var(--sep);
  }
  .row:hover {
    background: var(--hover);
  }
  .scrolling .row { transition: none; }
  .scrolling .row:not(.selected):hover { background: transparent; }
  .row.selected {
    background: var(--selected);
  }
  .row.picked { background: var(--accent-soft); }
  .avatar-wrap { position: relative; display: inline-flex; flex: none; }
  /* Selecting: on hover the avatar stays, dimmed, with a check over it ("click to select"); while some rows are
   *  picked, every row shows a check box (empty, or filled when picked). */
  .pick { position: absolute; inset: 0; border-radius: 50%; display: none; place-items: center; border: 2px solid rgba(255, 255, 255, 0.85); background: rgba(0, 0, 0, 0.62); color: #fff; }
  .row:hover .pick, .row.picking .pick { display: grid; }
  .row.picking .pick:not(.on) { border-color: var(--sep-strong); background: var(--surface); }
  .row.picking .pick:not(.on) :global(svg) { display: none; }
  .pick.on { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
  .menu-title { padding: 6px 12px 4px; font-size: 11.5px; font-weight: 600; color: var(--text-2); }
  .row.selected::after {
    border-color: transparent;
  }
  /* The conversation a right-click menu acts on (macOS-style ring). */
  .row.menu-target { box-shadow: inset 0 0 0 2px var(--accent); }
  .dot {
    width: 8px;
    height: 8px;
    margin-top: 15px;
    border-radius: 50%;
    flex: none;
  }
  .dot.on {
    background: var(--unread);
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .line1 {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .from {
    font-size: 14px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .row.unread .from {
    font-weight: 700;
  }
  .cnt {
    flex: none;
    font-size: 11px;
    font-weight: 600;
    color: var(--text-2);
    background: var(--chip);
    border-radius: 6px;
    padding: 1px 6px;
  }
  .meta {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 6px;
    flex: none;
    padding-left: 6px;
  }
  .date {
    font-size: 12px;
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .row.unread .date {
    color: var(--accent-text);
    font-weight: 600;
  }
  .sig { flex: none; display: inline-grid; place-items: center; min-width: 16px; height: 16px; padding: 0 3px; box-sizing: border-box; border-radius: 999px; font-size: 10.5px; font-weight: 800; line-height: 1; }
  .sig.important { color: var(--warning-text); background: color-mix(in srgb, var(--warning-text) 16%, transparent); }
  .sig.spam { padding: 0 6px; color: var(--danger); background: color-mix(in srgb, var(--danger) 14%, transparent); }
  .sig.reply { color: var(--accent-text); background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .sig.draft { padding: 0 6px; font-size: 10.5px; font-weight: 700; color: var(--success); background: color-mix(in srgb, var(--success) 14%, transparent); cursor: pointer; }
  .sig.draft:hover { background: color-mix(in srgb, var(--success) 24%, transparent); }
  .att {
    color: var(--text-2);
  }
  .star {
    color: var(--star);
  }
  .subject {
    font-size: 13.5px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .row.unread .subject {
    font-weight: 600;
  }
  .snippet {
    font-size: 13px;
    color: var(--text-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-height: 18px;
  }

  .context-menu {
    position: fixed;
    z-index: 50;
    min-width: 200px;
    padding: 5px;
    border-radius: 10px;
    background: var(--surface);
    border: 1px solid var(--sep-strong);
    box-shadow: var(--shadow-lg);
  }
  .context-menu button {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 6px 9px;
    border-radius: 6px;
    font-size: 13px;
    color: var(--text);
    text-align: left;
  }
  .context-menu button span { flex: 1; }
  .context-menu button:hover,
  .context-menu button:focus-visible { background: var(--hover); box-shadow: none; }
  .context-menu .danger { color: var(--danger); }
  .context-menu kbd { font: 11px var(--font); color: var(--text-3); }
  .menu-sep { height: 1px; margin: 4px 6px; background: var(--sep); }
  .icon-btn.sm {
    width: 28px;
    height: 28px;
  }
  .icon-btn.danger:hover {
    color: var(--danger);
  }

  .empty {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    color: var(--text-2);
    text-align: center;
    padding: 24px;
  }
  .empty p {
    margin: 0;
  }
  .zero {
    width: 64px;
    height: 64px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent-soft);
    color: var(--accent-text);
    margin-bottom: 8px;
  }
  .zero-title {
    font-size: 16px;
    font-weight: 650;
    color: var(--text);
  }
  .zero-sub {
    font-size: 13px;
  }
  .err {
    color: var(--danger);
  }
  .spinner {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 2.5px solid var(--sep-strong);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
