<script lang="ts">
  import { store } from "../lib/store.svelte";
  import HistoryPanel from "./HistoryPanel.svelte";
  import { loadMessageBody } from "../lib/message-data";
  import { extractBodies, splitMessageHistory } from "../lib/body";
  import { quotedOriginalIds, type QuotedHistoryRequest } from "../lib/quoted-history";
  import { withDeadline } from "../lib/async";
  import { api, env } from "../lib/api";
  import { saveConversationPdf } from "../lib/thread-pdf-export";
  import MessageView from "./MessageView.svelte";
  import Icon from "./Icon.svelte";
  import AgentLine from "./AgentLine.svelte";
  import EmailEventStrip from "./EmailEventStrip.svelte";
  import { calendar } from "../lib/calendar.svelte";
  import type { Conversation, MessageHeader } from "../lib/types";
  import { tick, untrack, onDestroy } from "svelte";
  import { perf } from "../lib/perf-recorder";

  let { dark, onMove }: { dark: boolean; onMove: (c: Conversation[]) => void } = $props();

  let conv = $derived(store.readerOpen ? store.selected : null);
  let messages = $state<MessageHeader[]>([]); // oldest → newest
  let eventStrip = $state<ReturnType<typeof EmailEventStrip> | null>(null);
  let expanded = $state<Record<number, boolean>>({});
  // Long threads fold their middle into one "N more messages" row (as Ember and Gmail do): the first
  // message, the last three, and anything expanded or highlighted stay visible.
  let unfolded = $state(false);
  // Messages the user opened or closed stay out of the fold (collapsing one shouldn't make it vanish).
  let touched = $state(new Set<number>());
  type ThreadRow = { kind: "msg"; m: MessageHeader } | { kind: "fold"; key: string; count: number };
  const rows = $derived.by((): ThreadRow[] => {
    const all = messages.map((m): ThreadRow => ({ kind: "msg", m }));
    if (unfolded || messages.length < 8) return all;
    const keep = (i: number) => i === 0 || i >= messages.length - 3 || !!expanded[messages[i].id] || touched.has(messages[i].id) || highlighted.includes(messages[i].id);
    const out: ThreadRow[] = [];
    let run: MessageHeader[] = [];
    const flush = () => {
      if (run.length >= 4) out.push({ kind: "fold", key: `fold:${run[0].id}`, count: run.length });
      else for (const m of run) out.push({ kind: "msg", m });
      run = [];
    };
    messages.forEach((m, i) => { if (keep(i)) { flush(); out.push({ kind: "msg", m }); } else run.push(m); });
    flush();
    return out;
  });
  let scroller: HTMLDivElement | undefined = $state();
  let loadedKey = "";
  let loadedIds = "";
  let request = 0;
  let resolving = $state(false);
  let bodyReady = $state(false);
  let discovering = $state(false);
  let discoveryError = $state("");
  let discoveryComplete = $state(false);
  let markTimer: any;
  let historyPanel = $state<QuotedHistoryRequest | null>(null);
  let historyFallback = $state(false);
  let historyBusy = $state<number | null>(null);
  let highlighted = $state<number[]>([]);
  let historyToken = 0;

  function resetHistory() { historyToken++; historyPanel = null; historyBusy = null; highlighted = []; }
  function closeHistory() {
    const id = historyPanel?.message.id;
    historyPanel = null;
    tick().then(() => scroller?.querySelector<HTMLButtonElement>(`[data-message-id="${id}"] .history-link`)?.focus());
  }
  async function showHistory(payload: QuotedHistoryRequest) {
    const token = ++historyToken;
    historyBusy = null;
    if (payload.forcePanel || store.settings.quotedHistoryMode === "panel") {
      highlighted = [];
      historyFallback = false;
      historyPanel = payload;
      return;
    }
    historyPanel = null;
    historyBusy = payload.message.id;
    const deadline = Date.now() + 8000;
    const older = messages.filter((message) => +new Date(message.date) < +new Date(payload.message.date) || (+new Date(message.date) === +new Date(payload.message.date) && message.id < payload.message.id));
    const originals: { id: number; body: import("../lib/body").Bodies }[] = [];
    let next = 0;
    const worker = async () => {
      while (token === historyToken && Date.now() < deadline && next < older.length) {
        const message = older[next++];
        try {
          const full = await withDeadline(loadMessageBody(api, message.id), Math.max(1, deadline - Date.now()), undefined, "Original message");
          if (token !== historyToken) return;
          originals.push({ id: message.id, body: splitMessageHistory(extractBodies(full)).current });
        } catch { /* Unavailable originals fall back to the exact quoted text. */ }
      }
    };
    await Promise.all([worker(), worker()]);
    if (token !== historyToken) return;
    historyBusy = null;
    const matches = quotedOriginalIds(payload.history, originals);
    if (!matches.length) { historyFallback = true; historyPanel = payload; return; }
    historyPanel = null;
    highlighted = matches;
    for (const id of matches) expanded[id] = true;
    await tick();
    const first = messages.find((message) => matches.includes(message.id));
    const card = first && scroller?.querySelector(`[data-message-id="${first.id}"]`) as HTMLElement | null;
    if (card && scroller) {
      scroller.scrollTop += card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16;
      card.querySelector("button")?.focus({ preventScroll: true });
    }
  }

  $effect(() => { store.settings.quotedHistoryMode; untrack(resetHistory); });

  // Load the conversation (including related messages from Sent/Archive) when selection changes.
  $effect(() => {
    const c = conv;
    const revision = store.readerRev;
    const own = c ? store.headersOf(c).slice().reverse() : [];
    untrack(() => apply(c, own, revision));
  });

  // Read state changes without a regroup (store.readRev): copy it into the shown messages.
  $effect(() => {
    store.readRev;
    untrack(() => {
      if (messages.some((m) => { const live = store.get(m.id); return !!live && live.read !== m.read; }))
        messages = messages.map((m) => { const live = store.get(m.id); return live && live.read !== m.read ? { ...m, read: live.read } : m; });
    });
  });
  const convUnread = $derived.by(() => { store.readRev; return conv?.unread ?? 0; });

  onDestroy(() => { clearTimeout(markTimer); request++; historyToken++; });

  function apply(c: Conversation | null, own: MessageHeader[], revision: number) {
    if (!c) {
      resetHistory();
      clearTimeout(markTimer);
      request++;
      messages = [];
      expanded = {};
      unfolded = false;
      touched = new Set();
      loadedKey = loadedIds = "";
      resolving = false;
      bodyReady = false;
      discovering = false;
      discoveryError = "";
      discoveryComplete = false;
      return;
    }
    const changed = c.key !== loadedKey;
    perf.record("reader.apply", { changed, messages: own.length });
    if (changed) {
      resetHistory();
      clearTimeout(markTimer);
      loadedKey = c.key;
      messages = [];
      expanded = {};
      unfolded = false;
      touched = new Set();
      bodyReady = false;
      discovering = false;
      discoveryError = "";
      discoveryComplete = false;
    }
    const previous = new Set(messages.map((m) => m.id));
    const byId = new Map(messages.map((m) => [m.id, m]));
    for (const m of messages) { const live = store.get(m.id); if (live) byId.set(m.id, live); }
    for (const m of own) byId.set(m.id, m);
    messages = Array.from(byId.values()).map((m) => ({ ...m })).sort((a, b) => +new Date(a.date) - +new Date(b.date) || a.id - b.id);
    for (const m of messages) {
      if (!previous.has(m.id) && (m.read === false || m.id === newest()?.id)) expanded[m.id] = true;
    }
    const signature = `${c.key}:${c.ids.join(",")}:${revision}`;
    if (signature !== loadedIds) {
      loadedIds = signature;
      const current = ++request;
      discovering = false;
      resolving = true;
      if (changed) tick().then(scrollToNewest);
      // Start the selected body before scanning/hydrating other messages.
      const latest = messages.at(-1);
      const ready = latest ? loadMessageBody(api, latest.id).catch(() => undefined) : Promise.resolve();
      ready.then(() => {
        if (current !== request) return;
        bodyReady = true;
        return new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 60);
          requestAnimationFrame(() => setTimeout(() => { clearTimeout(timer); resolve(); }, 0));
        });
      }).then(() => current === request ? store.relatedMessages(c, () => current === request) : []).then((all) => {
        if (current !== request || loadedKey !== c.key) return;
        const oldIds = new Set(messages.map((m) => m.id));
        // Replace even when counts match: moves and regrouping can replace message IDs.
        messages = all.slice().reverse().map((m) => ({ ...m }));
        for (const m of messages) {
          if (!oldIds.has(m.id) && (m.read === false || m.id === newest()?.id)) expanded[m.id] = true;
        }
        if (changed) tick().then(scrollToNewest);
      }).finally(() => {
        if (current !== request) return;
        resolving = false;
        scheduleMarkRead(c!);
      });
    }
  }

  async function findOlderReplies() {
    const c = conv;
    if (!c || discovering) return;
    const current = ++request;
    discovering = true;
    discoveryError = "";
    try {
      const all = await store.discoverRelatedMessages(c, () => current === request);
      if (current !== request || loadedKey !== c.key) return;
      const previous = new Set(messages.map((m) => m.id));
      messages = all.slice().reverse().map((m) => ({ ...m }));
      for (const m of messages) if (!previous.has(m.id)) expanded[m.id] = m.read === false || m.id === newest()?.id;
      discoveryComplete = true;
    } catch (error: any) {
      if (current === request) discoveryError = error?.message || "Couldn't find older replies. Try again.";
    } finally {
      if (current === request) { discovering = false; resolving = false; scheduleMarkRead(c); }
    }
  }

  function scheduleMarkRead(c: Conversation) {
    clearTimeout(markTimer);
    if (!store.settings.autoMarkRead || !messages.some((m) => m.read === false)) return;
    markTimer = setTimeout(() => {
      if (store.readerOpen && store.selected?.key === c.key) store.setRead([store.selected], true);
    }, store.settings.markReadDelay);
  }

  function expandAll(value: boolean) {
    if (value) unfolded = true;
    expanded = Object.fromEntries(messages.map((m) => [m.id, value]));
  }

  function scrollToNewest() {
    if (!scroller) return;
    const last = scroller.querySelector(".thread > :last-child") as HTMLElement | null;
    if (messages.length > 1 && last) scroller.scrollTop = Math.max(0, last.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 16);
    else scroller.scrollTop = 0;
  }

  let folderNames = $derived.by(() => {
    const s = new Set<string>();
    for (const m of messages) if (m.folder?.name) s.add(m.folder.name);
    return Array.from(s);
  });

  function newest() {
    return messages[messages.length - 1];
  }

  let pdfBusy = $state(false);
  async function savePdf() {
    const c = conv;
    if (!c || pdfBusy || !messages.length) return;
    pdfBusy = true;
    const progress = store.toast({ text: `Making a PDF of ${messages.length === 1 ? "this email" : `${messages.length} emails`}…`, kind: "info", timeout: 120000 });
    try { await saveConversationPdf(c.latest.subject || "", messages); }
    catch (e: any) { store.toast({ text: `Couldn't save the PDF: ${e?.message || e}`, kind: "error" }); }
    finally { store.dismiss(progress); pdfBusy = false; }
  }

  // A follow-up reminder on one of these (sent) emails.
  const followUp = $derived(messages.map((m) => m.headerMessageId && store.followUps[m.headerMessageId.replace(/^<|>$/g, "")]).find(Boolean) || null);
