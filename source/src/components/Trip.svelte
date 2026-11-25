<script lang="ts">
  // A trip (trips.ts): what matters right now (or before you go, or the receipts after), the trip day by day in
  // its local time with home time underneath, the meetings on your calendar there, and the trip's emails.
  import { untrack } from "svelte";
  import { store } from "../lib/store.svelte";
  import { api, mailCache } from "../lib/api";
  import { briefFor } from "../lib/meeting-brief";
  import type { CalendarEvent } from "../lib/meeting-status";
  import { changeText, checkInTimes, dayKey, dayText, pinnedChanges, rightNow, timeText, timeline, tripDay, untilText, type Trip } from "../lib/trips";
  import { bookingIcon, tripReceipt, bothClocks, cardText, clockLine, mapLink, providers, soon, tripDates } from "../lib/trip-view";
  import { displayName, listDate } from "../lib/format";
  import Icon from "./Icon.svelte";

  let { id }: { id: string } = $props();
  const trip = $derived(store.trips.find((t) => t.id === id) ?? null);
  const now = $derived(store.clock);

  // Meetings on your calendar during the trip, at a place (not only a video link).
  let meetings = $state<CalendarEvent[]>([]);
  $effect(() => {
    const t = trip;
    if (!t || typeof api?.sparkCalendar?.calendarView !== "function") return;
    untrack(() => void Promise.resolve(api.sparkCalendar.calendarView(new Date(t.start.at).toISOString(), new Date(t.end.at).toISOString(), { details: true }))
      .then((view: any) => { meetings = (view?.events || []).filter((e: CalendarEvent) => !e.cancelled && !e.allDay && e.location && !/^(?:https?:|microsoft teams|zoom|google meet)/i.test(e.location.trim())); })
      .catch(() => {}));
  });
  const days = $derived.by(() => {
    if (!trip) return [];
    const base = timeline(trip);
    for (const e of meetings) {
      const at = { at: Date.parse(e.start), ...(trip.tz ? { tz: trip.tz } : {}) };
      const key = dayKey(at);
      let day = base.find((d) => d.key === key);
      if (!day) { day = { key, day: dayText(at), items: [] }; base.push(day); }
      day.items.push({ at, label: e.subject, detail: e.location, meeting: e } as any);
      day.items.sort((a, b) => a.at.at - b.at.at);
    }
    return base.sort((a, b) => a.key.localeCompare(b.key));
  });
  const nowMeetings = $derived(meetings.filter((e) => { const at = Date.parse(e.start); return now >= at - 3 * 3600000 && now < at + 30 * 60000; }));
  const cards = $derived(trip && trip.phase === "now" ? rightNow(trip, now) : []);
  const changes = $derived(trip ? pinnedChanges(trip, now) : []);
  const checkIns = $derived(trip && trip.phase === "upcoming" ? checkInTimes(trip.bookings, now).slice(0, 2) : []);
  const firstMeeting = $derived(trip?.phase === "upcoming" ? meetings.slice().sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0] : undefined);
  /** After the trip: receipts from its days (Clef's receipt signal). */
  const receipts = $derived.by(() => {
    if (!trip || trip.phase !== "past" || !store.settings.aiSort) return [];
    store.aiRev; store.cacheStatus.total;
    return mailCache.all().filter((m) => { const at = +new Date(m.date); return at >= trip.start.at - 86400000 && at <= trip.end.at + 3 * 86400000 && store.messageSignal(m, "receipt") && tripReceipt(m, trip); }).sort((a, b) => +new Date(a.date) - +new Date(b.date));
  });
  const eyebrow = (t: Trip) => t.phase === "upcoming" ? `Upcoming trip · ${untilText(t.start.at, now, store.homeTz)}` : t.phase === "now" ? (tripDay(t, now) < 1 ? "Travel day" : `On the trip · day ${tripDay(t, now)}`) : "Trip ended";
  const people = (e: CalendarEvent) => (e.attendees || []).filter((a) => !store.me.has(a.email.toLowerCase())).map((a) => a.name || a.email).slice(0, 4).join(", ");
  function recentEmail(e: CalendarEvent) { const brief = briefFor(e, store.me); if (brief) store.openBrief(brief); }
</script>

