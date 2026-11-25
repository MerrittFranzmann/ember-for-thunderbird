<script lang="ts">
  // The sidebar's Focus button (focus.ts): what's quiet or hidden now, and for-now changes (until the next
  // scheduled change, or a time), kept in the focusOverride setting.
  import { store } from "../lib/store.svelte";
  import { quietChoices } from "../lib/focus";
  import { sendTimeText } from "../lib/outbox";
  import { api } from "../lib/api";
  import Icon from "./Icon.svelte";

  let open = $state(false);
  const focus = $derived(store.focusState);
  const quiet = $derived(!!focus?.quiet);
  const hidden = $derived(focus?.hiddenAccounts.length || 0);
  const override = $derived(store.settings.focusOverride && store.settings.focusOverride.until > Date.now() ? store.settings.focusOverride : null);
  const until = (time: number) => sendTimeText(time).replace(/^Today, /, "").replace(/^Tomorrow, /, "tomorrow ");
  const next = $derived(focus?.nextChange ?? Date.now() + 2 * 3600000);
  const choices = $derived(quietChoices(store.settings, Date.now()));

  function set(change: { quiet?: boolean; showWork?: boolean }, time: number) {
    const keep = override ? { quiet: override.quiet, showWork: override.showWork } : {};
    void store.setSetting("focusOverride", { ...keep, ...change, until: time });
    open = false;
  }
  function back() { void store.setSetting("focusOverride", null); open = false; }
  function settings() { open = false; void Promise.resolve(api.runtime.sendMessage({ type: "spark:settings", section: "focus" })).catch(() => {}); }
  function onKey(e: KeyboardEvent) { if (e.key === "Escape" && open) { e.stopPropagation(); open = false; } }
</script>

<div class="focus" role="presentation" onkeydown={onKey}>
  <button class="icon-btn" class:on={quiet || hidden > 0} aria-haspopup="menu" aria-expanded={open} aria-label="Focus" title={quiet ? "Quiet hours: only let-through mail notifies" : hidden ? "Work mail hidden" : "Focus"} onclick={() => (open = !open)}>
    <Icon name="moon" />
  </button>
  {#if open}
    <div class="menu" role="menu" aria-label="Focus">
      <p class="status"><b>{quiet ? "Quiet" : "Notifications on"}</b>{quiet ? " · only people and subjects you let through notify" : ""}</p>
      {#if store.settings.workAccounts.length}
        <p class="status"><b>{hidden ? "Work mail hidden" : "Work mail shown"}</b> · {focus?.onWorkNetwork ? `on ${focus.network?.name || "a work network"}` : focus?.inWorkHours ? "work hours" : "not on a work network"}</p>
      {/if}
      <hr />
      {#if quiet}
        <button role="menuitem" onclick={() => set({ quiet: false }, next)}><Icon name="bell" size={15} />Notifications on until {until(next)}</button>
      {:else}
        <button role="menuitem" onclick={() => set({ quiet: true }, choices.hour)}><Icon name="moon" size={15} />Quiet for 1 hour</button>
        <button role="menuitem" onclick={() => set({ quiet: true }, choices.morning)}><Icon name="moon" size={15} />Quiet until {until(choices.morning)}</button>
      {/if}
      {#if hidden}
        <button role="menuitem" onclick={() => set({ showWork: true }, next)}><Icon name="inbox" size={15} />Show work mail until {until(next)}</button>
      {/if}
      {#if override}
        <button role="menuitem" onclick={back}><Icon name="refresh" size={15} />Back to my schedule</button>
      {/if}
      <hr />
      <button role="menuitem" onclick={settings}><Icon name="gear" size={15} />Focus settings…</button>
    </div>
  {/if}
</div>

<style>
  .focus { position: relative; }
  .icon-btn.on { color: var(--accent-text); background: var(--accent-soft); }
  .menu { position: absolute; left: 0; bottom: 40px; z-index: 20; width: 290px; padding: 6px; border-radius: 12px; background: var(--surface); border: 1px solid var(--sep-strong); box-shadow: var(--shadow-lg); }
  .status { margin: 6px 8px; font-size: 12px; color: var(--text-2); line-height: 1.4; }
  .status b { color: var(--text); font-weight: 600; }
  hr { border: 0; border-top: 1px solid var(--sep); margin: 5px 4px; }
  .menu button { display: flex; align-items: center; gap: 9px; width: 100%; padding: 7px 8px; border-radius: 7px; font-size: 13px; text-align: left; color: var(--text); }
  .menu button:hover { background: var(--hover); }
</style>
