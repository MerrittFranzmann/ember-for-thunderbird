<script lang="ts">
  // "No reply yet": sent emails whose follow-up reminder is due (follow-up-service.ts), above the Smart Inbox.
  import { store } from "../lib/store.svelte";
  import { followUpMessage } from "../lib/follow-ups";
  import Icon from "./Icon.svelte";

  let all = $state(false);
  const shown = $derived(all ? store.dueFollowUps : store.dueFollowUps.slice(0, 3));
</script>

{#if store.dueFollowUps.length}
  <section class="follow" aria-label="No reply yet">
    <h2><Icon name="bell" size={14} /> No reply yet</h2>
    <ul>
      {#each shown as f (f.mid)}
        <li>
          <button class="open" onclick={() => store.openFollowUp(f)}>
            <span class="subj">{f.subject || "(no subject)"}</span>
            <span class="meta">{followUpMessage(f, Date.now()).replace(/^No reply yet from /, "To ")}</span>
          </button>
          <button class="icon-btn dismiss" aria-label="Dismiss reminder for {f.subject}" title="Dismiss" onclick={() => store.cancelFollowUp(f.mid)}><Icon name="x" size={14} /></button>
        </li>
      {/each}
    </ul>
    {#if store.dueFollowUps.length > 3}
      <button class="more" onclick={() => (all = !all)}>{all ? "Show fewer" : `${store.dueFollowUps.length - 3} more`}</button>
    {/if}
  </section>
{/if}

<style>
  .follow { margin: 6px 10px 4px; padding: 8px 8px 6px; border-radius: 12px; background: color-mix(in srgb, var(--accent) 8%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent); }
  h2 { display: flex; align-items: center; gap: 6px; margin: 0 4px 4px; font-size: 12px; font-weight: 600; color: var(--accent-text); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 4px; }
  .open { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; padding: 5px 6px; border-radius: 8px; text-align: left; }
  .open:hover { background: var(--hover); }
  .subj, .meta { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .subj { font-size: 13px; font-weight: 600; }
  .meta { font-size: 11.5px; color: var(--text-2); }
  .dismiss { width: 26px; height: 26px; flex: none; }
  .more { margin: 2px 6px; font-size: 12px; color: var(--accent-text); }
</style>
