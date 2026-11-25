<script lang="ts">
  // Today and tomorrow from the user's Exchange calendars (sparkCalendar Experiment): each meeting's answer
  // (✓ accepted, ? tentative, ! needs a reply), a Join button for calls, and unanswered meetings that clash
  // with another, answerable here. Each tab lists only its own day. A meeting with other people opens its recent email ("Before your meeting").
  import { store } from "../lib/store.svelte";
  import { agenda } from "../lib/agenda.svelte";
  import { api, mailCache } from "../lib/api";
  import { dayAgenda, findJoinLink, joinSoon, responseMark, timeRange, unansweredClashes, type CalendarEvent } from "../lib/meeting-status";
  import { briefDue, briefFor, briefMail, briefSummary } from "../lib/meeting-brief";
  import Icon from "./Icon.svelte";

  const available = agenda.available;
  const stale = () => agenda.stale();
  let day = $state<0 | 1>(0);

  $effect(() => {
    if (!available) return;
    // Not during Ember's first view: an Exchange request at start-up competes with it for Thunderbird.
    const first = setTimeout(() => void agenda.load(), 2500);
    const tick = setInterval(() => {
      // Every five minutes, and at midnight for the new day; not while Ember is hidden (an Exchange
      // request each time, and a re-render for nobody): coming back refreshes it (visibilitychange below).
      if (document.visibilityState !== "visible") return;
      agenda.now = Date.now();
      if (stale()) void agenda.load();
    }, 30000);
    const changed = () => void agenda.load();
    // Coming back refreshes only what the five-minute polling would have (switching apps often asked
    // Exchange on nearly every switch); Ember's own calendar changes still refresh at once.
    const visible = () => { if (document.visibilityState !== "visible") return; agenda.now = Date.now(); if (stale()) void agenda.load(); };
    window.addEventListener("spark:calendar-changed", changed);
    document.addEventListener("visibilitychange", visible);
    return () => { clearTimeout(first); clearInterval(tick); window.removeEventListener("spark:calendar-changed", changed); document.removeEventListener("visibilitychange", visible); };
  });

  const at = (value: string) => Date.parse(value);
  // Only "Tentative" gets a mark beside the title: accepted is the usual case, and an unanswered clash has its own card.
  const shownMark = (event: CalendarEvent) => { const mark = responseMark(event); return mark?.tone === "maybe" ? mark : null; };
  const row = (event: CalendarEvent) => ({ event, brief: briefFor(event, store.me), mark: shownMark(event), when: { start: at(event.start), end: at(event.end) }, join: event.allDay ? null : findJoinLink(event.location, event.body || "") });
  const today = $derived(dayAgenda(agenda.events, agenda.now, 0).map(row));
  const tomorrow = $derived(dayAgenda(agenda.events, agenda.now, 1).map(row));
  const shown = $derived(day === 0 ? today : tomorrow);
  const clash = $derived(day === 0 ? unansweredClashes(today.map((r) => r.event))[0] : undefined);
  /** Recent email for meetings about to start (counted only then: it reads every saved header). */
  const soonMail = $derived.by(() => {
    const counts = new Map<string, { count: number; summary: string }>();
    store.cacheStatus.total;
    const headers = today.some(({ brief }) => brief && briefDue(brief, agenda.now)) ? mailCache.all() : [];
    for (const { brief } of today) {
      if (!brief || !briefDue(brief, agenda.now)) continue;
      const mail = briefMail(headers, brief, agenda.now);
      counts.set(brief.key, { count: mail.length, summary: briefSummary(brief, mail) });
    }
    return counts;
  });
  const time = (r: ReturnType<typeof row>) => {
    const live = !r.event.allDay && agenda.now >= r.when.start && agenda.now < r.when.end;
    return live ? "Now" : r.event.allDay ? "All day" : new Date(r.when.start).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/i, "");
  };
  function open(r: ReturnType<typeof row>) {
    if (r.brief) return store.openBrief(r.brief);
    store.searchText = r.event.subject;
    void store.searchMail(r.event.subject);
  }

  let answering = $state("");
  const ANSWERED = { accept: "Accepted", tentative: "Answered maybe to", decline: "Declined" } as const;
  async function answer(event: CalendarEvent, response: "accept" | "tentative" | "decline") {
    if (answering) return;
    answering = response;
    try {
      await api.sparkCalendar.respondEvent(event.accountId, event.id, response);
      store.toast({ text: `${ANSWERED[response]} “${event.subject}”`, kind: "success" });
      window.dispatchEvent(new Event("spark:calendar-changed"));
    } catch (error: any) {
      store.toast({ text: `Couldn't answer “${event.subject}”: ${error?.message || error}`, kind: "error" });
    } finally { answering = ""; }
  }
