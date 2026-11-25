<script lang="ts">
  // "Before your meeting", above the inbox: from ten minutes before a meeting until five minutes in,
  // its recent email with the people in it (meeting-brief.ts). Hidden when there is none.
  import { store } from "../lib/store.svelte";
  import { agenda } from "../lib/agenda.svelte";
  import { mailCache } from "../lib/api";
  import { agendaItems, joinSoon } from "../lib/meeting-status";
  import { briefDue, briefFor, briefMail, briefSummary, startsIn } from "../lib/meeting-brief";
  import Icon from "./Icon.svelte";

  const due = $derived.by(() => {
    if (!store.settings.meetingBrief) return [];
    const briefs = agendaItems(agenda.events, agenda.now).map((event) => briefFor(event, store.me)).filter((brief) => !!brief && briefDue(brief, agenda.now) && !agenda.dismissed.includes(brief.key));
    if (!briefs.length) return [];
    store.cacheStatus.total;
    const headers = mailCache.all();
    return briefs.map((brief) => ({ brief: brief!, mail: briefMail(headers, brief!, agenda.now) })).filter(({ mail }) => mail.length).slice(0, 2);
  });
</script>

{#each due as { brief, mail } (brief.key)}
  <section class="brief" aria-label="Before {brief.subject}">
    <span class="ic"><Icon name="calendar" size={16} /></span>
    <button class="open" onclick={() => store.openBrief(brief)}>
      <span class="top"><span class="when">{startsIn(brief.start, agenda.now)}</span><span class="subj">{brief.subject}</span></span>
      <span class="meta">{briefSummary(brief, mail)}</span>
    </button>
    {#if brief.join && joinSoon({ start: brief.start, end: brief.end }, agenda.now)}
      <a class="pill sm join" href={brief.join.url} target="_blank" rel="noopener noreferrer" title="Join on {brief.join.label}"><Icon name="video" size={14} /> Join</a>
    {/if}
    <button class="icon-btn dismiss" aria-label="Hide brief for {brief.subject}" title="Hide" onclick={() => (agenda.dismissed = [...agenda.dismissed, brief.key])}><Icon name="x" size={14} /></button>
  </section>
{/each}

<style>
  .brief { display: flex; align-items: center; gap: 6px; margin: 6px 10px 4px; padding: 6px 6px 6px 10px; border-radius: 12px; background: color-mix(in srgb, var(--accent) 8%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 22%, transparent); }
  .ic { flex: none; display: grid; place-items: center; color: var(--accent-text); }
  .open { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 3px 6px; border-radius: 8px; text-align: left; }
  .open:hover { background: var(--hover); }
  .top { display: flex; align-items: baseline; gap: 8px; max-width: 100%; }
  .when { flex: none; font-size: 12px; font-weight: 600; color: var(--accent-text); font-variant-numeric: tabular-nums; }
  .subj, .meta { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .subj { font-size: 13px; font-weight: 600; }
  .meta { max-width: 100%; font-size: 11.5px; color: var(--text-2); }
  .join { flex: none; display: inline-flex; align-items: center; gap: 5px; background: var(--accent); color: #fff; border-color: transparent; text-decoration: none; }
  .dismiss { width: 26px; height: 26px; flex: none; }
</style>
