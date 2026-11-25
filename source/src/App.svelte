<script lang="ts">
  import { onMount, onDestroy, tick, untrack } from "svelte";
  import { store } from "./lib/store.svelte";
  import { composer } from "./lib/compose.svelte";
  import { api, env } from "./lib/api";
  import Sidebar from "./components/Sidebar.svelte";
  import MessageList from "./components/MessageList.svelte";
  import { perf } from "./lib/perf-recorder";
  import { trimMessages } from "./lib/message-data";
  import { trimInlineImages } from "./lib/inline-images";
  import Attachments from "./components/Attachments.svelte";
  import IgnoredSenders from "./components/IgnoredSenders.svelte";
  import AgentActivity from "./components/AgentActivity.svelte";
  import CalendarPage from "./components/CalendarPage.svelte";
  import CalendarEditor from "./components/CalendarEditor.svelte";
  import { calendar } from "./lib/calendar.svelte";
  import Trip from "./components/Trip.svelte";
  import TripStrip from "./components/TripStrip.svelte";
  import Reader from "./components/Reader.svelte";
  import Composer from "./components/Composer.svelte";
  import MovePicker from "./components/MovePicker.svelte";
  import Toasts from "./components/Toasts.svelte";
  import Welcome from "./components/Welcome.svelte";
  import FollowUpStrip from "./components/FollowUpStrip.svelte";
  import MeetingBriefStrip from "./components/MeetingBriefStrip.svelte";
  import { BRIEF_DAYS, startsIn } from "./lib/meeting-brief";
  import { timeRange } from "./lib/meeting-status";
  import { people } from "./lib/send-checks";
  // Quick filters inside a section, from Clef's signals (AI sorting on).
  // By the kind of section or group (a Work/Personal group's kind: Team and Outside are "people").
  const SIGNAL_FILTERS: Partial<Record<string, { label: string; value: typeof store.signalFilter }[]>> = {
    people: [{ label: "All", value: "" }, { label: "Needs reply", value: "reply" }, { label: "Important", value: "important" }],
    newsletter: [{ label: "All", value: "" }, { label: "Reading", value: "reading" }, { label: "Promotions", value: "promotion" }],
  };
  import OutboxStrip from "./components/OutboxStrip.svelte";
  import SelectionBar from "./components/SelectionBar.svelte";
  import Icon from "./components/Icon.svelte";
  import LockScreen from "./components/LockScreen.svelte";
  import { lock } from "./lib/lock.svelte";
  import type { Conversation } from "./lib/types";
  import { clampSidebar, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, sidebarKey } from "./lib/sidebar-width";

  let systemDark = $state(matchMedia("(prefers-color-scheme: dark)").matches);
  let theme = $derived(store.settings.theme === "system" ? (systemDark ? "dark" : "light") : store.settings.theme);
  let moveTarget = $state<Conversation[] | null>(null);
  /** Settings open in their own window (settings.html), from the background. */
  const openSettings = (section?: string) => void Promise.resolve(api.runtime.sendMessage({ type: "spark:settings", section })).catch(() => {});
  // A list that failed to draw tries again when you switch views (Retry also resets it).
  let listReset: (() => void) | null = null;
  $effect(() => {
    store.view;
    const reset = listReset;
    listReset = null;
    reset?.();
  });
  let searchInput: HTMLInputElement | undefined = $state();
  let fatal = $state<string | null>(null);
  let searchFiltersOpen = $state(false);
  let searchTimer: ReturnType<typeof setTimeout>;
  onDestroy(() => clearTimeout(searchTimer));

  $effect(() => {
    document.documentElement.dataset.theme = theme;
  });

  // Ember's own window draws under its title bar (Spark-style): leave that room at the top of each column.
  let titlebarAsk = 0;
  function fitTitlebar() {
    clearTimeout(titlebarAsk);
    titlebarAsk = window.setTimeout(() => {
      if (typeof api?.sparkWindow?.titlebar !== "function") return;
      void api.sparkWindow.titlebar().then((r: { inset: number }) => document.documentElement.style.setProperty("--titlebar", `${r?.inset || 0}px`)).catch(() => {});
    }, 60);
  }
  onMount(() => {
    fitTitlebar();
    window.addEventListener("resize", fitTitlebar);
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => (systemDark = mq.matches);
    mq.addEventListener("change", on);
    void lock.init();
    store.init().catch((e) => (fatal = e?.message || String(e)));
    composer.watchOutbox();
    const stopBounds = store.trackWindowBounds();
    // Before installing an update the background asks whether Ember is in use: writing, or in front
    // (shown, not minimized, and the focused window) and used in the last half hour. Then it waits
    // (the sidebar offers Update now).
    let lastInput = Date.now();
    const input = () => { lastInput = Date.now(); };
    const inFront = () => document.visibilityState === "visible" && document.hasFocus();
    const inUse = (message: any) => message?.type === "spark:in-use" ? Promise.resolve(composer.open || (inFront() && Date.now() - lastInput < 30 * 60000)) : undefined;
    window.addEventListener("pointerdown", input, true);
    window.addEventListener("keydown", input, true);
    api.runtime.onMessage?.addListener(inUse);
    // Hidden or minimized for a few minutes: release caches that reload quickly (see store.trimMemory).
    let trimTimer: ReturnType<typeof setTimeout> | undefined;
    const onVisibility = () => {
      clearTimeout(trimTimer);
      if (document.visibilityState === "hidden") trimTimer = setTimeout(() => { store.trimMemory(); trimMessages(); trimInlineImages(); }, 3 * 60000);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(trimTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      mq.removeEventListener("change", on); stopBounds();
      window.removeEventListener("pointerdown", input, true); window.removeEventListener("keydown", input, true);
      api.runtime.onMessage?.removeListener(inUse);
    };
  });

  // No search bar until it's wanted: "/" opens it, Esc (or leaving it empty) puts it away.
  let searchOpen = $state(false);
  const tabKind = $derived(store.view.kind === "category" ? store.inboxTabs.find((tab) => tab.id === (store.view as { cat: string }).cat)?.kind || "" : "");
  const searchShown = $derived(searchOpen || (store.view.kind === "search" && !store.view.meeting));
  async function openSearch() {
    searchOpen = true;
    await tick();
    searchInput?.focus();
    searchInput?.select();
  }
  function searchLeft(e: FocusEvent) {
    const next = e.relatedTarget as Node | null;
    if (next && (e.currentTarget as HTMLElement).parentElement?.contains(next)) return;
    if (!store.searchText.trim() && !searchFiltersOpen && store.view.kind !== "search") searchOpen = false;
  }
  $effect(() => {
    if (store.focusSearch) void openSearch();
  });
  // Leaving a search (sidebar, Back) puts the bar away unless something is typed in it.
  $effect(() => {
    if (store.view.kind === "search") return;
    untrack(() => { if (!store.searchText.trim()) { searchOpen = false; searchFiltersOpen = false; } });
  });

  function submitSearch(e: Event) {
    e.preventDefault();
    clearTimeout(searchTimer);
    if (store.searchText.trim() || Object.values(store.searchFilters).some(Boolean)) void store.searchMail(store.searchText);
  }

  function applySearch() {
    clearTimeout(searchTimer);
    if (store.searchText.trim() || Object.values(store.searchFilters).some(Boolean)) void store.searchMail(store.searchText);
    else if (store.view.kind === "search") clearSearch();
  }
  function typeSearch() { clearTimeout(searchTimer); searchTimer = setTimeout(applySearch, 180); }
  function clearSearch() {
    clearTimeout(searchTimer);
    store.searchFilters = {};
    store.searchText = "";
    searchOpen = false;
    searchFiltersOpen = false;
    if (store.view.kind === "search") store.setView(store.homeView());
  }

  function isTyping(t: EventTarget | null) {
    const el = t as HTMLElement | null;
    if (!el) return false;
    return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
  }

  function onKey(e: KeyboardEvent) {
    // Locked (lock.svelte.ts): no shortcut acts on the mail underneath.
    if (lock.covering) return;
    if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && e.key.toLowerCase() === "l" && store.settings.lockEnabled) {
      e.preventDefault();
      void lock.lockNow();
      return;
    }
    if (e.metaKey && !e.shiftKey && !e.altKey && !e.ctrlKey && /^[1-4]$/.test(e.key) && !composer.open) {
      // Like a browser's tabs: ⌘1 and ⌘2 the first two inboxes, ⌘3 Calendar, ⌘4 Attachments (Sidebar.svelte).
      e.preventDefault();
      window.dispatchEvent(new CustomEvent("ember:jump", { detail: Number(e.key) }));
      return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "s") {
      // Handled here (not also by Thunderbird's command key) so it toggles exactly once.
      e.preventDefault();
      void store.switchToThunderbird();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "z" && !isTyping(e.target) && !composer.open) {
      // Undo the last action (archive, delete, move, pin, read/unread). In text fields Ctrl+Z stays text undo.
      e.preventDefault();
      void store.undo();
      return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "l") {
      e.preventDefault();
      void store.savePerformanceReport("shortcut");
      return;
    }
    if (e.metaKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "w" && store.inWindow && env.hasSparkOnly && store.settings.windowMode && store.settings.sparkOnly) {
      // Ember-only mode: ⌘W keeps Ember in the Dock like the close button (the Dock can only restore minimized windows).
      e.preventDefault();
      void api.windows.getCurrent().then((w: any) => api.windows.update(w.id, { state: "minimized" })).catch(() => {});
      return;
    }
    if (e.metaKey && !e.shiftKey && !e.altKey && e.key === ",") {
      e.preventDefault();
      openSettings();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "n") {
      // New message from anywhere, including the search box (Thunderbird's own binding on ⌘N / Ctrl+N).
      e.preventDefault();
      if (!composer.open) composer.openNew();
      return;
    }
    if (composer.open || moveTarget || calendar.editor || document.querySelector(".attachment-preview")) return;
    if (e.key === "Escape" && document.querySelector(".history-panel")) return;
    // ⌘A in a list: pick every conversation in it (bulk actions).
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a" && !isTyping(e.target) && store.navOrder.length && !(e.target as HTMLElement)?.closest?.(".col-reader")) {
      e.preventDefault();
      store.pickAll();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTyping(e.target)) {
      if (e.key === "Escape" && e.target === searchInput) {
        clearSearch();
        searchInput?.blur();
      }
      return;
    }
    if ((e.key === "Enter" || e.key === " ") && (e.target as HTMLElement)?.closest("button")) return;
    const c = store.selected;
    const k = e.key;
    // The picked conversations when there are any (bulk), else the selected one.
    const targets = store.targets(c);
    let handled = true;
    switch (k) {
      case "j":
      case "ArrowDown":
        if (e.shiftKey) store.extendPick(1); else store.move(1);
        break;
      case "k":
      case "ArrowUp":
        if (e.shiftKey) store.extendPick(-1); else store.move(-1);
        break;
      case "J":
        store.extendPick(1);
        break;
      case "K":
        store.extendPick(-1);
        break;
      case "x":
        if (c) store.togglePick(c.key); else handled = false;
        break;
      case "c":
        composer.openNew();
        break;
      case "/":
        void openSearch();
        break;
      case "Escape":
        if (store.picked.size) store.clearPicks();
        else if (store.readerOpen) store.select(store.selected?.key || store.selectedKey, false);
        else if (store.view.kind === "search") clearSearch();
        else if (store.view.kind === "category") store.backToInbox();
        else handled = false;
        break;
      case "Enter":
        if (c) store.select(c.key);
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (!handled && targets.length) {
      handled = true;
      switch (k) {
        case "e":
          store.archive(targets);
          break;
        case "#":
        case "Backspace":
        case "Delete":
          store.trash(targets);
          break;
        case "r":
          if (c) composer.openReply(store.replyTarget(c), false); else handled = false;
          break;
        case "a":
          if (c) composer.openReply(store.replyTarget(c), true); else handled = false;
          break;
        case "f":
          if (c) composer.openForward(store.replyTarget(c)); else handled = false;
          break;
        case "s":
          store.toggleStar(targets);
          break;
        case "u":
          store.toggleRead(targets);
          break;
        case "m":
          moveTarget = targets;
          break;
        default:
          handled = false;
      }
    }
    if (handled) e.preventDefault();
  }

  let convCount = $derived(store.displayedConversationCount);

  // The sidebar's right edge drags its width, like Spark's; saved when let go. Double-click: the usual width.
  let windowWidth = $state(typeof window === "undefined" ? 1280 : window.innerWidth);
  let dragWidth = $state<number | null>(null);
  const sideWidth = $derived(clampSidebar(dragWidth ?? store.settings.sidebarWidth ?? SIDEBAR_DEFAULT, windowWidth));
  function saveSideWidth(width: number) {
    const w = clampSidebar(width, windowWidth);
    if (w !== store.settings.sidebarWidth) store.setSetting("sidebarWidth", w).catch(() => store.toast({ text: "Couldn't save the sidebar's width.", kind: "error" }));
  }
  function startResize(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    try { handle.setPointerCapture(e.pointerId); } catch { /* a pointer that's already gone: the drag still works over the edge */ }
    const startX = e.clientX, startWidth = sideWidth;
    document.documentElement.classList.add("resizing-sidebar");
    const move = (m: PointerEvent) => { dragWidth = clampSidebar(startWidth + m.clientX - startX, windowWidth); };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.documentElement.classList.remove("resizing-sidebar");
      if (dragWidth !== null) saveSideWidth(dragWidth);
      dragWidth = null;
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }
  function resizeKey(e: KeyboardEvent) {
    const next = sidebarKey(sideWidth, e.key, e.shiftKey);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation(); // not the list's arrow keys
    saveSideWidth(next);
  }
