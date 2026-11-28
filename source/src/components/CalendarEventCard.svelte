<script lang="ts">
  // One event's details (Apple Calendar's popover): title and place, when, which calendar, overlaps, Join, the
  // people and their answers, emails about it, notes, and Accept / Maybe / Decline for invitations. Shown in a
  // popover in Week and Month, and in the side panel in Day.
  import { store } from "../lib/store.svelte";
  import { calendar, type Attendee, type Response } from "../lib/calendar.svelte";
  import { mailCache } from "../lib/api";
  import { emailsAbout, eventKey, eventNotes, eventTitle, isInvitation, overlapsWith, whenText } from "../lib/calendar-grid";
  import { findJoinLink, type CalendarEvent } from "../lib/meeting-status";
  import { briefFor } from "../lib/meeting-brief";
  import { draftFromEvent } from "../lib/calendar-edit";
  import { displayName } from "../lib/format";
  import Icon from "./Icon.svelte";

  let { event, color, calendarName, others, panel = false, onclose }: {
    event: CalendarEvent; color: string; calendarName: string; others: CalendarEvent[]; panel?: boolean; onclose?: () => void;
  } = $props();

  const key = $derived(eventKey(event));
  const loaded = $derived(calendar.details[key]);
  const details = $derived(loaded && !("error" in loaded) ? loaded : null);
  const when = $derived(whenText(event));
  const overlaps = $derived(overlapsWith(event, others));
  const join = $derived(event.allDay ? null : findJoinLink(event.location, details?.body || ""));
  const notes = $derived(eventNotes(details?.body));
  const organizer = $derived(event.response === "organizer");
  const invitation = $derived(isInvitation(event) && !event.cancelled);
  // Location without the call link Outlook puts there ("Microsoft Teams Meeting" stays: it says where).
  const place = $derived((event.location || "").trim());

  const MARK: Record<string, { mark: string; tone: string; label: string }> = {
    accept: { mark: "✓", tone: "yes", label: "accepted" },
    tentative: { mark: "?", tone: "maybe", label: "maybe" },
    decline: { mark: "×", tone: "no", label: "declined" },
    none: { mark: "", tone: "none", label: "no answer" },
  };
  const people = $derived.by(() => {
    const list = details?.attendees || [];
    const host = list.find((p) => p.role === "organizer");
    const rest = list.filter((p) => p.role !== "organizer");
    return [...(host ? [host] : []), ...rest].map((p: Attendee) => {
      const me = store.me.has(p.email.toLowerCase());
      // Attendees' answers are only known on the organizer's copy.
      const answer = p.role === "organizer" ? { mark: "✓", tone: "yes", label: "organizer" } : organizer && p.response ? MARK[p.response] || MARK.none : null;
      return { ...p, me, name: me ? "You" : p.name || displayName(p.email) || p.email, answer };
    });
  });
  // A shared or extra calendar's event is shown, not changed.
  const sharedNote = $derived.by(() => {
    if (event.readOnly && !event.shared) return `In your “${calendarName}” calendar, which Thunderbird reads but can't change.`;
    if (!event.shared) return "";
    const other = calendar.others.find((c) => c.key === event.calendarId);
    if (other?.kind === "folder") return `In your “${calendarName}” calendar. Ember shows it but doesn't change it.`;
    if (event.busyOnly) return `${calendarName} shares only ${event.subject || event.location ? "the subject, place and time" : "when they're busy"}.`;
    return `On ${calendarName}'s calendar. You can see it, not change it.`;
  });
  const emails = $derived(event.busyOnly ? [] : emailsAbout(event, mailCache.all()));
  const brief = $derived(details && !event.shared ? briefFor(details, store.me) : null);

  // ---- The user's own events: Edit, Delete / Cancel meeting; a cancelled invitation: Remove from calendar ----
  const own = $derived(organizer && !event.cancelled && !event.readOnly);
  const meeting = $derived(!!details && (details.isMeeting || people.some((p) => p.role !== "organizer" && !p.me)));
  const series = $derived(details?.type === "Occurrence" || details?.type === "Exception");
  let confirming = $state(false);
  let choosingEdit = $state(false);
  let note = $state("");
  // A long invitee list shows its first few until opened, so the card stays short enough to see whole.
  const PEOPLE_SHOWN = 6;
  let allPeople = $state(false);
  const shownPeople = $derived(allPeople || panel || people.length <= PEOPLE_SHOWN + 1 ? people : people.slice(0, PEOPLE_SHOWN));
  $effect(() => { key; confirming = false; choosingEdit = false; note = ""; allPeople = false; });
  async function edit() {
    if (!details) await calendar.loadDetails(event);
    const source = calendar.details[key];
    const from = source && !("error" in source) ? source : { ...event, body: "", attendees: [] };
    onclose?.();
    void calendar.openEditor(draftFromEvent(from, store.me));
  }
  /** Every event of the series: the editor opens on the series (its first time, how it repeats). */
  async function editSeries() {
    choosingEdit = false;
    try {
      const source = await calendar.seriesDetails(event);
      const draft = draftFromEvent(source, store.me);
      // Changed through this occurrence's id (Exchange and Thunderbird find its series from it).
      draft.itemId = event.id; draft.series = true; draft.occurrence = false;
      if (draft.original) { draft.original.itemId = event.id; draft.original.series = true; draft.original.occurrence = false; }
      onclose?.();
      void calendar.openEditor(draft);
    } catch (e: any) { store.toast({ text: `Couldn't open the series: ${e?.message || e}`, kind: "error" }); }
  }
  async function remove(options: { series?: boolean; cancel?: boolean }) {
    // Worded before the call: the card closes once the event is gone.
    const name = event.subject || "the event";
    const all = options.series ? " and the rest of the series" : "";
    const done = event.cancelled && !own ? `Removed “${name}” from your calendar` : options.cancel ? `Cancelled “${name}”${all}. The invitees are told.` : `Deleted “${name}”${all}`;
    const close = onclose;
    const result = await calendar.remove(event, { ...options, note: options.cancel ? note.trim() : "", changeKey: details?.changeKey || "" });
    if (!result.ok) { if (result.message) store.toast({ text: `Couldn't change “${name}”: ${result.message}`, kind: "error" }); return; }
    store.toast({ text: done, kind: "success" });
    close?.();
  }

  const ANSWERS: [Response, string][] = [["accept", "Accept"], ["tentative", "Maybe"], ["decline", "Decline"]];
  const DONE: Record<Response, string> = { accept: "Accepted", tentative: "Answered maybe to", decline: "Declined" };
  async function answer(response: Response) {
    const host = people.find((p) => p.role === "organizer");
    const result = await calendar.answer(event, response);
    if (result.ok) store.toast({ text: `${DONE[response]} “${event.subject || "the meeting"}”. ${host && !host.me ? host.name : "The organizer"} is told.`, kind: "success" });
    else if (result.message) store.toast({ text: `Couldn't answer “${event.subject || "the meeting"}”: ${result.message}`, kind: "error" });
  }
