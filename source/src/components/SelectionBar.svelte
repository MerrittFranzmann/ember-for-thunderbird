<script lang="ts">
  // Several conversations picked (⌘-click, Shift-click, ⌘A, the avatar's check box): what to do with all of them.
  // The same keys as for one conversation work too (E, #, M, S, U); Esc clears.
  import { store } from "../lib/store.svelte";
  import Icon from "./Icon.svelte";
  import type { Conversation } from "../lib/types";

  let { onMove }: { onMove: (convs: Conversation[]) => void } = $props();
  const convs = $derived(store.pickedConversations);
  const anyUnread = $derived(convs.some((c) => c.unread > 0));
  const allPinned = $derived(convs.length > 0 && convs.every((c) => c.flagged));
  const total = $derived(store.navOrder.length);
</script>

<div class="selection-bar" role="toolbar" aria-label="{convs.length} selected">
  <button class="icon-btn clear" title="Clear selection (Esc)" aria-label="Clear selection" onclick={() => store.clearPicks()}><Icon name="x" size={16} stroke={2} /></button>
  <span class="count">{convs.length} selected</span>
  {#if convs.length < total}<button class="text-action" onclick={() => store.pickAll()}>Select all {total}</button>{/if}
  <span class="actions">
    <button class="icon-btn" title="Archive (E)" aria-label="Archive {convs.length}" onclick={() => store.archive(convs)}><Icon name="done" size={17} stroke={2} /></button>
    <button class="icon-btn" title="Move to… (M)" aria-label="Move {convs.length}" onclick={() => onMove(convs)}><Icon name="move" size={17} /></button>
    <button class="icon-btn" title="{anyUnread ? 'Mark as read' : 'Mark as unread'} (U)" aria-label={anyUnread ? "Mark as read" : "Mark as unread"} onclick={() => store.toggleRead(convs)}><Icon name={anyUnread ? "mailOpen" : "mail"} size={17} /></button>
    <button class="icon-btn" title="{allPinned ? 'Unpin' : 'Pin'} (S)" aria-label={allPinned ? "Unpin" : "Pin"} onclick={() => store.toggleStar(convs)}><Icon name="pin" size={17} /></button>
    <button class="icon-btn danger" title="Delete (#)" aria-label="Delete {convs.length}" onclick={() => store.trash(convs)}><Icon name="trash" size={17} /></button>
  </span>
</div>

<style>
  .selection-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px 6px 8px;
    border-bottom: 1px solid var(--sep);
    background: var(--accent-softer);
  }
  .count { font-size: 13px; font-weight: 600; }
  .text-action { font-size: 12px; color: var(--accent-text); padding: 4px 6px; border-radius: 6px; }
  .text-action:hover { background: var(--hover); }
  .actions { margin-left: auto; display: flex; gap: 2px; }
  .danger:hover { color: var(--danger); }
</style>