</script>

{#snippet meeting(r: ReturnType<typeof row>)}
  {@const live = !r.event.allDay && agenda.now >= r.when.start && agenda.now < r.when.end}
  {@const soon = r.brief ? soonMail.get(r.brief.key) : undefined}
  <li class:live>
    <button class="meeting" title={r.brief ? `${r.event.subject} · ${timeRange(r.when.start, r.when.end, r.event.allDay)} — recent email with ${r.brief.people.length === 1 ? r.brief.people[0].name : `the ${r.brief.people.length} people in it`}${soon ? ` (${soon.summary})` : ""}` : `${r.event.subject}${r.event.location ? ` · ${r.event.location}` : ""} — find the invitation`} onclick={() => open(r)}>
      <span class="time">{time(r)}</span>
      <span class="title">{r.event.subject || "(no title)"}</span>
      {#if soon?.count}<span class="mail-count" aria-label="{soon.count} recent emails"><Icon name="mail" size={12} />{soon.count > 99 ? "99+" : soon.count}</span>{/if}
      {#if r.mark}<span class="mark {r.mark.tone}" title={r.mark.label} aria-label={r.mark.label}>{r.mark.mark}</span>{/if}
    </button>
    {#if r.join}
      <a class="join" class:soon={joinSoon(r.when, agenda.now)} href={r.join.url} target="_blank" rel="noopener noreferrer" title="Join on {r.join.label} · {timeRange(r.when.start, r.when.end)}" aria-label="Join {r.event.subject} on {r.join.label}"><Icon name="video" size={14} /></a>
    {/if}
  </li>
{/snippet}

{#if available && agenda.accounts > 0}
  <section class="agenda" aria-label="Calendar">
    <div class="days" role="tablist" aria-label="Day">
      <button role="tab" aria-selected={day === 0} onclick={() => (day = 0)}>Today{#if today.length}<span class="n">{today.length}</span>{/if}</button>
      <button role="tab" aria-selected={day === 1} onclick={() => (day = 1)}>Tomorrow{#if tomorrow.length}<span class="n">{tomorrow.length}</span>{/if}</button>
    </div>
    <ul aria-label={day === 0 ? "Today's meetings" : "Tomorrow's meetings"}>
      {#each shown as r (`${r.event.accountId}:${r.event.id}`)}
        {@render meeting(r)}
      {:else}
        {#if agenda.loaded && !agenda.failed}<li class="empty">{day === 0 ? "No more meetings today" : "Nothing tomorrow"}</li>{/if}
      {/each}
    </ul>
    {#if agenda.loaded && agenda.error}
      <p class="calendar-error" title={agenda.error}>
        {agenda.failed ? (shown.length ? "Couldn't refresh your calendar" : "Couldn't read your calendar") : "Couldn't read one calendar"}
        <button onclick={() => void agenda.load()}>Try again</button>
      </p>
    {/if}
    {#if clash}
      {@const [unanswered, other] = clash}
      <div class="clash" role="group" aria-label="Unanswered meeting that overlaps another">
        <p><b>{unanswered.subject || "A meeting"}</b> overlaps {other.subject || "another meeting"}</p>
        <div class="answers">
          <button onclick={() => answer(unanswered, "accept")} disabled={!!answering}>{answering === "accept" ? "Accepting…" : "Accept"}</button>
          <button onclick={() => answer(unanswered, "tentative")} disabled={!!answering}>Maybe</button>
          <button onclick={() => answer(unanswered, "decline")} disabled={!!answering}>{answering === "decline" ? "Declining…" : "Decline"}</button>
        </div>
      </div>
    {/if}
  </section>
{/if}

<style>
  .agenda { margin: 20px 0 0; }
  .days { display: flex; gap: 2px; margin: 0 4px 6px; padding: 3px; border-radius: 9px; background: var(--hover); }
  .days button { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 26px; border-radius: 7px; font-size: 12px; color: var(--text-2); }
  .days button[aria-selected="true"] { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: 0 1px 2px rgba(16, 24, 40, 0.1); }
  .n { font-size: 11px; font-weight: 500; color: var(--text-3); font-variant-numeric: tabular-nums; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { display: flex; align-items: center; gap: 2px; border-radius: 8px; }
  li:hover { background: var(--hover); }
  li.live { background: var(--accent-soft); }
  .meeting { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 6px 0 10px; text-align: left; color: var(--text-2); }
  .time { flex: none; width: 42px; font-size: 12px; font-variant-numeric: tabular-nums; color: var(--text-3); }
  li.live .time { color: var(--accent-text); font-weight: 600; }
  .title { flex: 1; min-width: 0; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  li.live .title { color: var(--text); }
  .mark { flex: none; display: grid; place-items: center; min-width: 17px; height: 17px; padding: 0 4px; box-sizing: border-box; border-radius: 999px; font-size: 10.5px; font-weight: 700; }
  .mark.yes { color: var(--success); background: color-mix(in srgb, var(--success) 13%, transparent); }
  .mark.maybe { color: var(--text-2); background: var(--hover); }
  .mark.reply { color: var(--warning-text); background: color-mix(in srgb, var(--warning-text) 16%, transparent); }
  .mail-count { flex: none; display: inline-flex; align-items: center; gap: 3px; padding: 1px 6px; border-radius: 999px; font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--accent-text); background: color-mix(in srgb, var(--accent) 12%, transparent); }
  /* The call button shows on the meeting's line under the pointer (or with the keyboard on it); its place is kept so titles don't shift. */
  .join { flex: none; display: grid; place-items: center; width: 26px; height: 26px; margin-right: 2px; border-radius: 7px; color: var(--text-2); opacity: 0; transition: opacity var(--fast) var(--ease); }
  li:hover .join, li:focus-within .join { opacity: 1; }
  .join:hover { background: var(--hover); color: var(--text); }
  .join.soon { background: var(--accent); color: #fff; }
  .empty { padding: 6px 12px; font-size: 12px; color: var(--text-3); }
  .empty:hover { background: none; }
  .calendar-error { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 2px 0 0; padding: 4px 12px 6px; font-size: 12px; color: var(--warning-text); }
  .calendar-error button { border: 0; background: none; padding: 0; font: inherit; color: var(--accent-text); cursor: pointer; }
  .calendar-error button:hover { text-decoration: underline; }
  .clash { margin: 6px 4px 2px; padding: 8px 10px; border-radius: 10px; background: color-mix(in srgb, var(--warning-text) 10%, transparent); }
  .clash p { margin: 0 0 6px; font-size: 12px; line-height: 1.35; color: var(--warning-text); }
  .clash b { font-weight: 600; }
  .answers { display: flex; gap: 5px; }
  .answers button { height: 24px; padding: 0 9px; border-radius: 999px; background: var(--surface); font-size: 12px; color: var(--text); }
  .answers button:hover:not(:disabled) { background: var(--surface-2); }
  .answers button:disabled { opacity: 0.6; }
</style>