</script>

<section class="reader" aria-label="Conversation">
  {#if conv}
    <header class="bar">
      <div class="actions" role="toolbar" aria-label="Conversation actions">
        <button class="icon-btn" title="Done — archive (E)" aria-label="Archive" onclick={() => store.archive([conv])}><Icon name="done" stroke={2} /></button>
        <button class="icon-btn" title="Delete (#)" aria-label="Delete" onclick={() => store.trash([conv])}><Icon name="trash" /></button>
        <button class="icon-btn" title="Move to… (M)" aria-label="Move to folder" onclick={() => onMove([conv])}><Icon name="move" /></button>
        <span class="sep" aria-hidden="true"></span>
        <button class="icon-btn" title="Pin (S)" aria-label={conv.flagged ? "Unpin" : "Pin"} aria-pressed={conv.flagged} onclick={() => store.toggleStar([conv])}><Icon name="pin" /></button>
        <button class="icon-btn" title={convUnread ? "Mark as read (U)" : "Mark as unread (U)"} aria-label={convUnread ? "Mark as read" : "Mark as unread"} onclick={() => store.toggleRead([conv])}><Icon name={convUnread ? "mailOpen" : "mail"} /></button>
      </div>
      <div class="actions right">
        {#if calendar.available}<button class="icon-btn" title="Create an event from this email" aria-label="Create event" onclick={() => eventStrip?.createEvent()}><Icon name="calendar" /></button>{/if}
        {#if env.hasPdf}<button class="icon-btn" title="Save conversation as PDF" aria-label="Save conversation as PDF" disabled={pdfBusy} onclick={savePdf}><Icon name="download" /></button>{/if}
        <button class="icon-btn close" title="Close (Esc)" aria-label="Close conversation" onclick={() => store.select(store.selected?.key || store.selectedKey, false)}><Icon name="x" /></button>
      </div>
    </header>

    <div class="reader-workspace">
    <div class="scroll" bind:this={scroller}>
      <div class="inner">
        <h1 class="subject">{conv.latest.subject || "(no subject)"}</h1>
        <AgentLine {conv} />
        <EmailEventStrip {conv} latest={messages.at(-1)} bind:this={eventStrip} />
        <div class="chips">
          {#each folderNames as f (f)}<span class="chip">{f}</span>{/each}
          {#if messages.length > 1}<span class="chip soft">{messages.length} messages</span>{/if}
        </div>
        <div class="thread-controls">
          <span>{discovering ? "Finding older replies…" : resolving ? "Loading saved replies…" : messages.length > 1 ? "Oldest to newest" : ""}</span>
          <div>
            {#if store.settings.groupConversations}
              <button class="text-action" disabled={discovering || resolving || !bodyReady} title="Search all folders for older replies that aren't saved locally" onclick={findOlderReplies}>{discovering ? "Searching…" : discoveryComplete ? "Check for more replies" : "Find older replies"}</button>
            {/if}
            {#if messages.length > 1}
              <button class="text-action" onclick={() => expandAll(true)}>Expand all</button>
              <button class="text-action" onclick={() => expandAll(false)}>Collapse all</button>
            {/if}
            {#if messages.length > 1 || highlighted.length}
              <button class="text-action" onclick={() => { highlighted = []; scrollToNewest(); }}>{highlighted.length ? "Back to latest reply" : "Latest"}</button>
            {/if}
          </div>
        </div>
        {#if followUp}
          <p class="follow-note" role="status">
            <Icon name="bell" size={14} />
            {followUp.state === "due" ? "No reply yet." : `Reminder if no reply by ${new Date(followUp.dueAt).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.`}
            <button class="text-action" onclick={() => store.cancelFollowUp(followUp.mid)}>{followUp.state === "due" ? "Dismiss" : "Cancel reminder"}</button>
          </p>
        {/if}
        {#if discoveryError}<p class="discovery-error" role="status">{discoveryError} <button class="text-action" onclick={findOlderReplies}>Retry</button></p>{/if}
        <div class="thread" aria-busy={!bodyReady} data-related-busy={resolving || discovering}>
          {#each rows as row (row.kind === "msg" ? row.m.id : row.key)}
            {#if row.kind === "msg"}
              {@const m = row.m}
              <MessageView msg={m} {dark} onHistory={showHistory} historyBusy={historyBusy === m.id} highlighted={highlighted.includes(m.id)} expanded={!!expanded[m.id]} onToggle={() => { expanded[m.id] = !expanded[m.id]; touched = new Set(touched).add(m.id); perf.record("message.toggle", { expanded: expanded[m.id] }); }} />
            {:else}
              <button class="fold" onclick={() => { unfolded = true; }}><span>{row.count} more messages</span></button>
            {/if}
          {/each}
        </div>
      </div>
    </div>
    {#if historyPanel}<HistoryPanel history={historyPanel} fallback={historyFallback} onClose={closeHistory} />{/if}
    </div>
  {:else}
    <div class="placeholder">
      <div class="ph-icon"><Icon name="mail" size={34} stroke={1.3} /></div>
      <p class="ph-title">No conversation selected</p>
      <p class="ph-sub">Pick a conversation, or press <kbd>J</kbd> / <kbd>K</kbd> to move and <kbd>⌃N</kbd> to compose.</p>
    </div>
  {/if}
</section>

<style>
  .reader {
    height: 100%;
    position: relative;
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    background: var(--reader);
    min-width: 0;
  }
  .bar {
    height: 52px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px;
    border-bottom: 1px solid var(--sep);
    background: var(--reader);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .sep {
    width: 1px;
    height: 18px;
    background: var(--sep-strong);
    margin: 0 6px;
  }
  .reader-workspace { display: flex; flex: 1; min-height: 0; min-width: 0; }
  .scroll {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
  }
  .inner {
    padding: 22px 28px 40px;
  }
  .subject {
    font-size: 22px;
    line-height: 1.25;
    font-weight: 700;
    letter-spacing: -0.015em;
    margin: 0 0 8px;
    overflow-wrap: anywhere;
  }
  .chips {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-bottom: 18px;
  }
  .discovery-error { color: var(--text-2); font-size: 12px; }
  .follow-note { display: flex; align-items: center; gap: 6px; margin: 0 0 10px; padding: 7px 10px; border-radius: 9px; font-size: 12.5px; color: var(--accent-text); background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .chip {
    font-size: 11.5px;
    font-weight: 600;
    padding: 3px 9px;
    border-radius: 999px;
    background: var(--chip);
    color: var(--text-2);
  }
  .chip.soft {
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--sep-strong); /* an outline that doesn't add height */
  }
  .thread :global(.msg + .msg) {
    margin-top: 10px;
  }
  .fold {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    margin: 10px 0;
    padding: 0;
    border: 0;
    background: none;
    color: var(--text-2);
    font: 500 12.5px var(--font);
    cursor: pointer;
  }
  .fold::before, .fold::after { content: ""; flex: 1; height: 1px; background: var(--sep-strong); }
  .fold span { padding: 5px 12px; border-radius: 999px; box-shadow: inset 0 0 0 1px var(--sep-strong); background: var(--reader); }
  .fold:hover span { color: var(--text); background: var(--hover); }
  .thread-controls { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; color: var(--text-2); font-size: 12px; }
  .thread-controls > div { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px 12px; }
  .text-action { color: var(--accent); font-size: 12px; }
  .text-action:hover { text-decoration: underline; }
  .placeholder {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--text-2);
    gap: 4px;
    padding: 24px;
    text-align: center;
  }
  .ph-icon {
    width: 72px;
    height: 72px;
    border-radius: 22px;
    display: grid;
    place-items: center;
    background: var(--surface);
    border: 1px solid var(--sep);
    box-shadow: var(--shadow-sm);
    color: var(--text-3);
    margin-bottom: 12px;
  }
  .ph-title {
    font-size: 15px;
    font-weight: 650;
    color: var(--text);
    margin: 0;
  }
  .ph-sub {
    margin: 0;
    font-size: 13px;
  }
</style>
