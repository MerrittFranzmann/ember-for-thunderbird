<script lang="ts">
  // "Outbox": emails waiting to be sent (Undo send, Send later; outbox.ts), above the inbox and Sent.
  import { composer } from "../lib/compose.svelte";
  import { queuedStatus } from "../lib/outbox";
  import Icon from "./Icon.svelte";

  let all = $state(false);
  let now = $state(Date.now());
  const shown = $derived(all ? composer.outbox : composer.outbox.slice(0, 3));
  const who = (to: string[]) => to.length ? `To ${to[0].replace(/\s*<[^>]+>$/, "").replace(/^"|"$/g, "")}${to.length > 1 ? ` +${to.length - 1}` : ""}` : "No recipients";
  // A countdown while an email waits out Undo send; otherwise the minute is enough.
  $effect(() => {
    const ticking = composer.outbox.some((q) => q.kind === "undo" && q.state === "waiting");
    const timer = setInterval(() => (now = Date.now()), ticking ? 1000 : 30000);
    return () => clearInterval(timer);
  });
</script>

{#if composer.outbox.length}
  <section class="outbox" aria-label="Outbox">
    <h2><Icon name="outbox" size={14} /> Outbox</h2>
    <ul>
      {#each shown as q (q.id)}
        <li class:failed={q.state === "failed"}>
          <span class="what">
            <span class="subj">{q.subject || "(no subject)"}</span>
            <span class="meta">{who(q.to)} · {queuedStatus(q, now)}</span>
          </span>
          {#if q.state !== "sending"}
            <button class="pill ghost sm" onclick={() => composer.takeBack(q.id)}>{q.kind === "undo" && q.state === "waiting" ? "Undo" : "Edit"}</button>
            <button class="pill sm" onclick={() => composer.sendNow(q.id)}>{q.state === "failed" ? "Try again" : "Send now"}</button>
          {/if}
        </li>
      {/each}
    </ul>
    {#if composer.outbox.length > 3}
      <button class="more" onclick={() => (all = !all)}>{all ? "Show fewer" : `${composer.outbox.length - 3} more`}</button>
    {/if}
  </section>
{/if}

<style>
  .outbox { margin: 6px 10px 4px; padding: 8px 8px 6px; border-radius: 12px; background: var(--surface-2); border: 1px solid var(--sep); }
  h2 { display: flex; align-items: center; gap: 6px; margin: 0 4px 4px; font-size: 12px; font-weight: 600; color: var(--text-2); }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 8px; }
  .what { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .subj, .meta { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .subj { font-size: 13px; font-weight: 600; }
  .meta { font-size: 11.5px; color: var(--text-2); font-variant-numeric: tabular-nums; }
  .failed .meta { color: var(--danger); white-space: normal; }
  .pill { flex: none; }
  .more { margin: 2px 6px; font-size: 12px; color: var(--accent-text); }
</style>
