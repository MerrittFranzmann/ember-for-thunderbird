<script lang="ts">
  import { avatarColor, initials, parseAddr } from "../lib/format";
  import Icon from "./Icon.svelte";
  import type { Category } from "../lib/types";

  let { from, size = 36, cat = "people" as Category }: { from: string; size?: number; cat?: Category } = $props();
  let addr = $derived(parseAddr(from));
  let color = $derived(avatarColor(addr.email || addr.name || "?"));
</script>

<span
  class="avatar"
  class:auto={cat !== "people"}
  style="--s:{size}px; --c:{color}"
  aria-hidden="true">
  {#if cat === "notification"}
    <Icon name="bell" size={Math.round(size * 0.5)} />
  {:else if cat === "calendar"}
    <Icon name="calendar" size={Math.round(size * 0.5)} />
  {:else if cat === "newsletter"}
    <Icon name="news" size={Math.round(size * 0.5)} />
  {:else if cat === "receipt"}
    <Icon name="receipt" size={Math.round(size * 0.5)} />
  {:else}
    {initials(addr)}
  {/if}
</span>

<style>
  .avatar {
    width: var(--s);
    height: var(--s);
    border-radius: 50%;
    background: var(--c);
    color: #fff;
    display: inline-grid;
    place-items: center;
    font-weight: 600;
    font-size: calc(var(--s) * 0.38);
    letter-spacing: 0.02em;
    flex: none;
    user-select: none;
  }
  .avatar.auto {
    background: color-mix(in srgb, var(--c) 16%, var(--surface));
    color: var(--c);
  }
  :global(:root[data-theme="dark"]) .avatar.auto {
    background: color-mix(in srgb, var(--c) 28%, var(--surface));
    color: color-mix(in srgb, var(--c) 45%, #fff);
  }
</style>
