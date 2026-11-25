<script lang="ts">
  import { store } from "../lib/store.svelte";
  import Icon from "./Icon.svelte";
</script>

<div class="toasts" role="status" aria-live="polite">
  {#each store.toasts as t (t.id)}
    <div class="toast" class:error={t.kind === "error"}>
      {#if t.kind === "success"}<span class="ok"><Icon name="check" size={16} stroke={2.2} /></span>{/if}
      <span class="text">{t.text}</span>
      {#if t.action}
        <button
          class="act"
          onclick={() => {
            t.action?.run();
            store.dismiss(t.id);
          }}>{t.action.label}</button>
      {/if}
      <button class="close" aria-label="Dismiss" onclick={() => store.dismiss(t.id)}><Icon name="x" size={14} /></button>
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 50%;
    bottom: 22px;
    transform: translateX(-50%);
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    z-index: 100;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 42px;
    padding: 0 8px 0 16px;
    border-radius: 999px;
    background: #1f2026;
    color: #fff;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.25);
    font-size: 13.5px;
    animation: up var(--med) var(--ease);
  }
  :global(:root[data-theme="dark"]) .toast {
    background: #f1f1f4;
    color: #1c1c1f;
  }
  @keyframes up {
    from {
      transform: translateY(10px);
      opacity: 0;
    }
  }
  .toast.error {
    background: #b42318;
    color: #fff;
  }
  .ok {
    color: #3ccf86;
  }
  :global(:root[data-theme="dark"]) .ok {
    color: #12804a;
  }
  .act {
    font-weight: 700;
    color: #7db4ff;
    padding: 6px 10px;
    border-radius: 999px;
  }
  :global(:root[data-theme="dark"]) .act {
    color: #0a5fd6;
  }
  .act:hover {
    background: rgba(255, 255, 255, 0.12);
  }
  .close {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    opacity: 0.7;
  }
  .close:hover {
    opacity: 1;
    background: rgba(127, 127, 127, 0.2);
  }
</style>
