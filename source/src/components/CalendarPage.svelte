<script lang="ts">
  // The Calendar page, in the manner of Apple Calendar: Day / Week / Month / Year in a centred switch, search,
  // a big "November 2026" with ‹ Today ›, a red today and now line, tinted events with a coloured edge, and an
  // event's details in a popover (a side panel in Day). Events come from the user's Exchange calendars and
  // Thunderbird's own, such as Google's (calendar.svelte.ts); hidden calendars and the view are saved settings.
  import { tick } from "svelte";
  import { store } from "../lib/store.svelte";
  import { calendar } from "../lib/calendar.svelte";
  import { composer } from "../lib/compose.svelte";
  import {
    CALENDAR_MODES, HOUR_PX, calendarOf, eventTitle, addDays, allDayOn, daysOf, eventKey, eventLook, inAllDayRow, miniMonth, monthCells, ms,
    oncePerSeries, placeDay, sameDay, searchEvents, shortTime, shownEvents, startOfDay, titleFor, weekdayNames, type CalendarMode,
  } from "../lib/calendar-grid";
  import type { CalendarEvent } from "../lib/meeting-status";
  import { draftForSlot, draftFromEvent, hm, ymd } from "../lib/calendar-edit";
  import CalendarEventCard from "./CalendarEventCard.svelte";
  import Icon from "./Icon.svelte";

  const MODE_LABEL: Record<CalendarMode, string> = { day: "Day", week: "Week", month: "Month", year: "Year" };

  // Open in the saved view, on today.
  calendar.mode = store.settings.calendarMode || "week";
  calendar.anchor = startOfDay(Date.now()).getTime();
  calendar.selected = null;
  if (!calendar.calendarsLoaded) void calendar.loadCalendars();
  void calendar.load();

  $effect(() => {
    let ticks = 0;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      calendar.now = Date.now();
      // Read again every five minutes while the page is on screen.
      if (++ticks % 10 === 0) void calendar.load(true);
    }, 30000);
    const changed = () => calendar.changed();
    const visible = () => { if (document.visibilityState === "visible") { calendar.now = Date.now(); void calendar.load(); } };
    window.addEventListener("spark:calendar-changed", changed);
    document.addEventListener("visibilitychange", visible);
    return () => { clearInterval(timer); window.removeEventListener("spark:calendar-changed", changed); document.removeEventListener("visibilitychange", visible); };
  });

  const hidden = $derived(calendar.hiddenKeys());
  const shown = $derived(shownEvents(calendar.events, hidden));
  const weekdays = weekdayNames(calendar.firstDay);
  const title = $derived(titleFor(calendar.mode, calendar.anchor, calendar.firstDay));
  const today = $derived(startOfDay(calendar.now).getTime());

  /** Each event's calendar colour (main calendars: their account's place, like the sidebar's account dots). */
  const colorOf = (e: CalendarEvent) => calendar.colorOf(calendarOf(e));
  const calendarName = (e: CalendarEvent) => calendar.nameOf(calendarOf(e));

  function setMode(mode: CalendarMode, anchor = calendar.anchor) {
    calendar.show(mode, anchor);
    if (store.settings.calendarMode !== mode) void store.setSetting("calendarMode", mode).catch(() => {});
  }

  // ---- Day and Week ----
  const columns = $derived.by(() => {
    if (calendar.mode !== "day" && calendar.mode !== "week") return [];
    const { start, end } = calendar.range();
    return daysOf(start, end).map((date) => ({
      date, isToday: date.getTime() === today, weekend: date.getDay() === 0 || date.getDay() === 6,
      allDay: allDayOn(shown, date), placed: placeDay(shown, date, HOUR_PX),
    }));
  });
  const showsToday = $derived(columns.some((c) => c.isToday));
  const nowTop = $derived(((calendar.now - today) / 3600000) * HOUR_PX);
  const nowLabel = $derived(new Date(calendar.now).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
  const hours = Array.from({ length: 24 }, (_, h) => ({ h, label: h === 0 ? "" : new Date(2026, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" }) }));
  let scroller = $state<HTMLElement | null>(null);
  let scrolledFor = "";
  // On opening a day or week: the morning, or an hour and a half before now when today is shown.
  $effect(() => {
    const key = `${calendar.mode}|${calendar.anchor}`;
    if (!scroller || key === scrolledFor || !columns.length) return;
    scrolledFor = key;
    const hour = showsToday ? Math.max(0, (calendar.now - today) / 3600000 - 1.5) : 7.5;
    scroller.scrollTop = Math.round(hour * HOUR_PX);
  });

  // ---- Month and Year ----
  const cells = $derived(calendar.mode === "month" ? monthCells(calendar.anchor, calendar.firstDay, shown) : []);
  // As many events as fit in a cell (20 px each under the date), then "N more".
  let monthHeight = $state(0);
  const MONTH_ROWS = $derived(Math.max(1, Math.floor(((monthHeight - 28) / Math.max(1, cells.length / 7) - 36) / 20)));
  const year = $derived(new Date(calendar.anchor).getFullYear());
  const months = $derived(calendar.mode === "year" ? Array.from({ length: 12 }, (_, m) => ({ month: m, name: new Date(year, m, 1).toLocaleDateString(undefined, { month: "long" }), days: miniMonth(year, m, calendar.firstDay) })) : []);

  // ---- The open event ----
  const selected = $derived(calendar.selectedEvent);
  // Where the popover would like to be (beside the event's day, level with it); `pop` is that, kept inside the
  // window. Its height is watched, since the invitees and emails arrive after it opens and it grows.
  let want = $state<{ left: number; top: number } | null>(null);
  let popEl = $state<HTMLElement | null>(null);
  let popHeight = $state(0);
  let winW = $state(window.innerWidth), winH = $state(window.innerHeight);
  const POP_W = 300;
  const pop = $derived(want ? {
    left: Math.max(8, Math.min(want.left, winW - POP_W - 8)),
    top: Math.max(8, Math.min(want.top, winH - popHeight - 8)),
  } : null);
  $effect(() => {
    const el = popEl;
    if (!el) return;
    popHeight = el.offsetHeight;
    const watch = new ResizeObserver(() => { popHeight = el.offsetHeight; });
    watch.observe(el);
    return () => watch.disconnect();
  });
  function place(target: Element) {
    const rect = target.getBoundingClientRect();
    // Beside the whole day (not the event), so it doesn't cover a meeting next to it in the same day.
    const day = (target.closest(".day-col, .all-day, .m-cell") || target).getBoundingClientRect();
    const left = day.right + 6 + POP_W <= window.innerWidth - 8 ? day.right + 6 : Math.max(8, day.left - 6 - POP_W);
    want = { left, top: rect.top - 12 };
  }
  function open(event: CalendarEvent, target: Element) {
    if (dragged) return;
    if (calendar.selected === eventKey(event)) return close();
    calendar.select(event);
    if (calendar.mode !== "day") place(target);
  }
  function close() { calendar.select(null); want = null; }
  /** An event found by search: go to its day, then open it. */
  async function reveal(event: CalendarEvent) {
    search = ""; results = [];
    const mode = calendar.mode === "year" ? "week" : calendar.mode;
    setMode(mode, ms(event.start));
    await calendar.load();
    await tick();
    const shownEvent = calendar.events.find((e) => eventKey(e) === eventKey(event)) || event;
    const el = document.querySelector(`.calendar [data-key="${CSS.escape(eventKey(event))}"]`);
    calendar.select(shownEvent);
    if (calendar.mode !== "day") { if (el) place(el); else want = { left: Math.max(8, window.innerWidth / 2 - POP_W / 2), top: 120 }; }
    (el as HTMLElement | null)?.scrollIntoView?.({ block: "center" });
  }
  $effect(() => { if (!calendar.selected) want = null; });

  function outside(e: PointerEvent) {
    const target = e.target as Element;
    if (!calendar.selected || calendar.mode === "day") return;
    if (popEl?.contains(target) || target.closest?.(".ev, .m-ev")) return;
    close();
  }

  // ---- Changing the user's own events: double-click to edit, drag to move, drag the bottom edge to resize ----
  /** The user's own event on a calendar Ember can change (not someone else's meeting, a shared or read-only one). */
  const mine = (e: CalendarEvent) => e.response === "organizer" && !e.cancelled && !e.readOnly && !e.shared && !e.busyOnly;
  async function details(event: CalendarEvent) {
    await calendar.loadDetails(event);
    const source = calendar.details[eventKey(event)];
    if (!source || "error" in source) { store.toast({ text: `Couldn't read “${eventTitle(event)}”${source && "error" in source ? `: ${source.error}` : ""}`, kind: "error" }); return null; }
    return source;
  }
  async function editEvent(event: CalendarEvent) {
    if (!mine(event)) return;
    const source = await details(event);
    if (!source) return;
    close();
    void calendar.openEditor(draftFromEvent(source, store.me));
  }
  /** A new time for an event. With invitees, the editor opens with it, so the update is sent only on purpose. */
  async function reschedule(event: CalendarEvent, start: number, end: number, undo = true) {
    const source = await details(event);
    if (!source) return;
    const draft = draftFromEvent(source, store.me);
    const a = new Date(start), z = new Date(end);
    Object.assign(draft, { startDate: ymd(a), startTime: hm(a), endDate: ymd(z), endTime: hm(z) });
    close();
    if (draft.invitees.length) { void calendar.openEditor(draft); return; }
    // Shown at the new time at once; the calendar's next read confirms it (or puts it back).
    const before = { start: event.start, end: event.end };
    const key = eventKey(event);
    calendar.events = calendar.events.map((e) => eventKey(e) === key ? { ...e, start: a.toISOString(), end: z.toISOString() } : e);
    const result = await calendar.save(draft);
    if (!result.ok) {
      calendar.events = calendar.events.map((e) => eventKey(e) === key ? { ...e, ...before } : e);
      if (result.message) store.toast({ text: `Couldn't move “${eventTitle(event)}”: ${result.message}`, kind: "error" });
      return;
    }
    const day = sameDay(start, Date.now()) ? "" : `${a.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}, `;
    store.toast({
      text: ms(before.start) === start ? `“${eventTitle(event)}” is now ${shortTime(start)}–${shortTime(end)}` : `Moved “${eventTitle(event)}” to ${day}${shortTime(start)}–${shortTime(end)}`, kind: "success",
      action: undo ? { label: "Undo", run: () => void reschedule({ ...event, start: a.toISOString(), end: z.toISOString() }, ms(before.start), ms(before.end), false) } : undefined,
    });
  }

  const SNAP_MIN = 15;
  /** The event being dragged: how far (minutes) and how many days it has moved, or how much longer it is. */
  let drag = $state<{ key: string; kind: "move" | "resize"; minutes: number; days: number; colWidth: number } | null>(null);
  let dragFrom: { event: CalendarEvent; x: number; y: number; kind: "move" | "resize"; col: number; cols: DOMRect[]; scroll0: number; last: PointerEvent | null } | null = null;
  let edgeTimer: ReturnType<typeof setInterval> | undefined;
  let dragged = false; // a drag just ended: the click that follows it doesn't open the popover
  const draggable = (e: CalendarEvent) => mine(e) && !e.allDay && sameDay(ms(e.start), ms(e.end) - 1) && !calendar.saving;
  function dragStart(ev: PointerEvent, event: CalendarEvent, col: number) {
    if (ev.button !== 0 || !draggable(event)) return;
    const el = ev.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const cols = [...(el.closest(".grid-body")?.querySelectorAll(".day-col") || [])].map((c) => c.getBoundingClientRect());
    dragFrom = { event, x: ev.clientX, y: ev.clientY, kind: rect.height >= 22 && ev.clientY >= rect.bottom - 7 ? "resize" : "move", col, cols, scroll0: scroller?.scrollTop || 0, last: null };
    try { el.setPointerCapture(ev.pointerId); } catch { /* not an active pointer */ }
  }
  /** Near the top or bottom of the hours, the grid scrolls (and the event with the pointer), so a drag can reach any time. */
  function edgeScroll() {
    const from = dragFrom, view = scroller;
    if (!from?.last || !view || !drag) return;
    const box = view.getBoundingClientRect();
    const top = box.top + 70, edge = 36; // below the sticky day and all-day rows
    const y = from.last.clientY;
    const speed = y < top + edge ? -Math.ceil((top + edge - y) / 4) : y > box.bottom - edge ? Math.ceil((y - (box.bottom - edge)) / 4) : 0;
    if (!speed) return;
    const before = view.scrollTop;
    view.scrollTop += speed;
    if (view.scrollTop !== before) dragMove(from.last);
  }
  function dragMove(ev: PointerEvent) {
    const from = dragFrom;
    if (!from) return;
    from.last = ev;
    if (!drag && Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < 5) return;
    if (!edgeTimer) edgeTimer = setInterval(edgeScroll, 30);
    const step = (SNAP_MIN / 60) * HOUR_PX;
    let minutes = Math.round((ev.clientY - from.y + (scroller?.scrollTop || 0) - from.scroll0) / step) * SNAP_MIN;
    const start = ms(from.event.start), end = ms(from.event.end);
    const dayStart = startOfDay(new Date(start)).getTime();
    let days = 0;
    if (from.kind === "move") {
      const over = from.cols.findIndex((r) => ev.clientX >= r.left && ev.clientX < r.right);
      days = over < 0 ? (drag?.days ?? 0) : over - from.col;
      // Kept within its day: from midnight to the end of the day.
      minutes = Math.max(minutes, -Math.floor((start - dayStart) / 60000));
      minutes = Math.min(minutes, Math.floor((dayStart + 86400000 - end) / 60000));
    } else {
      minutes = Math.max(minutes, SNAP_MIN - Math.round((end - start) / 60000));
      minutes = Math.min(minutes, Math.floor((dayStart + 86400000 - end) / 60000));
    }
    drag = { key: eventKey(from.event), kind: from.kind, minutes, days, colWidth: from.cols[0]?.width || 0 };
  }
  function stopEdge() { clearInterval(edgeTimer); edgeTimer = undefined; }
  function dragEnd() {
    stopEdge();
    const from = dragFrom, done = drag;
    dragFrom = null; drag = null;
    if (!from || !done) return;
    dragged = true; setTimeout(() => { dragged = false; }, 0);
    if (!done.minutes && !done.days) return;
    const shift = (t: number) => { const d = new Date(t); d.setDate(d.getDate() + done.days); return d.getTime() + done.minutes * 60000; };
    const start = ms(from.event.start), end = ms(from.event.end);
    if (done.kind === "move") void reschedule(from.event, shift(start), shift(end));
    else void reschedule(from.event, start, end + done.minutes * 60000);
  }
  function dragCancel() { stopEdge(); dragFrom = null; drag = null; }

  // ---- Drag on an empty part of a day: a new event for that time ----
  let making = $state<{ col: number; from: number; to: number } | null>(null); // minutes from midnight
  let makeFrom: { col: number; date: Date; y0: number; top: number; minute: number } | null = null;
  function makeStart(ev: PointerEvent, date: Date, col: number) {
    if (ev.button !== 0 || (ev.target as Element).closest?.(".ev") || !calendar.canCreate || !calendar.calendars.length) return;
    const box = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const minute = Math.max(0, Math.min(24 * 60 - SNAP_MIN, Math.floor(((ev.clientY - box.top) / HOUR_PX) * 60 / SNAP_MIN) * SNAP_MIN));
    makeFrom = { col, date, y0: ev.clientY, top: box.top, minute };
    try { (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId); } catch { /* not an active pointer */ }
  }
  function makeMove(ev: PointerEvent) {
    const from = makeFrom;
    if (!from || (!making && Math.abs(ev.clientY - from.y0) < 6)) return;
    const at = Math.max(0, Math.min(24 * 60, Math.round(((ev.clientY - from.top) / HOUR_PX) * 60 / SNAP_MIN) * SNAP_MIN));
    const a = Math.min(from.minute, at), z = Math.max(from.minute + (at > from.minute ? 0 : SNAP_MIN), at);
    making = { col: from.col, from: a, to: Math.max(z, a + SNAP_MIN) };
  }
  function makeEnd() {
    const from = makeFrom, done = making;
    makeFrom = null; making = null;
    if (!from || !done) return;
    dragged = true; setTimeout(() => { dragged = false; }, 0);
    const day = startOfDay(from.date);
    const at = (minutes: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes).getTime();
    newEvent(at(done.from), at(done.to));
  }

  // ---- Search ----
  let search = $state("");
  let results = $state<{ event: CalendarEvent; count: number }[]>([]);
  let searching = $state(false);
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  function typed() {
    clearTimeout(searchTimer);
    const query = search.trim();
    if (!query) { results = []; return; }
    searchTimer = setTimeout(async () => {
      searching = true;
      try {
        const pool = shownEvents(await calendar.searchRange(), hidden);
        if (search.trim() === query) results = oncePerSeries(searchEvents(pool, query), Date.now()).slice(0, 20);
      } catch (e: any) { store.toast({ text: `Couldn't search your calendar: ${e?.message || e}`, kind: "error" }); }
      finally { searching = false; }
    }, 250);
  }

  // ---- New events ----
  /** A new event: at a slot, or the next hour of the shown day (today: the next hour from now). */
  async function connectAccount(accountId: string) {
    const result = await calendar.connect(accountId);
    if (result.message) store.toast({ text: result.ok ? result.message : `Couldn't connect the calendars: ${result.message}`, kind: result.ok ? "success" : "error" });
  }
  function newEvent(start?: number, end?: number, allDay = false) {
    if (start === undefined) {
      const onToday = sameDay(calendar.anchor, calendar.now);
      const base = new Date(onToday ? calendar.now : calendar.anchor + 9 * 3600000);
      base.setMinutes(0, 0, 0);
      if (onToday) base.setHours(base.getHours() + 1);
      start = base.getTime(); end = start + 3600000;
    }
    close();
    void calendar.openEditor(draftForSlot(calendar.defaultCalendar(hidden), start, end ?? start + 3600000, allDay));
  }
  /** Double-click an empty spot in a day: an hour from that half hour. */
  function slotAt(e: MouseEvent, date: Date) {
    if ((e.target as Element).closest?.(".ev")) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const minutes = Math.max(0, Math.min(23 * 60 + 30, Math.floor(((e.clientY - rect.top) / HOUR_PX) * 2) * 30));
    const start = new Date(date); start.setHours(0, minutes, 0, 0);
    newEvent(start.getTime(), start.getTime() + 3600000);
  }
  function dayAt(e: MouseEvent, date: Date) {
    if ((e.target as Element).closest?.(".ev, .m-ev, .m-num, .m-more")) return;
    newEvent(startOfDay(date).getTime(), addDays(date, 1).getTime(), true);
  }

  function onKey(e: KeyboardEvent) {
    if (store.view.kind !== "calendar" || composer.open || calendar.editor || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) { if (e.key === "Escape" && t.closest(".cal-search")) { search = ""; results = []; t.blur(); } return; }
    const keys: Record<string, () => void> = {
      ArrowLeft: () => calendar.move(-1), ArrowRight: () => calendar.move(1), t: () => calendar.today(),
      n: () => { if (calendar.canCreate && calendar.calendars.length) newEvent(); },
      d: () => setMode("day"), w: () => setMode("week"), m: () => setMode("month"), y: () => setMode("year"),
      Escape: () => { if (calendar.selected) close(); },
    };
    const run = keys[e.key];
    if (run && !(e.key === "Escape" && !calendar.selected)) { e.preventDefault(); e.stopPropagation(); run(); }
  }

  const label = (e: CalendarEvent) => `${eventTitle(e)}${e.shared ? `, ${calendarName(e)}` : ""}, ${e.allDay ? "all day" : `${shortTime(ms(e.start))} to ${shortTime(ms(e.end))}`}${e.location ? `, ${e.location}` : ""}${e.response === "none" ? ", not answered" : e.response === "tentative" ? ", maybe" : ""}`;
  const dayLabel = (d: Date) => d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
</script>

<svelte:window onkeydown={onKey} onpointerdown={outside} bind:innerWidth={winW} bind:innerHeight={winH} />

<section class="calendar" aria-label="Calendar">
  <div class="toolbar">
    <span class="tb-side">
      {#if calendar.canCreate && calendar.calendars.length}
        <button class="add" aria-label="New event" title="New event (N) · or double-click a time" onclick={() => newEvent()}><Icon name="plus" size={17} stroke={2} /></button>
      {/if}
    </span>
    <div class="modes" role="group" aria-label="View">
      {#each CALENDAR_MODES as mode (mode)}
        <button aria-pressed={calendar.mode === mode} title="{MODE_LABEL[mode]} ({mode[0].toUpperCase()})" onclick={() => setMode(mode)}>{MODE_LABEL[mode]}</button>
      {/each}
    </div>
    <span class="tb-side end">
      <label class="cal-search">
        <Icon name="search" size={13} />
        <input type="search" placeholder="Search" aria-label="Search events" autocomplete="off" bind:value={search} oninput={typed} onkeydown={(e) => { if (e.key === "Enter" && results[0]) { e.preventDefault(); void reveal(results[0].event); } }} />
      </label>
      {#if search.trim()}
        <div class="results" role="listbox" aria-label="Events found">
          {#each results as { event: e, count } (eventKey(e))}
            <button role="option" aria-selected="false" onclick={() => reveal(e)} title={count > 1 ? `Repeats · ${count} found a month either side` : undefined}>
              <span class="dot" style:background={colorOf(e)}></span>
              <span class="r-title">{eventTitle(e)}</span>
              <span class="r-when">{new Date(ms(e.start)).toLocaleDateString(undefined, { month: "short", day: "numeric" })}{e.allDay ? "" : ` · ${shortTime(ms(e.start))}`}{count > 1 ? " · repeats" : ""}</span>
            </button>
          {:else}
            <p class="r-empty">{searching ? "Searching…" : "No events a month either side"}</p>
          {/each}
        </div>
      {/if}
    </span>
  </div>

  <div class="titlebar">
    <h1><b>{title.bold}</b> {title.rest}</h1>
    {#if calendar.loading}<span class="mini-spin" aria-label="Reading your calendar"></span>{/if}
    {#if calendar.error}
      <span class="cal-error" title={calendar.error}>{calendar.failed ? "Couldn't read your calendar" : "Couldn't read one calendar"} <button onclick={() => calendar.load(true)}>Try again</button></span>
    {/if}
    <span class="grow"></span>
    <div class="nav">
      <button aria-label="Previous {calendar.mode}" title="Previous (←)" onclick={() => calendar.move(-1)}><Icon name="chevronLeft" size={13} stroke={2.4} /></button>
      <button class="today" title="Today (T)" onclick={() => calendar.today()}>Today</button>
      <button aria-label="Next {calendar.mode}" title="Next (→)" onclick={() => calendar.move(1)}><Icon name="chevronRight" size={13} stroke={2.4} /></button>
    </div>
  </div>

  {#if calendar.calendarsLoaded && !calendar.calendars.length}
    <div class="empty-page">
      <Icon name="calendar" size={28} />
      <p><b>No calendars to show yet.</b></p>
      <p>Ember shows your Exchange calendars and the calendars in Thunderbird, such as Google Calendar and iCloud.</p>
      {#each calendar.toConnect as a (a.accountId)}
        <button class="connect" disabled={!!calendar.connecting} onclick={() => void connectAccount(a.accountId)}>{calendar.connecting === a.accountId ? "Connecting…" : a.google ? `Connect Google Calendar for ${a.email}` : `Find calendars for ${a.email}`}</button>
      {/each}
    </div>
  {:else}
  <div class="body" class:with-panel={calendar.mode === "day"}>
    {#if calendar.mode === "day" || calendar.mode === "week"}
      <div class="grid-scroll" bind:this={scroller} style:--cols={columns.length}>
        <div class="grid-head">
          <span class="gutter"></span>
          {#each columns as c (c.date.getTime())}
            <button class="col-head" class:today={c.isToday} class:single={calendar.mode === "day"} aria-label={dayLabel(c.date)} onclick={() => setMode("day", c.date.getTime())}>
              <span class="dow">{calendar.mode === "day" ? weekdays[(c.date.getDay() - calendar.firstDay + 7) % 7].long : weekdays[(c.date.getDay() - calendar.firstDay + 7) % 7].short}</span>
              <span class="num">{c.date.getDate()}</span>
            </button>
          {/each}
          <span class="gutter all-day-label">all-day</span>
          {#each columns as c (c.date.getTime())}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="all-day" class:weekend={c.weekend} ondblclick={(e) => dayAt(e, c.date)}>
              {#each c.allDay as e (eventKey(e))}
                <button class="ev flat {eventLook(e)}" class:selected={calendar.selected === eventKey(e)} data-key={eventKey(e)} style:--c={colorOf(e)} aria-label={label(e)} onclick={(ev) => open(e, ev.currentTarget)} ondblclick={(ev) => { ev.stopPropagation(); void editEvent(e); }}>{eventTitle(e)}</button>
              {/each}
            </div>
          {/each}
        </div>
        <div class="grid-body" style:height="{24 * HOUR_PX}px">
          <div class="gutter hours">
            {#each hours as h (h.h)}<span style:top="{h.h * HOUR_PX}px" class:covered={showsToday && Math.abs(h.h * HOUR_PX - nowTop) < 11}>{h.label}</span>{/each}
            {#if showsToday}<span class="now-label" style:top="{nowTop}px">{nowLabel}</span>{/if}
          </div>
          {#each columns as c, ci (c.date.getTime())}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="day-col" class:weekend={c.weekend} style:--hour="{HOUR_PX}px" ondblclick={(e) => slotAt(e, c.date)}
              onpointerdown={(e) => makeStart(e, c.date, ci)} onpointermove={makeMove} onpointerup={makeEnd} onpointercancel={() => { makeFrom = null; making = null; }}>
              {#if making?.col === ci}
                <div class="making" style:top="{(making.from / 60) * HOUR_PX}px" style:height="{((making.to - making.from) / 60) * HOUR_PX}px" aria-hidden="true">
                  <b>New event</b><span>{shortTime(startOfDay(c.date).getTime() + making.from * 60000)}–{shortTime(startOfDay(c.date).getTime() + making.to * 60000)}</span>
                </div>
              {/if}
              {#each c.placed as p (eventKey(p.event))}
                {@const e = p.event}
                {@const moving = drag?.key === eventKey(e) ? drag : null}
                {@const grow = moving?.kind === "resize" ? (moving.minutes / 60) * HOUR_PX : 0}
                {@const shift = moving?.kind === "move" ? (moving.minutes / 60) * HOUR_PX : 0}
                <button class="ev {eventLook(e)}" class:selected={calendar.selected === eventKey(e)} class:editable={draggable(e)} class:dragging={!!moving} class:short={p.height + grow < 30} data-key={eventKey(e)} style:--c={colorOf(e)}
                  style:top="{p.top + 1 + shift}px" style:height="{p.height - 2 + grow}px" style:left="calc({(p.lane * 100) / p.lanes}% + 1px)" style:width="calc({100 / p.lanes}% - 3px)"
                  style:transform={moving?.days ? `translateX(${moving.days * moving.colWidth}px)` : undefined}
                  aria-label={label(e)} title={draggable(e) ? "Double-click to edit · drag to move · drag the bottom edge to change the length" : undefined}
                  onclick={(ev) => open(e, ev.currentTarget)} ondblclick={(ev) => { ev.stopPropagation(); void editEvent(e); }}
                  onpointerdown={(ev) => dragStart(ev, e, ci)} onpointermove={dragMove} onpointerup={dragEnd} onpointercancel={dragCancel}>
                  <span class="ev-title" style:-webkit-line-clamp={p.height + grow >= 30 ? Math.max(1, Math.floor((p.height + grow - 8 - (p.height >= 38 || moving ? 14 : 0) - (p.height >= 70 && e.location ? 14 : 0)) / 14.4)) : undefined}>{eventTitle(e)}</span>
                  {#if moving}<span class="ev-sub">{shortTime(ms(e.start) + (moving.kind === "move" ? moving.minutes * 60000 : 0))}–{shortTime(ms(e.end) + moving.minutes * 60000)}</span>
                  {:else if p.height >= 38 || p.height < 30}<span class="ev-sub">{shortTime(ms(e.start))}</span>{/if}
                  {#if p.height >= 70 && e.location}<span class="ev-sub ellipsis">{e.location}</span>{/if}
                </button>
              {/each}
              {#if c.isToday}<div class="now-line" style:top="{nowTop}px" aria-hidden="true"><span></span></div>{/if}
            </div>
          {/each}
        </div>
      </div>
    {:else if calendar.mode === "month"}
      <div class="month" style:--weeks={cells.length / 7} bind:clientHeight={monthHeight}>
        {#each weekdays as w (w.short)}<div class="m-dow">{w.short}</div>{/each}
        {#each cells as cell (cell.date.getTime())}
          {@const isToday = cell.date.getTime() === today}
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="m-cell" class:out={!cell.inMonth} class:weekend={cell.date.getDay() === 0 || cell.date.getDay() === 6} ondblclick={(e) => dayAt(e, cell.date)}>
            <button class="m-num" class:today={isToday} aria-label={dayLabel(cell.date)} title="Show this day" onclick={() => setMode("day", cell.date.getTime())}>{cell.date.getDate() === 1 ? cell.date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : cell.date.getDate()}</button>
            {#each cell.events.slice(0, cell.events.length > MONTH_ROWS + 1 ? MONTH_ROWS : MONTH_ROWS + 1) as e (eventKey(e))}
              {@const bar = inAllDayRow(e)}
              <button class="m-ev {eventLook(e)}" class:ev={bar} class:flat={bar} class:selected={calendar.selected === eventKey(e)} data-key={eventKey(e)} style:--c={colorOf(e)} aria-label={label(e)} onclick={(ev) => open(e, ev.currentTarget)} ondblclick={(ev) => { ev.stopPropagation(); void editEvent(e); }}>
                {#if !bar}<span class="m-dot"></span>{/if}
                <span class="m-title">{eventTitle(e)}</span>
                {#if !bar}<span class="m-time">{shortTime(ms(e.start))}</span>{/if}
              </button>
            {/each}
            {#if cell.events.length > MONTH_ROWS + 1}
              <button class="m-more" onclick={() => setMode("day", cell.date.getTime())}>{cell.events.length - MONTH_ROWS} more</button>
            {/if}
          </div>
        {/each}
      </div>
    {:else}
      <div class="year">
        {#each months as mo (mo.month)}
          <div class="y-month">
            <button class="y-name" class:current={year === new Date(today).getFullYear() && mo.month === new Date(today).getMonth()} onclick={() => setMode("month", new Date(year, mo.month, 1).getTime())}>{mo.name}</button>
            <div class="y-grid">
              {#each weekdays as w (w.short)}<span class="y-dow">{w.letter}</span>{/each}
              {#each mo.days as d (d.date.getTime())}
                {#if d.inMonth}
                  <button class="y-day" class:today={d.date.getTime() === today} aria-label={dayLabel(d.date)} onclick={() => setMode("day", d.date.getTime())}>{d.date.getDate()}</button>
                {:else}<span></span>{/if}
              {/each}
            </div>
          </div>
        {/each}
      </div>
    {/if}

    {#if calendar.mode === "day"}
      <aside class="day-panel" aria-label="Event details">
        {#if selected}
          <CalendarEventCard event={selected} panel color={colorOf(selected)} calendarName={calendarName(selected)} others={shown} />
        {:else}
          <p class="pick">{columns[0]?.placed.length || columns[0]?.allDay.length ? "Pick an event to see it here." : `Nothing on ${dayLabel(new Date(calendar.anchor))}.`}</p>
        {/if}
      </aside>
    {/if}
  </div>
  {/if}

  {#if selected && pop && calendar.mode !== "day"}
    <div class="popover" bind:this={popEl} style:left="{pop.left}px" style:top="{pop.top}px" style:width="{POP_W}px">
      <CalendarEventCard event={selected} color={colorOf(selected)} calendarName={calendarName(selected)} others={shown} onclose={close} />
    </div>
  {/if}
</section>

<style>
  .calendar {
    --cal-red: #e3261b;
    --weekend: #fafafa;
    --seg: rgba(118, 118, 128, 0.12);
    --seg-on: #ffffff;
    --field: rgba(118, 118, 128, 0.12);
    --line: rgba(0, 0, 0, 0.09);
    --line-soft: rgba(0, 0, 0, 0.05);
    flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; background: var(--bg); font-size: 13px;
  }
  :global(:root[data-theme="dark"]) .calendar {
    --cal-red: #ff453a;
    --weekend: rgba(255, 255, 255, 0.02);
    --seg: rgba(118, 118, 128, 0.24);
    --seg-on: #636366;
    --field: rgba(118, 118, 128, 0.24);
    --line: rgba(255, 255, 255, 0.1);
    --line-soft: rgba(255, 255, 255, 0.05);
  }
  button { font: inherit; color: inherit; }
  button:focus-visible, input:focus-visible { outline: none; box-shadow: var(--focus); }

  .toolbar { display: flex; align-items: center; gap: 10px; height: 52px; padding: 0 16px; border-bottom: 1px solid var(--line); flex: none; }
  .tb-side { flex: 1 1 120px; display: flex; align-items: center; position: relative; }
  .tb-side.end { justify-content: flex-end; }
  .add { width: 30px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: var(--text-2); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
  .add:hover { background: var(--hover); color: var(--text); }
  .modes { display: inline-flex; padding: 2px; border-radius: 8px; background: var(--seg); }
  .modes button { min-width: 64px; height: 24px; padding: 0 12px; border: 0; border-radius: 6px; background: transparent; font-size: 13px; cursor: pointer; }
  .modes button[aria-pressed="true"] { background: var(--seg-on); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12), 0 0 0 0.5px rgba(0, 0, 0, 0.04); font-weight: 600; }
  .cal-search { display: inline-flex; align-items: center; gap: 6px; width: 200px; height: 28px; padding: 0 8px; border-radius: 7px; background: var(--field); color: var(--text-3); }
  .cal-search input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--text); font: inherit; font-size: 13px; outline: none; }
  .cal-search:focus-within { box-shadow: var(--focus); }
  .results { position: absolute; right: 0; top: 34px; z-index: 30; width: 320px; max-height: 360px; overflow: auto; padding: 4px; border-radius: 10px; background: var(--surface); border: 1px solid var(--sep-strong); box-shadow: var(--shadow-lg); }
  .results button { width: 100%; display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 8px; border: 0; border-radius: 6px; background: transparent; text-align: left; cursor: pointer; }
  .results button:hover { background: var(--hover); }
  .results .dot { width: 8px; height: 8px; border-radius: 4px; flex: none; }
  .r-title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .r-when { color: var(--text-3); font-size: 12px; white-space: nowrap; }
  .r-empty { margin: 0; padding: 8px; color: var(--text-3); }

  .titlebar { display: flex; align-items: center; gap: 10px; padding: 14px 20px 10px; flex: none; }
  h1 { margin: 0; font-size: 26px; font-weight: 400; letter-spacing: -0.02em; white-space: nowrap; }
  h1 b { font-weight: 700; }
  .grow { flex: 1; }
  .cal-error { font-size: 12px; color: var(--cal-red); }
  .cal-error button { border: 0; background: transparent; color: var(--accent-text); cursor: pointer; padding: 0 2px; }
  .nav { display: inline-flex; align-items: center; border: 1px solid var(--sep-strong); border-radius: 7px; overflow: hidden; background: var(--surface); }
  .nav button { height: 24px; min-width: 28px; border: 0; background: transparent; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
  .nav button:hover { background: var(--hover); }
  .nav .today { padding: 0 10px; border-left: 1px solid var(--sep-strong); border-right: 1px solid var(--sep-strong); font-size: 12.5px; }
  .mini-spin { width: 13px; height: 13px; border-radius: 50%; border: 2px solid var(--sep-strong); border-top-color: var(--text-3); animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .body { flex: 1; min-height: 0; display: flex; }
  .empty-page { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: var(--text-2); text-align: center; padding: 24px; }
  .empty-page p { margin: 0; }
  .empty-page .connect { margin-top: 12px; height: 30px; padding: 0 16px; border: 0; border-radius: 8px; background: var(--accent); color: var(--on-accent); font: inherit; font-weight: 600; cursor: pointer; }
  .empty-page .connect:disabled { opacity: 0.6; cursor: default; }

  /* Day and Week */
  .grid-scroll { flex: 1; min-width: 0; overflow-y: auto; position: relative; --gutter: 56px; }
  .grid-head, .grid-body { display: grid; grid-template-columns: var(--gutter) repeat(var(--cols), minmax(0, 1fr)); }
  .grid-head { position: sticky; top: 0; z-index: 5; background: var(--bg); border-bottom: 1px solid var(--line); }
  .col-head { display: flex; align-items: center; justify-content: flex-end; gap: 5px; height: 32px; padding: 0 8px; border: 0; border-bottom: 1px solid var(--line); background: transparent; font-size: 13px; cursor: pointer; }
  .col-head.single { justify-content: flex-start; }
  .col-head:hover { background: var(--hover); }
  .col-head .num { min-width: 24px; height: 24px; padding: 0 3px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; font-weight: 500; }
  .col-head.today { color: var(--cal-red); }
  .col-head.today .num { background: var(--cal-red); color: #fff; font-weight: 700; }
  .grid-head > .gutter:first-child { border-bottom: 1px solid var(--line); }
  .all-day-label { font-size: 10.5px; color: var(--text-3); text-align: right; padding: 6px 8px 0 0; }
  .all-day { min-height: 26px; padding: 2px; border-left: 1px solid var(--line-soft); display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .weekend { background: var(--weekend); }
  .grid-body { position: relative; }
  .hours { position: relative; }
  .hours span { position: absolute; right: 8px; font-size: 10.5px; color: var(--text-3); transform: translateY(-50%); white-space: nowrap; }
  .hours .now-label { right: 4px; font-weight: 700; color: var(--cal-red); background: var(--bg); padding: 0 2px; z-index: 2; }
  .day-col { position: relative; border-left: 1px solid var(--line-soft); background-image: repeating-linear-gradient(to bottom, var(--line) 0 1px, transparent 1px var(--hour)); min-width: 0; }
  .now-line { position: absolute; left: 0; right: 0; height: 1.5px; background: var(--cal-red); z-index: 3; pointer-events: none; }
  .now-line span { position: absolute; left: -4px; top: -3.25px; width: 8px; height: 8px; border-radius: 4px; background: var(--cal-red); }

  /* Events: a soft tint of the calendar's colour, a coloured edge, darker text of the same hue. */
  .ev {
    --tint: color-mix(in srgb, var(--c) 18%, transparent);
    --ink: color-mix(in srgb, var(--c) 55%, #000);
    position: absolute; box-sizing: border-box; padding: 3px 5px 3px 8px; border: 0; border-radius: 5px; text-align: left; overflow: hidden; cursor: pointer;
    display: flex; flex-direction: column; gap: 1px; background: var(--tint); color: var(--ink); box-shadow: inset 3px 0 0 var(--c); transition: filter var(--fast);
  }
  :global(:root[data-theme="dark"]) .ev { --tint: color-mix(in srgb, var(--c) 32%, transparent); --ink: color-mix(in srgb, var(--c) 40%, #fff); }
  .ev:hover { filter: saturate(1.25); }
  .ev.flat { position: static; height: 20px; flex-direction: row; align-items: center; padding: 0 6px; font-size: 11.5px; font-weight: 600; white-space: nowrap; text-overflow: ellipsis; box-shadow: none; display: block; line-height: 20px; }
  .ev.unanswered { background: transparent; outline: 1.5px dashed var(--c); outline-offset: -1.5px; }
  .ev.tentative { background: repeating-linear-gradient(135deg, var(--tint) 0 5px, transparent 5px 10px); }
  .ev.free { background: color-mix(in srgb, var(--c) 8%, transparent); }
  .ev.cancelled { opacity: 0.55; text-decoration: line-through; }
  .ev.selected { box-shadow: inset 3px 0 0 var(--c), 0 0 0 2px var(--c); z-index: 4; }
  .ev.flat.selected { box-shadow: 0 0 0 1.5px var(--c); }
  /* Words wrap whole (a narrow lane clips a long word rather than breaking it mid-word). */
  .ev-title { font-size: 11.5px; font-weight: 700; line-height: 1.25; overflow-wrap: normal; display: -webkit-box; -webkit-box-orient: vertical; overflow: hidden; flex: none; }
  /* Under half an hour: one line, the title then the time, so neither is cut through the middle. */
  .ev.short { flex-direction: row; align-items: center; gap: 5px; padding-top: 0; padding-bottom: 0; }
  .ev.short .ev-title, .ev.short .ev-sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.1; font-size: 10.5px; }
  .ev.short .ev-title { display: block; flex: 0 1 auto; min-width: 0; }
  .ev.short .ev-sub { flex: 0 100 auto; min-width: 0; }
  .hours span.covered { visibility: hidden; }
  .ev-sub { font-size: 11px; opacity: 0.85; }
  .ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* Month */
  .month { flex: 1; min-width: 0; display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); grid-template-rows: auto repeat(var(--weeks), minmax(96px, 1fr)); border-top: 1px solid var(--line); overflow-y: auto; }
  .m-dow { padding: 6px 8px; font-size: 12px; text-align: right; color: var(--text-2); }
  .m-cell { container-type: inline-size; padding: 4px 4px 6px; border-top: 1px solid var(--line); border-left: 1px solid var(--line-soft); display: flex; flex-direction: column; gap: 2px; min-width: 0; overflow: hidden; }
  .m-cell.out .m-num { color: var(--text-3); }
  .m-num { align-self: flex-end; min-width: 22px; height: 22px; padding: 0 5px; border: 0; border-radius: 11px; background: transparent; font-size: 12.5px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; flex: none; }
  .m-num:hover { background: var(--hover); }
  .m-num.today { background: var(--cal-red); color: #fff; font-weight: 700; }
  .m-ev { display: flex; align-items: center; gap: 5px; height: 18px; padding: 0 4px; border: 0; border-radius: 4px; background: transparent; font-size: 11.5px; text-align: left; white-space: nowrap; overflow: hidden; cursor: pointer; flex: none; }
  .m-ev:not(.ev):hover { background: var(--hover); }
  .m-ev:not(.ev).selected { background: color-mix(in srgb, var(--c) 18%, transparent); }
  .m-ev.ev { position: static; height: 18px; line-height: 18px; padding: 0 6px; }
  .m-ev:not(.ev).cancelled .m-title { text-decoration: line-through; opacity: 0.6; }
  .m-ev:not(.ev).unanswered .m-dot { background: transparent; box-shadow: inset 0 0 0 1.5px var(--c); }
  .m-dot { flex: none; width: 7px; height: 7px; border-radius: 4px; background: var(--c); }
  .m-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 500; }
  .m-time { flex: none; color: var(--text-3); font-size: 11px; }
  /* A narrow day keeps the title and drops the time (it shows in the event's card). */
  @container (max-width: 150px) { .m-time { display: none; } }
  .m-more { align-self: flex-start; border: 0; background: transparent; padding: 0 4px; font-size: 11px; color: var(--text-3); cursor: pointer; }
  .m-more:hover { color: var(--text); text-decoration: underline; }

  /* Year */
  .year { flex: 1; min-width: 0; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 22px 28px; padding: 6px 24px 28px; align-content: start; }
  .y-name { border: 0; background: transparent; padding: 0 0 6px; font-size: 15px; font-weight: 700; cursor: pointer; }
  .y-name.current { color: var(--cal-red); }
  .y-name:hover { text-decoration: underline; }
  .y-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); text-align: center; font-size: 10.5px; row-gap: 2px; }
  .y-dow { color: var(--text-3); font-weight: 600; }
  .y-day { height: 20px; border: 0; border-radius: 10px; background: transparent; font-size: 10.5px; cursor: pointer; padding: 0; }
  .y-day:hover { background: var(--hover); }
  .y-day.today { background: var(--cal-red); color: #fff; font-weight: 700; }

  /* Day panel and popover */
  .day-panel { flex: 0 0 320px; border-left: 1px solid var(--line); padding: 16px 18px; overflow-y: auto; }
  .pick { margin: 0; color: var(--text-3); }
  .ev.editable { touch-action: none; }
  .ev.editable:not(.short)::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: 7px; cursor: ns-resize; }
  .making { position: absolute; left: 1px; right: 3px; z-index: 5; box-sizing: border-box; padding: 3px 6px 3px 8px; border-radius: 5px; overflow: hidden; pointer-events: none;
    display: flex; flex-direction: column; font-size: 11px; color: var(--accent-text); background: color-mix(in srgb, var(--accent) 22%, transparent); box-shadow: inset 3px 0 0 var(--accent); }
  .making b { font-size: 11.5px; }
  .ev.dragging { z-index: 6; opacity: 0.88; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.22); cursor: grabbing; transition: none; }
  .popover { --pop-bg: var(--surface); position: fixed; z-index: 40; box-sizing: border-box; max-height: calc(100vh - 16px); overflow-y: auto; padding: 14px 16px 12px; border-radius: 12px; background: var(--surface); border: 1px solid var(--sep-strong); box-shadow: 0 10px 34px rgba(0, 0, 0, 0.18), 0 2px 6px rgba(0, 0, 0, 0.08); }
  :global(:root[data-theme="dark"]) .popover { --pop-bg: #2c2c2e; background: #2c2c2e; }
</style>
