<script lang="ts" module>
  export interface MenuItem { label: string; icon?: string; run: () => unknown }
</script>

<script lang="ts">
  // An Ember right-click menu at a point (context-menu.ts): arrow keys move, Enter runs, Escape or a click
  // elsewhere closes. Used for email bodies; conversation rows and mailboxes draw theirs in the same style.
  import { tick } from "svelte";
  import Icon from "./Icon.svelte";

  let { x, y, items, label = "Actions", onclose }: { x: number; y: number; items: MenuItem[]; label?: string; onclose: () => void } = $props();
  let el: HTMLDivElement | undefined = $state();
  // Inside the window, whichever way it opens.
  const left = $derived(Math.max(4, Math.min(x, innerWidth - 240)));
  const top = $derived(Math.max(4, Math.min(y, innerHeight - 12 - 34 * items.length)));

  $effect(() => { void tick().then(() => el?.querySelector<HTMLButtonElement>("button")?.focus()); });

  function run(item: MenuItem) { onclose(); void item.run(); }
  function key(e: KeyboardEvent) {
    const buttons = Array.from(el?.querySelectorAll<HTMLButtonElement>("button") || []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") onclose();
    else if (e.key === "ArrowDown") buttons[(i + 1) % buttons.length]?.focus();
    else if (e.key === "ArrowUp") buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    else return;
    e.preventDefault(); e.stopPropagation();
  }
</script>

<svelte:window onpointerdown={(e) => { if (!el?.contains(e.target as Node)) onclose(); }} onblur={onclose} onresize={onclose} />
<div class="context-menu" role="menu" tabindex="-1" aria-label={label} bind:this={el} style="left:{left}px; top:{top}px" onkeydown={key}>
  {#each items as item (item.label)}
    <button role="menuitem" onclick={() => run(item)}>
      {#if item.icon}<Icon name={item.icon} size={15} />{/if}<span>{item.label}</span>
    </button>
  {/each}
</div>

<style>
  .context-menu { position: fixed; z-index: 60; min-width: 200px; max-width: 340px; padding: 5px; border-radius: 10px; background: var(--surface); border: 1px solid var(--sep-strong); box-shadow: var(--shadow-lg); }
  .context-menu button { width: 100%; display: flex; align-items: center; gap: 9px; padding: 6px 9px; border-radius: 6px; font-size: 13px; color: var(--text); text-align: left; }
  .context-menu button span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .context-menu button:hover, .context-menu button:focus-visible { background: var(--hover); box-shadow: none; }
</style>
