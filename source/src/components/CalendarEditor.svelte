<script lang="ts">
  // The event editor (Apple Calendar's inspector), over any page: quick add ("Lunch with Priya Thu 1pm at Cafe
  // Rio"), title and place, which calendar, all-day, starts and ends, repeat, alert, show as, invitees, notes.
  // Save puts it on the chosen calendar; with invitees, Exchange (or for Thunderbird's calendars, Google's server or
  // Thunderbird) sends the invitations (or the update).
  import { store } from "../lib/store.svelte";
  import { calendar } from "../lib/calendar.svelte";
  import { CALENDAR_COLORS } from "../lib/calendar-grid";
  import { REMINDERS, SHOW_AS, draftChanges, draftProblem, hm, localTime, repeatOptions, windowsZone, ymd, type EventDraft } from "../lib/calendar-edit";
  import { quickAdd } from "../lib/time-phrases";
  import { freeSlots, slotLabel, timeline, type PersonBusy } from "../lib/find-time";
  import RecipientInput from "./RecipientInput.svelte";
  import Icon from "./Icon.svelte";

  let { draft }: { draft: EventDraft } = $props();
  // Edited in place: the editor owns this draft until it closes.
  // svelte-ignore state_referenced_locally
  let d = $state(structuredClone($state.snapshot(draft)) as EventDraft);
  let quick = $state("");
  let problem = $state("");
  let dialog = $state<HTMLElement | null>(null);

  const colorOf = (accountId: string) => calendar.colorOf(accountId);
  const repeats = $derived(repeatOptions(d.startDate));
  const pending = $derived(d.mode === "edit" ? draftChanges(d, windowsZone()) : null);
  const sends = $derived(d.mode === "new" ? d.invitees.length > 0 : !!pending?.send);
  const action = $derived(d.mode === "new" ? (d.invitees.length ? "Send" : "Add") : sends ? "Send update" : "Save");
  const fromAddress = $derived(calendar.calendars.find((c) => c.accountId === d.accountId)?.email || "");

  $effect(() => { setTimeout(() => dialog?.querySelector<HTMLInputElement>(d.mode === "new" && !d.title ? ".quick input" : ".title")?.focus(), 30); });

  /** Moving the start keeps the length. */
  function moveStart(date: string, time: string) {
    const before = d.allDay ? localTime(d.startDate) : localTime(d.startDate, d.startTime);
    const length = (d.allDay ? localTime(d.endDate) : localTime(d.endDate, d.endTime)) - before;
    d.startDate = date; d.startTime = time;
    const after = new Date((d.allDay ? localTime(date) : localTime(date, time)) + Math.max(0, length));
    d.endDate = ymd(after);
    if (!d.allDay) d.endTime = hm(after);
  }
  function applyQuick() {
    const text = quick.trim();
    if (!text) return;
    const parsed = quickAdd(text, new Date());
    const start = new Date(parsed.start), end = new Date(parsed.allDay ? parsed.end - 86400000 : parsed.end);
    Object.assign(d, { title: parsed.title, location: parsed.location || d.location, allDay: parsed.allDay, startDate: ymd(start), startTime: hm(start), endDate: ymd(end), endTime: hm(end) });
    if (parsed.allDay) { d.showAs = "Free"; d.reminder = -1; }
    quick = "";
    dialog?.querySelector<HTMLInputElement>(".title")?.focus();
  }
  function toggleAllDay() {
    d.allDay = !d.allDay;
    if (!d.allDay && d.startTime === d.endTime && d.startDate === d.endDate) { d.startTime = "09:00"; d.endTime = "10:00"; }
  }

  async function save() {
    problem = draftProblem(d);
    if (problem) return;
    const result = await calendar.save($state.snapshot(d) as EventDraft);
    if (!result.ok) { problem = result.message; return; }
    if (result.message) store.toast({ text: result.message, kind: "success" });
    if (store.view.kind === "calendar" && result.start) calendar.show(calendar.mode === "year" ? "week" : calendar.mode, result.start);
  }
  // ---- Availability (Find a time): the user and the invitees on the event's day, and times everyone's free ----
  const wanted = $derived(d.allDay || !calendar.canFindTime ? [] : d.invitees.map((p) => p.email.trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)));
  let avail = $state<{ key: string; people: PersonBusy[]; error: string; loading: boolean } | null>(null);
  $effect(() => {
    const key = `${d.accountId}|${wanted.join(",")}|${d.startDate}`;
    if (!wanted.length) { avail = null; return; }
    if (avail?.key === key) return;
    const timer = setTimeout(async () => {
      avail = { key, people: avail?.people || [], error: "", loading: true };
      const from = localTime(d.startDate);
      try {
        const people = await calendar.availability(d.accountId, wanted, from, from + 7 * 86400000);
        if (avail?.key === key) avail = { key, people, error: "", loading: false };
      } catch (e: any) { if (avail?.key === key) avail = { key, people: [], error: String(e?.message || e), loading: false }; }
    }, 400);
    return () => clearTimeout(timer);
  });
  const length = $derived(Math.max(15, Math.round((localTime(d.endDate, d.endTime) - localTime(d.startDate, d.startTime)) / 60000)));
  const slots = $derived(avail?.people.length ? freeSlots(avail.people, { from: localTime(d.startDate), to: localTime(d.startDate) + 7 * 86400000, now: Date.now(), minutes: length, limit: 3 }) : []);
  const DAY_FROM = 8 * 60, DAY_TO = 18 * 60;
  const chosen = $derived(timeline([{ start: localTime(d.startDate, d.startTime), end: localTime(d.endDate, d.endTime) }], localTime(d.startDate), DAY_FROM, DAY_TO)[0]);
  const ticks = [8, 10, 12, 14, 16, 18].map((h) => ({ left: (h * 60 - DAY_FROM) / (DAY_TO - DAY_FROM), label: new Date(2026, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" }) }));
  const rowName = (email: string) => email === calendar.emailOf(d.accountId).toLowerCase() ? "You" : d.invitees.find((p) => p.email.toLowerCase() === email)?.name || email;
  function pickSlot(slot: { start: number; end: number }) {
    const a = new Date(slot.start), z = new Date(slot.end);
    Object.assign(d, { startDate: ymd(a), startTime: hm(a), endDate: ymd(z), endTime: hm(z) });
  }
  const isChosen = (slot: { start: number }) => localTime(d.startDate, d.startTime) === slot.start;

  // Something typed (or changed) isn't thrown away by a stray click or Escape: the editor asks first.
  const dirty = $derived(d.mode === "new" ? !!(d.title.trim() || d.location.trim() || d.notes.trim() || d.invitees.length || quick.trim()) : !!Object.keys(pending?.changes || {}).length);
  let discarding = $state(false);
  function close() { if (!calendar.saving) calendar.editor = null; }
  function leave() {
    if (calendar.saving) return;
    // Only the Discard button throws changes away; another click outside just keeps asking.
    if (dirty) { discarding = true; return; }
    close();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (discarding) discarding = false; else leave(); }
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save(); }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div class="scrim" onpointerdown={(e) => { if (e.target === e.currentTarget) leave(); }}>
  <div class="sheet" bind:this={dialog} role="dialog" aria-modal="true" aria-label={d.mode === "new" ? "New event" : `Edit ${d.title || "event"}`} tabindex="-1" onkeydown={onKey}>
    {#if d.mode === "new"}
      <label class="quick">
        <Icon name="compose" size={14} />
        <input bind:value={quick} placeholder="Type it the way you'd say it: Lunch with Priya Thu 1pm at Cafe Rio" aria-label="Quick event" onkeydown={(e) => { if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); applyQuick(); } }} />
        {#if quick.trim()}<button class="fill" onclick={applyQuick}>Fill in</button>{/if}
      </label>
    {/if}
    <div class="card">
      <div class="head">
        <div class="titles">
          <input class="title" bind:value={d.title} placeholder="New Event" aria-label="Title" />
          <input class="where" bind:value={d.location} placeholder="Add Location" aria-label="Location" />
          {#if d.fromEmail}<p class="from"><Icon name="mail" size={12} />From the email “{d.fromEmail.subject}”</p>{/if}
        </div>
        <label class="cal-pick" style:--c={colorOf(d.accountId)} title="Calendar">
          <span class="dot"></span>
          <select bind:value={d.accountId} aria-label="Calendar" disabled={d.mode === "edit"}>
            {#each calendar.writable as c (c.accountId)}<option value={c.accountId}>{calendar.pickName(c.accountId)}</option>{/each}
          </select>
        </label>
      </div>
      <div class="rule"></div>
      <!-- The title above and Cancel / Save below stay in view; this middle scrolls when the window is short. -->
      <div class="scroll">
      <div class="rows">
        <span class="k">all-day:</span>
        <span><input type="checkbox" checked={d.allDay} onchange={toggleAllDay} aria-label="All day" /></span>
        <span class="k">starts:</span>
        <span class="v">
          <input type="date" value={d.startDate} aria-label="Start date" onchange={(e) => moveStart(e.currentTarget.value, d.startTime)} />
          {#if !d.allDay}<input type="time" value={d.startTime} step="300" aria-label="Start time" onchange={(e) => moveStart(d.startDate, e.currentTarget.value)} />{/if}
        </span>
        <span class="k">ends:</span>
        <span class="v">
          <input type="date" bind:value={d.endDate} aria-label="End date" />
          {#if !d.allDay}<input type="time" bind:value={d.endTime} step="300" aria-label="End time" />{/if}
        </span>
        <span class="k">repeat:</span>
        <span class="v">
          {#if d.occurrence}
            <span class="note">Repeats · changes here are for this event only</span>
          {:else}
            <select bind:value={d.repeat} aria-label="Repeat">{#each repeats as [value, label] (value)}<option {value}>{label}</option>{/each}</select>
          {/if}
        </span>
        <span class="k">alert:</span>
        <span class="v"><select bind:value={d.reminder} aria-label="Alert">{#each REMINDERS as [value, label] (value)}<option {value}>{label}</option>{/each}</select></span>
        <span class="k">show as:</span>
        <span class="v"><select bind:value={d.showAs} aria-label="Show as">{#each SHOW_AS as [value, label] (value)}<option {value}>{label}</option>{/each}</select></span>
        <span class="k top">invitees:</span>
        <span class="invitees"><RecipientInput label="Invitees" id="event-invitees" bind:value={d.invitees} /></span>
      </div>
      {#if wanted.length}
        <section class="avail" aria-label="Availability">
          <div class="avail-head"><b>Availability</b><span>{new Date(localTime(d.startDate)).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · from {calendar.isThunderbird(d.accountId) ? "your calendars" : "Exchange"}</span>{#if avail?.loading}<span class="mini-spin" aria-label="Checking"></span>{/if}</div>
          {#if avail?.error}
            <p class="avail-note">Couldn't check availability: {avail.error}</p>
          {:else if avail?.people.length}
            <div class="avail-grid">
              <span></span>
              <div class="ticks">{#each ticks as tick (tick.label)}<span style:left="{tick.left * 100}%">{tick.label}</span>{/each}</div>
              {#each avail.people as person (person.email)}
                <span class="who" title={person.email}>{rowName(person.email)}</span>
                <div class="bar" class:unknown={person.unknown} title={person.unknown ? "Their calendar's busy times aren't available" : undefined}>
                  {#if person.unknown}<span class="no-access">Can't see this calendar</span>{:else}
                    {#each timeline(person.busy, localTime(d.startDate), DAY_FROM, DAY_TO) as block, i (i)}<span class="busy" style:left="{block.left * 100}%" style:width="{block.width * 100}%"></span>{/each}
                  {/if}
                  {#if chosen}<span class="chosen" style:left="{chosen.left * 100}%" style:width="{chosen.width * 100}%" style:--c={colorOf(d.accountId)}></span>{/if}
                </div>
              {/each}
            </div>
            <div class="slots">
              {#if slots.length}
                <span class="avail-note">Everyone's free:</span>
                {#each slots as slot (slot.start)}<button class="slot" aria-pressed={isChosen(slot)} title={slotLabel(slot, undefined, true)} onclick={() => pickSlot(slot)}>{slotLabel(slot)}</button>{/each}
              {:else}
                <span class="avail-note">No time this week when everyone's free for {length} minutes.</span>
              {/if}
            </div>
          {/if}
        </section>
      {/if}
      <textarea class="notes" bind:value={d.notes} rows="3" placeholder="Add Notes or URL" aria-label="Notes"></textarea>
      </div>
      {#if problem}<p class="problem" role="alert">{problem}</p>{/if}
      {#if discarding}
        <div class="discard" role="alertdialog" aria-label="Discard changes">
          <span>{d.mode === "new" ? "Discard this event?" : "Discard your changes?"}</span>
          <button class="btn" onclick={() => (discarding = false)}>Keep editing</button>
          <button class="btn danger" onclick={close}>Discard</button>
        </div>
      {/if}
      <div class="foot">
        <span class="hint">{sends ? `${calendar.isThunderbird(d.accountId) ? "Sent" : "Exchange sends this"} from ${fromAddress || "your address"}.` : d.mode === "new" ? "Nobody is invited." : ""}</span>
        <button class="btn" onclick={close} disabled={calendar.saving}>Cancel</button>
        <button class="btn primary" onclick={save} disabled={calendar.saving || (d.mode === "edit" && !Object.keys(pending?.changes || {}).length)} title="{action} (⌘↵)">{calendar.saving ? "Saving…" : action}</button>
      </div>
    </div>
  </div>
</div>

<style>
  .scrim { position: fixed; inset: 0; z-index: 60; background: rgba(0, 0, 0, 0.32); display: flex; align-items: flex-start; justify-content: center; padding: clamp(12px, 8vh, 72px) 16px 12px; box-sizing: border-box; overflow-y: auto; }
  .sheet { width: 500px; max-width: 100%; max-height: 100%; min-height: 0; display: flex; flex-direction: column; gap: 8px; outline: none; font-size: 13px; color: var(--text); }
  .quick { display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 6px 0 12px; border-radius: 10px; background: var(--surface); box-shadow: 0 0 0 1px var(--sep-strong), var(--shadow); color: #0a84ff; }
  .quick input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--text); font: inherit; font-size: 13.5px; outline: none; }
  .fill { height: 26px; padding: 0 10px; border: 0; border-radius: 6px; background: var(--accent-soft); color: var(--accent-text); font: inherit; font-weight: 600; cursor: pointer; }
  .from { display: flex; align-items: center; gap: 5px; margin: 6px 0 0; font-size: 12px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .from :global(svg) { flex: none; }
  .card { border-radius: 12px; background: var(--surface); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.22), 0 0 0 1px var(--sep-strong); overflow: hidden; display: flex; flex-direction: column; min-height: 0; flex: 0 1 auto; }
  .head, .rule, .foot, .problem { flex: none; }
  .scroll { flex: 1 1 auto; min-height: 96px; overflow-y: auto; overscroll-behavior: contain; }
  :global(:root[data-theme="dark"]) .card, :global(:root[data-theme="dark"]) .quick { background: #2c2c2e; }
  .head { display: flex; align-items: flex-start; gap: 10px; padding: 16px 18px 10px; }
  .titles { flex: 1; min-width: 0; }
  .title { width: 100%; border: 0; padding: 0; background: transparent; color: var(--text); font: inherit; font-size: 20px; font-weight: 700; outline: none; }
  .where { width: 100%; margin-top: 3px; border: 0; padding: 0; background: transparent; color: var(--text-2); font: inherit; outline: none; }
  .cal-pick { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 4px 0 8px; border-radius: 6px; }
  .cal-pick:hover { background: var(--hover); }
  .cal-pick .dot { width: 10px; height: 10px; border-radius: 3px; background: var(--c); }
  .cal-pick select { border: 0; background: transparent; color: var(--text); font: inherit; font-size: 12.5px; cursor: pointer; }
  .rule { height: 1px; margin: 0 18px; background: var(--sep-strong); }
  .rows { display: grid; grid-template-columns: 84px minmax(0, 1fr); column-gap: 10px; row-gap: 4px; align-items: center; padding: 10px 18px 10px; }
  .k { text-align: right; color: var(--text-3); }
  .k.top { align-self: start; padding-top: 8px; }
  .v { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
  .v input, .v select { height: 26px; padding: 0 6px; border: 0; border-radius: 5px; background: transparent; color: var(--text); font: inherit; }
  .v input:hover, .v select:hover { background: var(--hover); }
  .note { color: var(--text-3); font-size: 12.5px; }
  .invitees { min-width: 0; }
  .invitees :global(.lbl) { display: none; }
  .invitees :global(.field) { padding: 0; border: 0; min-height: 30px; }
  .notes { display: block; width: calc(100% - 36px); margin: 0 18px 8px; box-sizing: border-box; border: 0; padding: 6px 0; background: transparent; color: var(--text); font: inherit; resize: vertical; outline: none; border-top: 1px solid var(--sep); }
  .avail { margin: 0 18px 10px; padding: 10px 12px; border-radius: 10px; background: var(--surface-2); }
  .avail-head { display: flex; align-items: baseline; gap: 6px; margin-bottom: 8px; }
  .avail-head b { font-weight: 650; }
  .avail-head span { font-size: 12px; color: var(--text-3); }
  .avail-note { margin: 0; font-size: 12px; color: var(--text-3); }
  .avail-grid { display: grid; grid-template-columns: 92px minmax(0, 1fr); row-gap: 5px; align-items: center; }
  .ticks { position: relative; height: 14px; font-size: 10.5px; color: var(--text-3); }
  .ticks span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
  .ticks span:first-child { transform: none; }
  .ticks span:last-child { transform: translateX(-100%); }
  .who { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 6px; }
  .bar { position: relative; height: 20px; border-radius: 5px; background: var(--surface); box-shadow: inset 0 0 0 1px var(--sep); overflow: hidden; }
  .bar.unknown { background: repeating-linear-gradient(135deg, var(--surface) 0 6px, var(--surface-3) 6px 8px); }
  .busy { position: absolute; top: 3px; bottom: 3px; border-radius: 3px; background: #b6b6bc; }
  :global(:root[data-theme="dark"]) .busy { background: #6b6b72; }
  .chosen { position: absolute; top: 1px; bottom: 1px; border-radius: 4px; background: color-mix(in srgb, var(--c) 28%, transparent); box-shadow: inset 0 0 0 1.5px var(--c); }
  .no-access { position: absolute; inset: 0; display: flex; align-items: center; padding-left: 8px; font-size: 11px; color: var(--text-3); }
  .slots { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin-top: 10px; }
  .slot { height: 24px; padding: 0 10px; border: 0; border-radius: 12px; background: var(--surface); box-shadow: 0 0 0 1px var(--sep-strong); color: var(--text); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
  .slot[aria-pressed="true"] { background: #0a84ff; box-shadow: none; color: #fff; }
  .mini-spin { width: 11px; height: 11px; border-radius: 50%; border: 2px solid var(--sep-strong); border-top-color: var(--text-3); animation: spin 0.8s linear infinite; align-self: center; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .discard { flex: none; display: flex; align-items: center; gap: 8px; margin: 0 18px 8px; padding: 8px 10px; border-radius: 8px; background: color-mix(in srgb, var(--cal-red, #e5484d) 10%, transparent); font-weight: 600; }
  .discard span { flex: 1; }
  .discard .danger { color: var(--cal-red, #e5484d); }
  .problem { margin: 0 18px 8px; color: var(--danger); font-size: 12.5px; }
  .foot { display: flex; align-items: center; gap: 8px; padding: 10px 18px 14px; border-top: 1px solid var(--sep); }
  .hint { flex: 1; font-size: 11.5px; color: var(--text-3); }
  .btn { height: 28px; padding: 0 12px; border: 0; border-radius: 6px; background: var(--surface); box-shadow: 0 0 0 1px var(--sep-strong); color: var(--text); font: inherit; cursor: pointer; }
  .btn.primary { padding: 0 16px; background: #0a84ff; box-shadow: none; color: #fff; font-weight: 600; }
  .btn:disabled { opacity: 0.55; cursor: default; }
  input:focus-visible, select:focus-visible, button:focus-visible, textarea:focus-visible { outline: none; box-shadow: var(--focus); }
</style>
