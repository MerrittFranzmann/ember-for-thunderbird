<script lang="ts">
  // The sidebar while the Calendar page is open (Apple Calendar's source list): each account's calendars (an Exchange
  // account's main one and extra ones; Thunderbird's own, such as Google's, under their account) and the calendars
  // shared with the user, each with a coloured check box to show or hide it; connecting a mail account's calendars;
  // adding a person's calendar; and a small month to jump to a day.
  import { store } from "../lib/store.svelte";
  import { calendar, type CalendarInfo, type OtherCalendar } from "../lib/calendar.svelte";
  import { miniMonth, rangeFor, startOfDay, weekdayNames } from "../lib/calendar-grid";
  import type { Addr } from "../lib/format";
  import RecipientInput from "./RecipientInput.svelte";
  import Icon from "./Icon.svelte";

  function toggle(key: string) { void calendar.toggle(key).catch(() => {}); }
  const folders = (accountId: string) => calendar.others.filter((c) => c.kind === "folder" && c.accountId === accountId);
  const people = $derived(calendar.others.filter((c) => c.kind === "person"));
  /** Headings: each Exchange account, then Thunderbird's calendars by the account (or place) they belong to. */
  const groups = $derived.by(() => {
    const out: { key: string; name: string; title: string; calendars: CalendarInfo[] }[] = [];
    for (const c of calendar.calendars) {
      if (c.kind !== "thunderbird") { out.push({ key: c.accountId, name: store.accountName(c.accountId), title: c.email, calendars: [c] }); continue; }
      const name = c.group || "Other calendars";
      const group = out.find((g) => g.key === `group:${name}`);
      if (group) group.calendars.push(c);
      else out.push({ key: `group:${name}`, name, title: c.email, calendars: [c] });
    }
    return out;
  });
  async function connect(accountId: string) {
    const result = await calendar.connect(accountId);
    if (result.message) store.toast({ text: result.ok ? result.message : `Couldn't connect the calendars: ${result.message}`, kind: result.ok ? "success" : "error" });
  }
  function hint(c: OtherCalendar): string {
    const error = calendar.otherErrors[c.key];
    if (error) return `Couldn't read this calendar: ${error}`;
    if (calendar.access[c.key] === "busy") return `${c.name} shares only when they're busy`;
    return c.email || c.name;
  }

  // Adding a person's (or group's) calendar.
  let adding = $state(false);
  let addWho = $state<Addr[]>([]);
  let addBusy = $state(false);
  async function add() {
    if (!addWho.length || addBusy) return;
    addBusy = true;
    try {
      for (const who of addWho) await calendar.addPerson(who.email, who.name || "");
      adding = false; addWho = [];
    } catch (e: any) {
      store.toast({ text: `Couldn't add the calendar: ${String(e?.message || e)}`, kind: "error" });
    } finally { addBusy = false; }
  }

  // The small month follows the page, and can be paged on its own.
  let shownMonth = $state<{ year: number; month: number } | null>(null);
  $effect(() => { const d = new Date(calendar.anchor); shownMonth = { year: d.getFullYear(), month: d.getMonth() }; });
  const weekdays = weekdayNames(calendar.firstDay);
  const days = $derived(shownMonth ? miniMonth(shownMonth.year, shownMonth.month, calendar.firstDay) : []);
  const today = $derived(startOfDay(calendar.now).getTime());
  const range = $derived(calendar.mode === "year" ? null : rangeFor(calendar.mode === "month" ? "week" : calendar.mode, calendar.anchor, calendar.firstDay));
  function page(direction: 1 | -1) {
    if (!shownMonth) return;
    const d = new Date(shownMonth.year, shownMonth.month + direction, 1);
    shownMonth = { year: d.getFullYear(), month: d.getMonth() };
  }
  const monthTitle = $derived(shownMonth ? new Date(shownMonth.year, shownMonth.month, 1).toLocaleDateString(undefined, { month: "long" }) : "");
</script>

