<script lang="ts">
  // Trips above the inbox (trips.ts): a coming trip folded into one row ("Lisbon in 5 days"), and on the trip
  // what matters right now, with a change (gate, time, cancelled) pinned first. Hidden when there's no trip.
  import { store } from "../lib/store.svelte";
  import { mailCache } from "../lib/api";
  import { aiKey } from "../lib/ai-sort";
  import { changeText, pinnedChanges, rightNow, timeText, tripDay, untilText, type Trip } from "../lib/trips";
  import { cardText, clockLine, providers, tripDates } from "../lib/trip-view";
  import Icon from "./Icon.svelte";

  const DAY = 86400000;
  const shown = $derived(store.trips.filter((t) => t.phase === "now" || (t.phase === "upcoming" && t.start.at - store.clock < 14 * DAY) || (t.phase === "past" && store.clock - t.end.at < 3 * DAY)).slice(0, 2));
  /** The trip's emails, and how many arrived today. */
  function counts(trip: Trip) {
    store.cacheStatus.total;
    const mids = new Set(trip.mids);
    const today = new Date(store.clock); today.setHours(0, 0, 0, 0);
    const mail = mailCache.all().filter((m) => mids.has(aiKey(m)));
    return { total: trip.mids.length, today: mail.filter((m) => +new Date(m.date) >= +today).length };
  }
  const open = (trip: Trip) => store.setView({ kind: "trip", id: trip.id });
</script>

{#each shown as trip (trip.id)}
  {@const changes = pinnedChanges(trip, store.clock)}
  {#each changes.filter((b) => trip.phase !== "now" || rightNow(trip, store.clock)[0]?.booking.key !== b.key) as b (b.key)}
    <button class="change" onclick={() => store.openTripEmail(b.mid)}>
      <span class="ic warn"><Icon name="alert" size={16} /></span>
      <span class="txt"><b>{changeText(b)}</b><small>{[b.was?.gate && `Was ${b.was.gate}`, b.was?.start && `was ${timeText(b.was.start)}`, b.status !== "cancelled" && `${b.kind === "hotel" ? "starts" : "leaves"} ${timeText(b.start)}`].filter(Boolean).join(" · ")}</small></span>
    </button>
  {/each}
  {#if trip.phase === "now"}
    {@const card = rightNow(trip, store.clock)[0]}
    <section class="trip now" aria-label="{trip.city} trip">
      <button class="head" onclick={() => open(trip)}>
        <span class="ic"><Icon name="suitcase" size={17} /></span>
        <span class="txt"><b>{trip.city} · {tripDay(trip, store.clock) < 1 ? "travel day" : `day ${tripDay(trip, store.clock)}`}</b><small>{clockLine(trip, store.clock, store.homeTz) || tripDates(trip)}</small></span>
        <Icon name="chevronRight" size={15} />
      </button>
      {#if card}
        {@const text = cardText(card, store.clock)}
        <button class="card" onclick={() => store.openTripEmail(card.booking.mid)}>{#if changes.some((b) => b.key === card.booking.key)}<span class="warn-line"><Icon name="alert" size={14} /> {changeText(card.booking)}</span>{/if}<b>{text.title}</b>{#each text.lines as line}<small>{line}</small>{/each}</button>
      {/if}
    </section>
  {:else}
    {@const n = counts(trip)}
    <button class="trip" onclick={() => open(trip)}>
      <span class="ic"><Icon name="suitcase" size={19} /></span>
      <span class="txt">
        <span class="top"><b>{trip.phase === "past" ? `${trip.city} trip` : `${trip.city} ${untilText(trip.start.at, store.clock, store.homeTz)}`}</b><span class="dates">{tripDates(trip)}</span></span>
        <small class="who">{trip.phase === "past" ? "Ended · receipts and bookings in one place" : providers(trip)}</small>
        {#if trip.phase === "upcoming"}
          <span class="chips"><span class="chip">{n.total} {n.total === 1 ? "email" : "emails"}</span>{#if n.today}<span class="chip new">{n.today} new today</span>{/if}</span>
        {/if}
      </span>
    </button>
  {/if}
{/each}

<style>
  .trip, .change { display: flex; align-items: flex-start; gap: 10px; width: calc(100% - 20px); margin: 6px 10px 4px; padding: 9px 12px; border-radius: 12px; text-align: left; background: var(--trip-soft); border: 1px solid color-mix(in srgb, var(--trip) 28%, transparent); box-sizing: border-box; }
  button.trip:hover, .change:hover, .head:hover, .card:hover { filter: brightness(0.98); }
  .trip.now { flex-direction: column; gap: 6px; padding: 6px; }
  .change { background: color-mix(in srgb, var(--warning-text) 12%, transparent); border-color: color-mix(in srgb, var(--warning-text) 35%, transparent); }
  .ic { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; background: var(--surface); color: var(--trip); }
  .ic.warn { color: var(--warning-text); }
  .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .txt b { font-weight: 600; }
  small { font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .top { display: flex; justify-content: space-between; gap: 8px; }
  .dates { font-size: 12px; color: var(--text-2); flex: none; }
  .chips { display: flex; gap: 4px; margin-top: 3px; }
  .chip { font-size: 11.5px; padding: 1px 7px; border-radius: 999px; background: var(--surface); color: var(--text-2); }
  .chip.new { color: var(--trip); font-weight: 600; }
  .head { display: flex; align-items: center; gap: 10px; width: 100%; padding: 4px 6px; border-radius: 9px; text-align: left; color: var(--text-2); }
  .warn-line { display: flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 700; color: var(--warning-text); }
  .card { display: flex; flex-direction: column; gap: 2px; width: 100%; padding: 9px 12px; border-radius: 9px; background: var(--surface); text-align: left; box-sizing: border-box; }
</style>