</script>

<svelte:window onkeydown={onKey} onresize={() => (windowWidth = window.innerWidth)} />

<div class="app" style:--side-w="{sideWidth}px" class:reader-open={store.readerOpen} class:library-wide={(store.view.kind === "attachments" || store.view.kind === "senders" || store.view.kind === "trip" || store.view.kind === "activity" || store.view.kind === "calendar") && !store.readerOpen}>
  <aside class="col-side">
    <Sidebar onOpenSettings={() => openSettings()} />
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div class="side-resize" class:dragging={dragWidth !== null} role="separator" aria-orientation="vertical" aria-label="Sidebar width"
      aria-valuemin={SIDEBAR_MIN} aria-valuemax={SIDEBAR_MAX} aria-valuenow={sideWidth} tabindex="0"
      title="Drag to resize · double-click for the usual width"
      onpointerdown={startResize} onkeydown={resizeKey} ondblclick={() => saveSideWidth(SIDEBAR_DEFAULT)}></div>
  </aside>

  <main class="col-list" aria-label={store.view.kind === "calendar" ? "Calendar" : "Message list"}>
    {#if store.view.kind === "calendar"}
      <CalendarPage />
    {:else}
    {#if searchShown}
    <div class="search-wrap">
    <form class="search" role="search" onsubmit={submitSearch} onfocusout={searchLeft}>
      <Icon name="search" size={16} />
      <input
        bind:this={searchInput}
        bind:value={store.searchText}
        type="search"
        oninput={typeSearch}
        placeholder="Search saved mail"
        aria-label="Search mail (press / )"
        autocomplete="off" />
      <button type="button" class="search-filter-button" aria-label="Search filters" aria-expanded={searchFiltersOpen} onclick={() => (searchFiltersOpen = !searchFiltersOpen)}>Filters</button>
      {#if store.searchText}
        <button type="button" class="clear" aria-label="Clear search" onclick={clearSearch}><Icon name="x" size={14} /></button>
      {:else}
        <kbd aria-hidden="true">esc</kbd>
      {/if}
    </form>
    {#if searchFiltersOpen}
      <div class="search-filters" role="group" aria-label="Mail search filters">
        <label>Sender<input aria-label="Search sender" placeholder="Name or email" bind:value={store.searchFilters.sender} onchange={() => queueMicrotask(applySearch)} /></label>
        <label>Account<select aria-label="Search account" bind:value={store.searchFilters.accountId} onchange={() => queueMicrotask(applySearch)}><option value="">All accounts</option>{#each store.accounts as node (node.account.id)}<option value={node.account.id}>{store.accountName(node.account.id)}</option>{/each}</select></label>
        <label>From date<input type="date" aria-label="Search from date" bind:value={store.searchFilters.after} onchange={() => queueMicrotask(applySearch)} /></label>
        <label>Through date<input type="date" aria-label="Search through date" bind:value={store.searchFilters.before} onchange={() => queueMicrotask(applySearch)} /></label>
        <label class="check"><input type="checkbox" bind:checked={store.searchFilters.unread} onchange={() => queueMicrotask(applySearch)} /> Unread only</label>
        <label class="check"><input type="checkbox" bind:checked={store.searchFilters.hasAttachments} onchange={() => queueMicrotask(applySearch)} /> Has files</label>
        <button class="pill sm" onclick={() => { store.searchFilters = {}; applySearch(); }}>Clear filters</button>
      </div>
    {/if}
    </div>
    {/if}
    <div class="list-head">
      {#if store.view.kind === "category" || store.view.kind === "search"}
        <button class="icon-btn back" aria-label="Back to inbox" title="Back (Esc)" onclick={() => { store.searchText = ""; store.backToInbox(); }}><Icon name="chevronLeft" /></button>
      {/if}
      <h1>{store.viewTitle}</h1>
      <span class="n" title="Conversations">{store.view.kind !== "attachments" && store.view.kind !== "senders" && store.view.kind !== "trip" && store.view.kind !== "activity" && store.hasLoadedView && !store.cacheStreaming ? convCount.toLocaleString() : ""}</span>
      <span class="grow"></span>
      {#if store.loading}<span class="load-status">{store.view.kind === "attachments" ? "Finding files…" : store.refreshing ? "Refreshing…" : "Loading…"}</span><span class="mini-spin" aria-label={store.refreshing ? "Refreshing" : "Loading"}></span>{/if}
      {#if store.view.kind === "category"}
        <button class="pill sm" onclick={() => store.setRead(store.navOrder, true, true)} disabled={!store.navOrder.some((c) => c.unread)}>Mark all read</button>
      {/if}
      <button class="icon-btn" aria-label="Refresh" title="Refresh" onclick={() => store.view.kind === "attachments" && store.settings.attachmentTab === "links" ? store.loadLinks() : store.refresh()}><Icon name="refresh" size={17} /></button>
    </div>
    {#if store.view.kind === "search" && store.view.meeting}
      {@const brief = store.view.meeting}
      <div class="search-scope brief-scope" role="status">
        <span>{timeRange(brief.start, brief.end)} · {startsIn(brief.start, Date.now())}<small title={brief.people.map((p) => `${p.name} <${p.email}>`).join("\n")}>Recent email with {people(brief.people.map((p) => p.name))} · last {BRIEF_DAYS} days</small></span>
        {#if brief.join}<a class="pill sm" href={brief.join.url} target="_blank" rel="noopener noreferrer"><Icon name="video" size={14} /> Join</a>{/if}
      </div>
    {:else if store.view.kind === "search"}
      <div class="search-scope" role="status">
        <span>{store.view.scope === "all" ? "All Thunderbird mail" : "Saved mail · last 90 days + pins"}{#if store.view.scope !== "all" && store.searchCoverage.indexed < store.searchCoverage.cached}<small>{store.searchCoverage.indexed} / {store.searchCoverage.cached} emails indexed · more results as caching completes</small>{/if}</span>
        <button class="pill sm" onclick={() => store.searchMail(store.searchText, store.view.kind === "search" && store.view.scope === "all" ? "local" : "all")}>{store.view.scope === "all" ? "Search saved mail" : "Search all mail"}</button>
      </div>
    {/if}
    {#if store.isInboxView()}
      <div class="inbox-categories" role="group" aria-label="Inbox categories">
        {#each [{ label: "All", cat: null as string | null }, ...store.inboxTabs.map((tab) => ({ label: tab.label, cat: tab.id }))] as filter (filter.cat ?? "all")}
          <button class="category-filter" aria-pressed={filter.cat ? store.view.kind === "category" && store.view.cat === filter.cat : store.view.kind !== "category"} onclick={() => filter.cat ? store.openCategory(filter.cat) : store.view.kind === "category" && store.backToInbox()}>{filter.label}</button>
        {/each}
      </div>
    {/if}
    {#if (store.settings.aiSort || store.hasMarks()) && store.view.kind === "category" && SIGNAL_FILTERS[tabKind]}
      <div class="signal-filters" role="group" aria-label="Filter {store.sectionLabel(store.view.cat)}">
        {#each SIGNAL_FILTERS[tabKind]! as option (option.value)}
          <button class="signal-filter" aria-pressed={store.signalFilter === option.value} onclick={() => (store.signalFilter = option.value)}>{option.label}</button>
        {/each}
      </div>
    {/if}
    {#if store.isInboxView() && store.view.kind !== "category"}<TripStrip /><MeetingBriefStrip /><OutboxStrip /><FollowUpStrip />{:else if store.view.kind === "mailbox" && (store.view.role === "sent" || store.view.role === "drafts")}<OutboxStrip />{/if}
    {#if store.error && store.hasLoadedView && store.view.kind !== "attachments"}
      <div class="refresh-error" role="status">Couldn't refresh: {store.error} <button class="pill sm" onclick={() => store.refresh()}>Retry</button></div>
    {/if}
    {#if store.view.kind === "attachments"}
      <Attachments />
    {:else if store.view.kind === "senders"}
      <IgnoredSenders />
    {:else if store.view.kind === "activity"}
      <AgentActivity />
    {:else if store.view.kind === "trip"}
      <Trip id={store.view.id} />
    {:else}
      {#if store.pickedConversations.length}<SelectionBar onMove={(convs) => (moveTarget = convs)} />{/if}
      <svelte:boundary onerror={(error, reset) => { listReset = reset; perf.record("error", { text: `list: ${String((error as any)?.message || error)}`.slice(0, 300) }); }}>
        <MessageList onMove={(c) => (moveTarget = c)} />
        {#snippet failed(_error, reset)}
          <div class="list-failed" role="alert">Couldn't show this list. <button class="pill sm" onclick={reset}>Retry</button></div>
        {/snippet}
      </svelte:boundary>
    {/if}
    {/if}
  </main>

  <div class="col-reader">
    <Reader dark={theme === "dark"} onMove={(c) => (moveTarget = c)} />
  </div>
</div>

{#if calendar.editor}
  {#key calendar.editor}<CalendarEditor draft={calendar.editor} />{/key}
{/if}

{#if fatal}
  <div class="fatal" role="alert">
    <h2>Ember couldn't start</h2>
    <p>{fatal}</p>
  </div>
{/if}

<Composer />
{#if moveTarget}
  <MovePicker convs={moveTarget} onClose={() => (moveTarget = null)} />
{/if}
{#if store.accountsKnown && !store.hasMailAccount}
  <!-- Just installed, no mail account yet: a welcome with Thunderbird's account setup, above everything but toasts. -->
  <div class="welcome-cover"><Welcome /></div>
{/if}
<Toasts />
{#if lock.covering}<LockScreen />{/if}

<style>
  .search-filter-button { font-size: 11px; border: 1px solid var(--sep); padding: 3px 6px; border-radius: 5px; color: var(--text-2); }
  .search-filter-button[aria-expanded=true] { color: var(--accent); background: var(--accent-soft); }
  .search-wrap { animation: search-in var(--fast) var(--ease); }
  @keyframes search-in { from { opacity: 0; transform: translateY(-4px); } }
  .search-filters { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 8px 14px 12px; border-bottom: 1px solid var(--sep); font-size: 11px; }
  .search-filters label { display: flex; flex-direction: column; gap: 4px; color: var(--text-2); min-width: 0; }
  .search-filters input:not([type=checkbox]), .search-filters select { min-width: 0; width: 100%; padding: 5px 7px; border: 1px solid var(--sep-strong); background: var(--surface); color: var(--text); border-radius: 5px; font: inherit; }
  .search-filters label.check { flex-direction: row; align-items: center; }
  .search-scope { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 8px 14px; border-bottom: 1px solid var(--sep); font-size: 10px; color: var(--text-2); }
  .search-scope span { min-width: 0; }
  .search-scope small { display: block; margin-top: 4px; }
  .search-scope button { font-size: 10px; flex: none; }
  .brief-scope { font-size: 12.5px; font-weight: 600; color: var(--text); }
  .brief-scope small { font-size: 11.5px; font-weight: 400; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .brief-scope a { flex: none; display: inline-flex; align-items: center; gap: 5px; text-decoration: none; }

  .app {
    height: 100%;
    display: grid;
    /* The list gives way before the reader does: full width from ~1250 px windows, 360 px (all inbox tabs on one row) at the narrowest. */
    grid-template-columns: var(--side-w, 232px) clamp(360px, 32vw, 400px) minmax(0, 1fr);
    background: var(--bg);
  }
  .library-wide .col-list { grid-column: 2 / -1; }
  .library-wide .col-reader { display: none; }
  .col-side { position: relative; }
  /* The edge to drag: wide enough to grab, a thin accent line while hovered, focused or dragged. */
  .welcome-cover { position: fixed; inset: 0; z-index: 90; display: flex; background: var(--bg); }
  .side-resize { position: absolute; top: 0; right: -4px; width: 8px; height: 100%; cursor: col-resize; z-index: 5; touch-action: none; outline: none; }
  .side-resize::after { content: ""; position: absolute; top: 0; bottom: 0; left: 3px; width: 2px; background: transparent; transition: background var(--fast) var(--ease); }
  .side-resize:hover::after, .side-resize:focus-visible::after, .side-resize.dragging::after { background: var(--accent); }
  :global(html.resizing-sidebar), :global(html.resizing-sidebar *) { cursor: col-resize !important; user-select: none !important; }
  .col-side,
  .col-list,
  .col-reader {
    min-width: 0;
    min-height: 0;
    height: 100%;
  }
  /* Under the title bar (the sidebar's own padding carries its colour and edge up there). */
  .col-list,
  .col-reader {
    box-sizing: border-box;
    padding-top: var(--titlebar, 0px);
  }
  .col-reader { background: var(--reader); }
  .col-list {
    display: flex;
    flex-direction: column;
    background: var(--surface);
    border-right: 1px solid var(--sep);
  }
  .search {
    margin: 12px 12px 4px;
    height: 36px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 8px 0 12px;
    border-radius: 10px;
    background: var(--surface-2);
    border: 1px solid var(--sep);
    color: var(--text-2);
    transition: border-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease), background var(--fast) var(--ease);
  }
  .search:focus-within {
    border-color: var(--accent);
    box-shadow: var(--focus);
    background: var(--surface);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    height: 100%;
    font-size: 14px;
    color: var(--text);
  }
  .search input::-webkit-search-cancel-button {
    display: none;
  }
  .search input:focus-visible {
    box-shadow: none;
  }
  .search input::placeholder {
    color: var(--text-2);
  }
  .clear {
    width: 22px;
    height: 22px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--text-2);
  }
  .clear:hover {
    background: var(--hover);
  }
  .list-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px 8px 20px;
    min-height: 48px;
    border-bottom: 1px solid var(--sep);
  }
  .list-head .back {
    margin-left: -10px;
  }
  .list-head h1 {
    font-size: 18px;
    font-weight: 700;
    letter-spacing: -0.015em;
    margin: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .n {
    font-size: 12.5px;
    color: var(--text-2);
    font-variant-numeric: tabular-nums;
  }
  .grow {
    flex: 1;
  }
  .pill.sm {
    height: 28px;
    padding: 0 12px;
    font-size: 12.5px;
  }
  /* One row; if it ever doesn't fit, it scrolls sideways rather than wrapping "Pinned" onto a second line. */
  .inbox-categories { display: flex; flex-wrap: wrap; align-items: center; gap: 1px; padding: 10px 8px; border-bottom: 1px solid var(--sep); }
  .inbox-categories > :global(*) { flex: none; }
  .category-filter { font-size: 11.5px; color: var(--text-2); padding: 5px 6px; border-radius: 7px; }
  .category-filter:hover { background: var(--hover); }
  .category-filter[aria-pressed="true"] { color: var(--accent-text); background: var(--selected); font-weight: 600; }
  .signal-filters { display: flex; gap: 4px; padding: 6px 12px; border-bottom: 1px solid var(--sep); }
  .signal-filter { font-size: 11.5px; color: var(--text-2); padding: 3px 9px; border-radius: 999px; box-shadow: inset 0 0 0 1px var(--sep-strong); }
  .signal-filter:hover { background: var(--hover); }
  .signal-filter[aria-pressed="true"] { color: var(--accent-text); background: var(--selected); box-shadow: none; font-weight: 600; }
  .load-status { font-size: 12px; color: var(--text-2); white-space: nowrap; }
  .list-failed { padding: 16px 12px; color: var(--text-2); font-size: 12.5px; display: flex; align-items: center; gap: 10px; }
  .refresh-error { padding: 8px 12px; color: var(--text-2); font-size: 12px; border-bottom: 1px solid var(--sep); }
  .mini-spin {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid var(--sep-strong);
    border-top-color: var(--accent);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .fatal {
    position: fixed;
    inset: 0;
    display: grid;
    place-content: center;
    text-align: center;
    background: var(--bg);
    color: var(--text);
    z-index: 200;
  }

  /* Narrow windows: two columns; the reader replaces the list when open. */
  @media (max-width: 980px) {
    .app {
      grid-template-columns: min(var(--side-w, 200px), 260px) minmax(0, 1fr);
    }
    .col-reader {
      display: none;
    }
    .app.reader-open .col-list {
      display: none;
    }
    .app.reader-open .col-reader {
      display: block;
    }
  }
  @media (max-width: 640px) {
    .app {
      grid-template-columns: minmax(0, 1fr);
    }
    .library-wide .col-list { grid-column: 1 / -1; }
    .col-side {
      display: none;
    }
  }
</style>