<section class="cal-side" aria-label="Calendars">
  {#snippet row(key: string, name: string, title: string, other: OtherCalendar | null)}
    {@const on = calendar.isShown(key)}
    <div class="row">
      <button class="cal" role="checkbox" aria-checked={on} title={title || (on ? "Hide this calendar" : "Show this calendar")} style:--c={calendar.colorOf(key)} onclick={() => toggle(key)}>
        <span class="box" aria-hidden="true">{#if on}<Icon name="check" size={10} stroke={4} />{/if}</span>
        <span class="name">{name}</span>
        {#if other && on && calendar.otherErrors[key]}<span class="flag warn" aria-label="Couldn't read">!</span>
        {:else if other && on && calendar.access[key] === "busy"}<span class="flag">busy only</span>{/if}
      </button>
      {#if other?.added}<button class="remove" aria-label="Remove {name}" title="Remove from the list" onclick={() => void calendar.removePerson(key)}><Icon name="x" size={10} stroke={2.6} /></button>{/if}
    </div>
  {/snippet}

  {#each groups as g (g.key)}
    <h2 class="account" title={g.title}>{g.name}</h2>
    {#each g.calendars as c (c.accountId)}
      {@render row(c.accountId, c.kind === "thunderbird" ? c.name : "Calendar", c.readOnly ? `${c.name}: Thunderbird reads it but can't change it` : "", null)}
      {#each folders(c.accountId) as f (f.key)}{@render row(f.key, f.name, hint(f), f)}{/each}
    {/each}
  {/each}

  {#each calendar.toConnect as a (a.accountId)}
    <div class="connect">
      <button class="add-link two" disabled={!!calendar.connecting} title={a.google ? "Thunderbird signs in to Google and adds your calendars" : "Thunderbird looks for calendars at your provider and adds them"} onclick={() => void connect(a.accountId)}>
        <Icon name="plus" size={12} stroke={2.4} />
        <span class="two-lines"><span>{calendar.connecting === a.accountId ? "Connecting…" : a.google ? "Connect Google Calendar" : "Find calendars"}</span><span class="sub">{a.email}</span></span>
      </button>
      <button class="remove" aria-label="Don't offer for {a.email}" title="Don't offer this" onclick={() => void calendar.hideConnect(a.accountId)}><Icon name="x" size={10} stroke={2.6} /></button>
    </div>
  {/each}

  {#if calendar.exchange.length && calendar.canShare}
    <h2 class="account">Shared</h2>
    {#each people as p (p.key)}{@render row(p.key, p.name, hint(p), p)}{/each}
    {#if adding}
      <div class="add" role="group" aria-label="Add a person's calendar">
        <span class="add-hint">Name or email</span>
        <RecipientInput label="Person" id="calendar-add-person" bind:value={addWho} autofocus />
        <div class="add-actions">
          <button class="primary" disabled={!addWho.length || addBusy} onclick={add}>{addBusy ? "Adding…" : "Add"}</button>
          <button onclick={() => { adding = false; addWho = []; }}>Cancel</button>
        </div>
      </div>
    {:else}
      <button class="add-link" title="Add a person's or group's calendar" onclick={() => (adding = true)}><Icon name="plus" size={12} stroke={2.4} />Add a calendar</button>
    {/if}
    {#if calendar.othersLoaded && !people.length && !adding}<p class="empty">See a colleague's calendar beside yours: when they're busy, or everything if they've shared it with you.</p>{/if}
  {/if}

  {#if shownMonth}
    <div class="mini">
      <div class="mini-head">
        <span class="mini-title"><b>{monthTitle}</b> {shownMonth.year}</span>
        <button aria-label="Previous month" onclick={() => page(-1)}><Icon name="chevronLeft" size={12} stroke={2.6} /></button>
        <button aria-label="Next month" onclick={() => page(1)}><Icon name="chevronRight" size={12} stroke={2.6} /></button>
      </div>
      <div class="mini-grid">
        {#each weekdays as w (w.short)}<span class="dow">{w.letter}</span>{/each}
        {#each days as d (d.date.getTime())}
          {@const t = d.date.getTime()}
          <button class:out={!d.inMonth} class:today={t === today} class:in-range={!!range && t >= range.start.getTime() && t < range.end.getTime()}
            aria-label={d.date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
            onclick={() => calendar.show(calendar.mode === "year" ? "day" : calendar.mode, t)}>{d.date.getDate()}</button>
        {/each}
      </div>
    </div>
  {/if}
</section>

<style>
  .cal-side { display: flex; flex-direction: column; gap: 1px; padding: 4px 2px 8px; }
  .account { margin: 14px 10px 4px; font-size: 11px; font-weight: 700; color: var(--text-3); letter-spacing: 0.02em; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row { position: relative; display: flex; align-items: center; }
  .row .cal { flex: 1; min-width: 0; }
  .name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .flag { flex: none; font-size: 10.5px; color: var(--text-3); }
  .flag.warn { width: 14px; height: 14px; border-radius: 7px; background: var(--cal-red, #ff3b30); color: #fff; font-weight: 800; display: inline-flex; align-items: center; justify-content: center; }
  .remove { position: absolute; right: 4px; width: 20px; height: 20px; border: 0; border-radius: 10px; background: var(--surface); color: var(--text-3); display: none; align-items: center; justify-content: center; cursor: pointer; }
  .row:hover .remove, .remove:focus-visible { display: inline-flex; }
  .remove:hover { color: var(--text); background: var(--hover); }
  .add-link { white-space: nowrap; display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 10px; border: 0; border-radius: 7px; background: transparent; color: var(--accent-text); font: inherit; font-size: 12.5px; text-align: left; cursor: pointer; }
  .add-link:hover { background: var(--hover); }
  .add-link:disabled { opacity: 0.6; cursor: default; }
  .connect { position: relative; display: flex; margin-top: 8px; }
  .connect .add-link { flex: 1; min-width: 0; }
  .connect:hover .remove, .connect .remove:focus-visible { display: inline-flex; top: 8px; }
  .add-link.two { height: auto; min-height: 28px; padding: 4px 10px; align-items: flex-start; }
  .add-link.two :global(svg) { margin-top: 3px; flex: none; }
  .two-lines { display: flex; flex-direction: column; min-width: 0; }
  .two-lines .sub { font-size: 11px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .add { margin: 4px 6px; padding: 8px; border-radius: 8px; background: var(--card); box-shadow: var(--shadow-sm); display: flex; flex-direction: column; gap: 8px; font-size: 12.5px; }
  /* The composer's address field, fitted to the sidebar: no label row, chips and typing on their own lines. */
  .add :global(.field) { padding: 0; border-bottom: 0; min-height: 0; gap: 0; }
  .add :global(.lbl) { display: none; }
  .add :global(.chip) { max-width: 100%; }
  .add :global(.input-wrap) { min-width: 0; flex: 1 1 100%; }
  .add :global(input) { box-sizing: border-box; padding: 4px 6px; border-radius: 6px; background: var(--surface); box-shadow: 0 0 0 1px var(--sep-strong); }
  .add-actions { display: flex; gap: 6px; justify-content: flex-end; }
  .add-actions button { height: 24px; padding: 0 10px; border: 0; border-radius: 6px; background: var(--surface); box-shadow: 0 0 0 1px var(--sep-strong); color: var(--text); font: inherit; cursor: pointer; }
  .add-actions button.primary { background: var(--accent); box-shadow: none; color: var(--on-accent); font-weight: 600; }
  .add-actions button:disabled { opacity: 0.55; cursor: default; }
  .add-hint { font-size: 11px; color: var(--text-3); }
  .empty { margin: 2px 10px 0; font-size: 11.5px; line-height: 1.35; color: var(--text-3); }
  .cal { display: flex; align-items: center; gap: 9px; height: 28px; padding: 0 10px; border: 0; border-radius: 7px; background: transparent; color: var(--text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
  .cal:hover { background: var(--hover); }
  .box { flex: none; width: 14px; height: 14px; border-radius: 4px; border: 1.5px solid var(--c); background: transparent; color: #fff; display: inline-flex; align-items: center; justify-content: center; }
  .cal[aria-checked="true"] .box { background: var(--c); }
  .mini { margin-top: 18px; padding: 12px 6px 4px; border-top: 1px solid var(--sep); }
  .mini-head { display: flex; align-items: center; margin-bottom: 6px; }
  .mini-title { flex: 1; font-size: 12.5px; }
  .mini-title b { font-weight: 700; }
  .mini-head button { width: 22px; height: 22px; border: 0; border-radius: 5px; background: transparent; color: var(--text-2); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
  .mini-head button:hover { background: var(--hover); }
  .mini-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); text-align: center; font-size: 11px; row-gap: 1px; }
  .dow { color: var(--text-3); font-weight: 600; padding-bottom: 2px; }
  .mini-grid button { height: 22px; border: 0; border-radius: 11px; background: transparent; color: var(--text); font: inherit; font-size: 11px; cursor: pointer; padding: 0; }
  .mini-grid button:hover { background: var(--hover); }
  .mini-grid button.out { color: var(--text-3); }
  .mini-grid button.in-range { background: var(--sidebar-active); border-radius: 0; }
  .mini-grid button.today { background: #e3261b; color: #fff; font-weight: 700; border-radius: 11px; }
  :global(:root[data-theme="dark"]) .mini-grid button.today { background: #ff453a; }
  button:focus-visible { outline: none; box-shadow: var(--focus); }
</style>