<section class="trip-page" aria-label={trip ? `${trip.city} trip` : "Trip"}>
  {#if !trip}
    <div class="empty"><Icon name="suitcase" size={32} /><h2>This trip isn't current any more</h2><p>Trips show from two months before until a week after.</p><button class="pill" onclick={() => store.setView({ kind: "smart" })}>Back to the inbox</button></div>
  {:else}
    <div class="scroll">
      <header class="head">
        <span class="eyebrow">{eyebrow(trip)}</span>
        <h2>{trip.city}, {tripDates(trip)}</h2>
        <p class="sub">{providers(trip)}{#if clockLine(trip, now, store.homeTz)}<span class="clock">{clockLine(trip, now, store.homeTz)}</span>{/if}</p>
      </header>

      {#each changes as b (b.key)}
        <button class="alert" onclick={() => store.openTripEmail(b.mid)}><Icon name="alert" size={17} /><span><b>{changeText(b)}</b><small>{[b.was?.gate && `Was ${b.was.gate}`, b.was?.start && `Was ${timeText(b.was.start)}`, b.status !== "cancelled" && `Now ${timeText(b.start)}`].filter(Boolean).join(" · ")} · from {b.provider ? `${b.provider}'s` : "the airline's"} email</small></span></button>
      {/each}

      {#if cards.length || nowMeetings.length}
        <section class="block" aria-label="Right now">
          <h3>Right now</h3>
          {#each cards as card (card.booking.key + card.moment)}
            {@const text = cardText(card, now)}
            <article class="card">
              <span class="ic"><Icon name={bookingIcon(card.booking)} size={18} /></span>
              <div class="body"><b>{text.title}</b>{#each text.lines as line}<small>{line}</small>{/each}
              <div class="actions">
                {#if text.place}<a class="pill sm" href={mapLink(text.place)} target="_blank" rel="noopener noreferrer"><Icon name="mapPin" size={14} /> Map</a>{/if}
                <button class="pill sm" onclick={() => store.openTripEmail(card.booking.mid)}><Icon name="mail" size={14} /> Email</button>
              </div></div>
            </article>
          {/each}
          {#each nowMeetings as e (e.id)}
            <article class="card">
              <span class="ic"><Icon name="calendar" size={18} /></span>
              <div class="body"><b>{e.subject} · {timeText({ at: Date.parse(e.start), tz: trip.tz })}, {soon(Date.parse(e.start), now)}</b><small>{e.location}</small>{#if people(e)}<small>With {people(e)}</small>{/if}
              <div class="actions">
                <a class="pill sm" href={mapLink(e.location)} target="_blank" rel="noopener noreferrer"><Icon name="mapPin" size={14} /> Directions</a>
                <button class="pill sm" onclick={() => recentEmail(e)}><Icon name="mail" size={14} /> Recent email</button>
              </div></div>
            </article>
          {/each}
        </section>
      {:else if trip.phase === "upcoming" && (checkIns.length || firstMeeting)}
        <section class="block" aria-label="Before you go">
          <h3>Before you go</h3>
          <ul class="notes">
            {#each checkIns as c (c.booking.key)}<li>Online check-in for {c.booking.number || "your flight"} opens around <b>{dayText({ at: c.at, tz: store.homeTz })}, {timeText({ at: c.at, tz: store.homeTz })}</b> (a day before). Ember will remind you.</li>{/each}
            {#if firstMeeting}<li>Your first meeting there is {dayText({ at: Date.parse(firstMeeting.start), tz: trip.tz })} at {timeText({ at: Date.parse(firstMeeting.start), tz: trip.tz })}: {firstMeeting.subject}, {firstMeeting.location}.</li>{/if}
          </ul>
        </section>
      {/if}

      {#if receipts.length}
        <section class="block" aria-label="Receipts from the trip">
          <h3>Receipts from the trip <span class="count">{receipts.length}</span></h3>
          <ul class="mail">
            {#each receipts as m (m.id)}<li><button onclick={() => store.openMessage(m.id)}><b>{displayName(m.author)}</b><span>{m.subject}</span><time>{listDate(m.date)}</time></button></li>{/each}
          </ul>
        </section>
      {/if}

      <section class="block" aria-label="Day by day">
        <h3>Day by day <span class="note">local times{trip.tz ? ", with home time where it differs" : ""}</span></h3>
        {#each days as day (day.key)}
          <div class="day" class:today={day.key === dayKey({ at: now, ...(trip.tz ? { tz: trip.tz } : {}) })}>
            <div class="date">{day.day}</div>
            <ol>
              {#each day.items as item, i (i)}
                {@const b = (item as any).booking}
                {@const clocks = bothClocks(item.at, store.homeTz)}
                <li class:done={(item.at.at < now)} class:cancelled={b?.status === "cancelled"}>
                  <span class="time">{clocks.local}{#if clocks.home}<small>{clocks.home}</small>{/if}</span>
                  <span class="what"><b>{item.label}</b>{#if item.detail}<small>{item.detail}</small>{/if}{#if b?.was && b.status !== "cancelled" && !item.arrival}<span class="badge">updated</span>{/if}{#if b?.status === "cancelled"}<span class="badge off">cancelled</span>{/if}</span>
                  {#if b}<button class="link" onclick={() => store.openTripEmail(b.mid)}>Email</button>{:else}<a class="link" href={mapLink((item as any).meeting.location)} target="_blank" rel="noopener noreferrer">Map</a>{/if}
                </li>
              {/each}
            </ol>
          </div>
        {/each}
        <p class="foot">Built from {trip.mids.length} {trip.mids.length === 1 ? "email" : "emails"}{meetings.length ? ` and ${meetings.length} calendar ${meetings.length === 1 ? "event" : "events"}` : ""}.</p>
      </section>

      <section class="block" aria-label="The trip's emails">
        <h3>The trip's emails <span class="count">{store.conversations.length}</span></h3>
        <ul class="mail">
          {#each store.conversations as c (c.key)}
            <li><button class:selected={store.selectedKey === c.key} onclick={() => store.select(c.key, true)}><b>{c.senders[0] || displayName(c.latest.author)}</b><span>{c.latest.subject}</span><time>{listDate(c.latest.date)}</time></button></li>
          {/each}
        </ul>
      </section>
    </div>
  {/if}
</section>

<style>
  .trip-page { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 24px 32px; display: flex; flex-direction: column; gap: 18px; max-width: 880px; box-sizing: border-box; }
  .eyebrow { font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--trip); }
  h2 { margin: 2px 0 4px; font-size: 26px; font-weight: 700; letter-spacing: -0.01em; }
  .sub { margin: 0; color: var(--text-2); font-size: 13px; display: flex; flex-wrap: wrap; gap: 4px 14px; }
  .clock { color: var(--trip); font-weight: 600; }
  h3 { margin: 0 0 8px; font-size: 12px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--text-3); display: flex; flex-wrap: wrap; gap: 2px 8px; align-items: baseline; }
  h3 .count, h3 .note { font-weight: 500; letter-spacing: 0; text-transform: none; }
  .alert { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: 12px; text-align: left; color: var(--warning-text); background: color-mix(in srgb, var(--warning-text) 11%, transparent); border: 1px solid color-mix(in srgb, var(--warning-text) 35%, transparent); }
  .alert span { display: flex; flex-direction: column; gap: 2px; color: var(--text); }
  .alert small, .card small { color: var(--text-2); font-size: 12.5px; }
  .card { display: flex; gap: 12px; align-items: flex-start; padding: 14px 16px; border-radius: 14px; background: var(--surface); border: 1px solid var(--sep-strong); box-shadow: 0 2px 6px rgba(16,24,40,.05); margin-bottom: 8px; }
  .card .ic { flex: none; width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center; background: var(--trip-soft); color: var(--trip); }
  .card .body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .actions .pill { display: inline-flex; align-items: center; gap: 5px; text-decoration: none; color: var(--text); }
  .notes { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; font-size: 13.5px; }
  .day { display: grid; grid-template-columns: 84px 1fr; gap: 12px; padding: 10px 0; border-top: 1px solid var(--sep); }
  .day.today .date { color: var(--trip); }
  .date { font-size: 12px; font-weight: 700; text-transform: uppercase; color: var(--text-2); padding-top: 2px; }
  ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  ol li { display: flex; gap: 12px; align-items: flex-start; }
  ol li.done { opacity: .62; }
  ol li.cancelled .what b { text-decoration: line-through; }
  .time { flex: none; width: 74px; font-size: 13px; font-weight: 600; display: flex; flex-direction: column; }
  .time small { font-weight: 400; font-size: 11px; color: var(--text-3); }
  .what { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .what b { font-weight: 550; font-size: 13.5px; }
  .what small { font-size: 12px; color: var(--text-2); }
  .badge { align-self: flex-start; margin-top: 2px; font-size: 11px; padding: 1px 7px; border-radius: 999px; background: color-mix(in srgb, var(--warning-text) 14%, transparent); color: var(--warning-text); font-weight: 600; }
  .badge.off { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); }
  .link { flex: none; font-size: 12.5px; color: var(--accent-text); text-decoration: none; }
  .link:hover { text-decoration: underline; }
  .foot { margin: 8px 0 0; font-size: 12px; color: var(--text-3); }
  .mail { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--sep); }
  .mail li { display: block; }
  .mail button { display: grid; grid-template-columns: 160px 1fr auto; gap: 12px; width: 100%; padding: 9px 4px; border-bottom: 1px solid var(--sep); text-align: left; font-size: 13px; }
  .mail button:hover { background: var(--hover); }
  .mail button.selected { background: var(--selected); }
  .mail b { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mail span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); }
  .mail time { font-size: 12px; color: var(--text-3); }
  .empty { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 60px 24px; color: var(--text-2); }
  .empty h2 { font-size: 16px; color: var(--text); }
</style>
