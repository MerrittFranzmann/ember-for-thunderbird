<script lang="ts">
  import { tick, untrack } from "svelte";
  import { prepareHtml, textToHtml } from "../lib/body";
  import { displayName, fullDate } from "../lib/format";
  import { store } from "../lib/store.svelte";
  import type { QuotedHistoryRequest } from "../lib/quoted-history";
  import HtmlFrame from "./HtmlFrame.svelte";
  import { perf } from "../lib/perf-recorder";
  import Icon from "./Icon.svelte";
  let { history, fallback, onClose }: { history: QuotedHistoryRequest; fallback: boolean; onClose: () => void } = $props();
  perf.record("history.open", { fallback: untrack(() => fallback) });
  let allowRemote = $state(false);
  let closeButton: HTMLButtonElement;
  let prepared = $derived(history.history.html ? prepareHtml(history.history.html, { allowRemote: allowRemote || store.settings.loadRemoteImages, cid: history.cid }) : null);
  $effect(() => { history; allowRemote = false; tick().then(() => closeButton?.focus()); });
</script>

<svelte:window onkeydown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }} />

<aside class="history-panel" aria-label="Quoted history">
  <header><div><h2>Quoted history</h2><p>{displayName(history.message.author)} · {fullDate(history.message.date)}</p></div><button class="icon-btn" aria-label="Close quoted history" bind:this={closeButton} onclick={onClose}><Icon name="x" /></button></header>
  {#if fallback}<p class="context">No matching original was found in this conversation. The quoted text is shown below.</p>{/if}
  <div class="history-scroll">
    {#if prepared}
      {#if prepared.hasRemote && !allowRemote && !store.settings.loadRemoteImages}<div class="remote"><span>Remote images are blocked.</span><button class="pill sm" onclick={() => (allowRemote = true)}>Load images</button></div>{/if}
      <HtmlFrame srcdoc={prepared.srcdoc} title="Quoted email history" />
    {:else}<div class="plain">{@html textToHtml(history.history.text || "")}</div>{/if}
  </div>
</aside>

<style>
  .history-panel { width: 360px; max-width: 100%; flex: none; min-height: 0; background: var(--reader); border-left: 1px solid var(--sep-strong); display: flex; flex-direction: column; }
  header { display: flex; align-items: flex-start; gap: 8px; justify-content: space-between; padding: 18px 16px; border-bottom: 1px solid var(--sep); }
  h2 { font-size: 16px; margin: 0; }
  header p { font-size: 12px; color: var(--text-2); margin: 5px 0 0; }
  .context { margin: 12px 16px 0; font-size: 12px; color: var(--text-2); }
  .history-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 16px; }
  .plain { font-size: 14px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
  .plain :global(blockquote) { color: var(--text-2); border-left: 2px solid var(--sep-strong); margin: 6px 0; padding-left: 10px; }
  .plain :global(a) { color: var(--accent-text); }
  .remote { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; font-size: 12px; margin-bottom: 10px; color: var(--text-2); }
  @container (max-width: 820px) { .history-panel { position: absolute; z-index: 20; right: 0; top: 52px; bottom: 0; box-shadow: var(--shadow); } }
  /* Too narrow for side by side: a 360 px overlay left a clipped sliver of the conversation beside it. */
  @container (max-width: 600px) { .history-panel { width: 100%; left: 0; border-left: none; box-shadow: none; } }
</style>
