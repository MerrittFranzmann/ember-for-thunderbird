<script lang="ts">
  // "Create event" from an email: the times its newest message mentions ("Thursday from 1 to 3", "Friday morning"),
  // each a button that opens the event editor with the subject, the people on the email and that time.
  import { store } from "../lib/store.svelte";
  import { api } from "../lib/api";
  import { calendar } from "../lib/calendar.svelte";
  import { draftFromEmail } from "../lib/calendar-edit";
  import { findTimes, type FoundTime } from "../lib/time-phrases";
  import { extractBodies, htmlToText, splitQuotedText } from "../lib/body";
  import { loadMessageBody } from "../lib/message-data";
  import { splitAddrs, type Addr } from "../lib/format";
  import { shortTime } from "../lib/calendar-grid";
  import type { Conversation, MessageHeader } from "../lib/types";
  import Icon from "./Icon.svelte";
  import { composer } from "../lib/compose.svelte";

  let { conv, latest }: { conv: Conversation; latest: MessageHeader | undefined } = $props();
  let times = $state<FoundTime[]>([]);
  let forId = 0;

  $effect(() => {
    const message = latest;
    times = [];
    if (!message || !calendar.available) return;
    const id = message.id;
    forId = id;
    void loadMessageBody(api, id).then((full: any) => {
      if (forId !== id) return;
      const bodies = extractBodies(full);
      const text = splitQuotedText(bodies.text ?? htmlToText(bodies.html || "")).text;
      const now = Date.now();
      // Times still ahead (or within the last hour), from when the email was sent.
      times = findTimes(`${message.subject || ""}\n${text}`, new Date(message.date)).filter((t) => t.end > now - 3600000).slice(0, 4);
    }).catch(() => {});
  });

  function people(m: MessageHeader): Addr[] {
    return [m.author, ...(m.recipients || []), ...(m.ccList || [])].flatMap((raw) => splitAddrs(raw)).filter((a) => a.email.includes("@"));
  }
  /** Open the editor for this email (at a time it mentions, or the next hour). */
  export async function createEvent(time?: FoundTime) {
    const m = latest || conv.latest;
    if (!calendar.calendarsLoaded) await calendar.loadCalendars();
    if (!calendar.writable.length) { store.toast({ text: "Ember has no calendar to add events to. Connect one on the Calendar page.", kind: "info" }); return; }
    const preferred = calendar.calendarForAccount(m.folder?.accountId);
    const draft = draftFromEmail(preferred, { subject: m.subject || "", people: people(m), link: store.emailLink(m) || undefined }, time || times[0] || null, Date.now(), store.me);
    void calendar.openEditor(draft);
  }
  /** Reply with the user's free times (the composer's "My free times"). */
  export function shareAvailability() {
    const m = latest || conv.latest;
    void composer.openReply(m.id, false, "availability");
  }
  const label = (t: FoundTime) => {
    const day = new Date(t.start).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    return t.allDay ? day : `${day} · ${shortTime(t.start)} – ${shortTime(t.end)}`;
  };
</script>

{#if times.length}
  <div class="email-event" role="group" aria-label="Times in this email">
    <span class="ic"><Icon name="calendar" size={15} /></span>
    <span class="lead">Times in this email:</span>
    {#each times as t (t.index)}
      <button class="time" title="Create an event “{t.text}”" onclick={() => createEvent(t)}>{label(t)}</button>
    {/each}
    <span class="grow"></span>
    <button class="share" title="Reply with the times you're free" onclick={shareAvailability}>Share my availability</button>
    <button class="create" onclick={() => createEvent(times[0])}>Create event</button>
  </div>
{/if}

<style>
  .email-event { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin: 10px 0 4px; padding: 8px 10px; border-radius: 10px; background: var(--card); box-shadow: var(--shadow-sm); font-size: 13px; }
  .ic { width: 26px; height: 26px; border-radius: 7px; background: var(--accent-soft); color: var(--accent-text); display: inline-flex; align-items: center; justify-content: center; flex: none; }
  .lead { color: var(--text-2); }
  .time { height: 26px; padding: 0 9px; border: 0; border-radius: 6px; background: var(--accent-softer); color: var(--accent-text); font: inherit; font-weight: 600; cursor: pointer; border-bottom: 1.5px dashed var(--accent); }
  .time:hover { background: var(--accent-soft); }
  .grow { flex: 1; }
  .create { height: 28px; padding: 0 12px; border: 0; border-radius: 7px; background: var(--accent); color: var(--on-accent); font: inherit; font-weight: 600; cursor: pointer; }
  .share { height: 28px; padding: 0 12px; border: 0; border-radius: 7px; background: var(--surface); box-shadow: 0 0 0 1px var(--sep-strong); color: var(--text); font: inherit; cursor: pointer; }
  .share:hover { background: var(--hover); }
  button:focus-visible { outline: none; box-shadow: var(--focus); }
</style>