</script>

<div class="card" class:panel role={panel ? "region" : "dialog"} aria-label={event.subject || "Event"}>
  <div class="head">
    <div class="titles">
      <h2>{eventTitle(event)}</h2>
      {#if place}<p class="where">{place}</p>{/if}
    </div>
    {#if onclose}<button class="close" aria-label="Close" title="Close (Esc)" onclick={onclose}><Icon name="x" size={12} stroke={2.6} /></button>{/if}
  </div>
  <div class="rule"></div>
  <div class="when"><div>{when.day}</div><div class="sub">{when.time}</div></div>
  <div class="cal"><span class="dot" style:background={color}></span>{calendarName}</div>
  {#if event.cancelled}<p class="warn">The organizer cancelled this meeting.</p>{/if}
  {#if sharedNote}<p class="sub small shared-note">{sharedNote}</p>{/if}
  {#if overlaps.length}<p class="warn">Overlaps {overlaps.map((o) => o.subject || "another event").join(", ")}</p>{/if}
  {#if join}
    <a class="join" href={join.url} target="_blank" rel="noopener noreferrer"><Icon name="video" size={14} />Join {join.label} meeting</a>
  {/if}
  {#if people.length}
    <div class="block">
      <h3>Invitees{#if organizer}<span> · you organized this</span>{/if}</h3>
      <ul class="people">
        {#each shownPeople as p (p.email)}
          <li title={p.email}>
            <span class="mark {p.answer?.tone || 'unknown'}" aria-hidden="true">{p.answer?.mark || ""}</span>
            <span class="name">{p.name}</span>
            {#if p.answer}<span class="note">{p.answer.label}</span>{/if}
          </li>
        {/each}
      </ul>
      {#if shownPeople.length < people.length}
        <button class="more-people" onclick={() => (allPeople = true)}>Show all {people.length}</button>
      {/if}
    </div>
  {/if}
  {#if emails.length || brief}
    <div class="block">
      <h3>Emails about this</h3>
      {#each emails as m (m.id)}
        <button class="email" onclick={() => { onclose?.(); void store.openMessage(m.id); }}>
          <Icon name="mail" size={13} /><b>{displayName(m.author) || m.author}</b><span>{m.subject}</span>
        </button>
      {/each}
      {#if brief}
        <button class="email more" onclick={() => { onclose?.(); void store.openBrief(brief); }}>
          <Icon name="people" size={13} /><span>Recent email with {brief.people.length === 1 ? brief.people[0].name : `these ${brief.people.length} people`}</span>
        </button>
      {/if}
    </div>
  {/if}
  {#if notes}<p class="notes">{notes}</p>{/if}
  {#if loaded && "error" in loaded}<p class="sub small">Couldn't read the details: {loaded.error}</p>{/if}
  <!-- The answers and Edit / Delete stay at the bottom of the popover, in view however long the card is. -->
  {#if invitation || (event.cancelled && !organizer && !event.shared) || own}<div class="foot">
  {#if invitation}
    <div class="rule"></div>
    <div class="answers" role="group" aria-label="Your answer">
      {#each ANSWERS as [response, label] (response)}
        <button aria-pressed={event.response === response} disabled={!!calendar.answering} onclick={() => answer(response)}>
          {calendar.answering === response ? "…" : label}
        </button>
      {/each}
    </div>
    {#if event.response === "none"}<p class="sub small">You haven't answered yet.</p>{/if}
  {:else if event.cancelled && !organizer && !event.shared}
    <div class="rule"></div>
    <div class="actions"><button class="danger" disabled={calendar.saving} onclick={() => remove({})}>Remove from calendar</button></div>
  {/if}
  {#if own}
    <div class="rule"></div>
    {#if choosingEdit}
      <div class="confirm" role="group" aria-label="Edit a repeating event">
        <p>Change just this event, or every event in the series?</p>
        <div class="actions wrap">
          <button onclick={() => { choosingEdit = false; void edit(); }}>This one</button>
          <button onclick={editSeries}>All events</button>
          <button onclick={() => (choosingEdit = false)}>Keep</button>
        </div>
      </div>
    {:else if !confirming}
      <div class="actions">
        <button disabled={!loaded || calendar.saving} onclick={() => { if (series) choosingEdit = true; else void edit(); }}>Edit</button>
        <button class="danger" disabled={!loaded || calendar.saving} onclick={() => (confirming = true)}>{meeting ? "Cancel meeting" : "Delete"}</button>
      </div>
    {:else}
      <div class="confirm" role="group" aria-label={meeting ? "Cancel meeting" : "Delete event"}>
        <p>{meeting ? `Cancel “${event.subject || "this meeting"}”? The invitees are told.` : `Delete “${event.subject || "this event"}”?`}</p>
        {#if meeting}<textarea bind:value={note} rows="2" placeholder="Add a note to the cancellation (optional)" aria-label="Cancellation note"></textarea>{/if}
        <div class="actions wrap">
          {#if series}
            <button class="danger" disabled={calendar.saving} onclick={() => remove({ cancel: meeting })}>{meeting ? "Cancel this one" : "Delete this one"}</button>
            <button class="danger" disabled={calendar.saving} onclick={() => remove({ cancel: meeting, series: true })}>{meeting ? "Cancel all" : "Delete all"}</button>
          {:else}
            <button class="danger" disabled={calendar.saving} onclick={() => remove({ cancel: meeting })}>{meeting ? "Cancel meeting" : "Delete"}</button>
          {/if}
          <button disabled={calendar.saving} onclick={() => (confirming = false)}>Keep</button>
        </div>
      </div>
    {/if}
  {/if}
  </div>{/if}
</div>

<style>
  .card { display: flex; flex-direction: column; gap: 10px; font-size: 12.5px; line-height: 1.35; color: var(--text); }
  .head { display: flex; align-items: flex-start; gap: 8px; }
  .titles { flex: 1; min-width: 0; }
  h2 { margin: 0; font-size: 15px; font-weight: 700; line-height: 1.25; overflow-wrap: anywhere; }
  .panel h2 { font-size: 18px; }
  .where { margin: 2px 0 0; color: var(--text-2); overflow-wrap: anywhere; }
  .close { flex: none; width: 22px; height: 22px; border: 0; border-radius: 11px; background: transparent; color: var(--text-3); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
  .close:hover { background: var(--hover); }
  .rule { height: 1px; background: var(--sep-strong); }
  .sub { color: var(--text-2); }
  .small { margin: 0; font-size: 12px; }
  .cal { display: flex; align-items: center; gap: 6px; color: var(--text-2); }
  .dot { width: 9px; height: 9px; border-radius: 5px; flex: none; }
  .warn { margin: 0; font-size: 12px; color: var(--cal-red); }
  .join { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 14px; border-radius: 13px; background: #0a84ff; color: #fff; font-weight: 600; text-decoration: none; }
  .join:hover { background: #0071e3; }
  .block h3 { margin: 0 0 4px; font-size: 11px; font-weight: 700; color: var(--text-3); text-transform: uppercase; letter-spacing: 0.02em; }
  .block h3 span { text-transform: none; font-weight: 500; letter-spacing: 0; }
  .people { list-style: none; margin: 0; padding: 0; }
  .people li { display: flex; align-items: center; gap: 7px; height: 22px; }
  .mark { flex: none; width: 13px; height: 13px; border-radius: 7px; color: #fff; font-size: 9px; font-weight: 800; display: inline-flex; align-items: center; justify-content: center; background: #aeaeb2; }
  .mark.yes { background: #34c759; }
  .mark.maybe { background: #ff9f0a; }
  .mark.no { background: #ff3b30; }
  /* An attendee's answer Exchange doesn't share (only the organizer's copy has them). */
  .mark.unknown { background: transparent; box-shadow: inset 0 0 0 1.5px var(--sep-strong); }
  .people .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .people .note { font-size: 11.5px; color: var(--text-3); }
  .email { width: 100%; display: flex; align-items: center; gap: 6px; padding: 4px 0; border: 0; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
  .email :global(svg) { flex: none; color: var(--text-3); }
  .email b { font-weight: 600; white-space: nowrap; }
  .email span { color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .email:hover span, .email:hover b { text-decoration: underline; }
  .email.more span { color: var(--accent-text); }
  .notes { margin: 0; color: var(--text-2); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 9.5em; overflow: auto; }
  .panel .notes { max-height: none; }
  .answers { display: flex; gap: 6px; }
  .answers button { flex: 1; height: 26px; border: 1px solid var(--sep-strong); border-radius: 6px; background: var(--surface); color: var(--text); font: inherit; font-weight: 600; cursor: pointer; }
  .answers button:hover:not(:disabled) { background: var(--hover); }
  .answers button[aria-pressed="true"] { background: #0a84ff; border-color: #0a84ff; color: #fff; }
  .answers button:disabled { opacity: 0.6; cursor: default; }
  .actions { display: flex; gap: 6px; }
  .foot { display: flex; flex-direction: column; gap: 10px; }
  .card:not(.panel) .foot { position: sticky; bottom: -12px; z-index: 1; margin: 0 -16px -12px; padding: 0 16px 12px; background: var(--pop-bg, var(--surface)); }
  .more-people { margin-top: 2px; padding: 0; border: 0; background: none; color: var(--accent-text); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
  .more-people:hover { text-decoration: underline; }
  .actions.wrap { flex-wrap: wrap; }
  .actions button { flex: 1; height: 26px; padding: 0 8px; border: 1px solid var(--sep-strong); border-radius: 6px; background: var(--surface); color: var(--text); font: inherit; cursor: pointer; white-space: nowrap; }
  .actions button:hover:not(:disabled) { background: var(--hover); }
  .actions button.danger { color: var(--cal-red); font-weight: 600; }
  .actions button:disabled { opacity: 0.55; cursor: default; }
  .confirm { display: flex; flex-direction: column; gap: 8px; }
  .confirm p { margin: 0; }
  .confirm textarea { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--sep-strong); border-radius: 6px; background: var(--surface); color: var(--text); font: inherit; resize: vertical; }
  button:focus-visible, a:focus-visible { outline: none; box-shadow: var(--focus); }
</style>
