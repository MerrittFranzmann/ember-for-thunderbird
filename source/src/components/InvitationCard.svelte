<script lang="ts">
  import { api, env } from "../lib/api";
  import { buildReply, invitedAddress, replySubject, replyText, PARTSTAT_LABEL, type Partstat } from "../lib/rsvp";
  import { store } from "../lib/store.svelte";
  import { withDeadline } from "../lib/async";
  import { calendarBodies, closeCalendar, formatCalendarDate, formatInvitationWhen, invitationLabel, inviteTitle, parseInvitations, type Invitation } from "../lib/invitations";
  import { ANSWER_TEXT, conflicts, currentAnswer, exchangeConfirmed, joinSoon, shownOnCalendar, timeRange, type CalendarEvent, type MeetingStatus } from "../lib/meeting-status";
  import type { MessageAttachment, MessagePart } from "../lib/types";
  import Icon from "./Icon.svelte";
  let { messageId, accountId, date, subject = "", full, attachments }: { messageId: number; accountId?: string; date?: Date | string; subject?: string; full: MessagePart; attachments: MessageAttachment[] } = $props();
  // The calendar text each event came from, to build its reply.
  let eventSources = new Map<string, string>();
  let responses = $state<Record<string, Partstat>>({});
  let responding = $state("");
  const eventKey = (invitation: Invitation) => `${invitation.uid}|${invitation.recurrenceId}`;
  $effect(() => { api.storage.local.get("rsvpResponses").then((s: any) => { responses = s.rsvpResponses || {}; }).catch(() => {}); });
  let invitations = $state<Invitation[]>([]);
  let loading = $state(false);
  let error = $state("");
  let opening = $state(false);
  let retry = $state(0);
  const files = $derived(attachments.filter((attachment) => /^(text\/calendar|application\/ics)/i.test(attachment.contentType) || /\.ics$/i.test(attachment.name)));
  const inline = $derived(calendarBodies(full));
  const hasCalendar = $derived(inline.length > 0 || files.length > 0);

  // What Exchange knows (undefined while asking, null when the account isn't Exchange).
  let status = $state<MeetingStatus | null | undefined>(undefined);
  let exchange = $state(false);
  let busy = $state<Record<string, CalendarEvent[] | null>>({});
  let newer = $state<Record<string, { id: number; cancelled: boolean } | null>>({});
  let answered = $state<Record<string, Partstat>>({});
  let changing = $state<Record<string, boolean>>({});
  let noteOpen = $state(false);
  let note = $state("");
  let notify = $state(true);
  let removed = $state(false);
  let removing = $state(false);
  let now = $state(Date.now());
  $effect(() => { const timer = setInterval(() => { if (document.visibilityState !== "hidden") now = Date.now(); }, 30000); return () => clearInterval(timer); });

  $effect(() => {
    retry;
    const sources = inline;
    const parts = files;
    if (!sources.length && !parts.length) return;
    const controller = new AbortController();
    loading = true;
    error = "";
    invitations = [];
    (async () => {
      const calendars = [...sources];
      // Inline calendar MIME bodies are authoritative; avoid reading the same file twice.
      if (!calendars.length) {
        for (const part of parts.slice(0, 8)) {
          if (controller.signal.aborted) return;
          if (part.size > 1024 * 1024) throw new Error("Calendar file is too large to preview.");
          const file: File = await withDeadline(api.messages.getAttachmentFile(messageId, part.partName), 10000, controller.signal, "Calendar invitation");
          if (file.size > 1024 * 1024) throw new Error("Calendar file is too large to preview.");
          calendars.push(await file.text());
        }
      }
      const seen = new Set<string>();
      const events: Invitation[] = [];
      for (const raw of calendars) {
        const calendar = closeCalendar(raw); // replies re-parse this text
        for (const event of parseInvitations(calendar, store.me)) {
          const key = `${event.uid}:${event.recurrenceId}:${event.sequence}`;
          if (seen.has(key)) continue;
          seen.add(key);
          eventSources.set(eventKey(event), calendar);
          events.push(event);
        }
      }
      if (!controller.signal.aborted) invitations = events;
    })().catch((e) => { if (!controller.signal.aborted) error = e?.message || String(e); })
      .finally(() => { if (!controller.signal.aborted) loading = false; });
    return () => controller.abort();
  });

  // Once the events are known: Exchange status, calendar conflicts, newer versions.
  $effect(() => {
    const events = invitations;
    if (!events.length) return;
    let active = true;
    const calendar = api.sparkCalendar;
    const meeting = events.some((e) => e.method === "REQUEST" || e.method === "CANCEL");
    if (meeting && typeof calendar?.meetingStatus === "function") {
      calendar.serverResponse(messageId).then((value: boolean) => { if (active) exchange = value; }).catch(() => {});
      calendar.meetingStatus(messageId).then((value: MeetingStatus | null) => { if (active) status = value; }).catch(() => { if (active) status = null; });
    } else status = null;
    for (const event of events) {
      if (event.method !== "REQUEST" || event.passed) continue;
      const key = eventKey(event);
      const when = event.next;
      if (when && typeof calendar?.calendarView === "function") {
        calendar.calendarView(new Date(when.start).toISOString(), new Date(when.end).toISOString())
          .then((view: { accounts: number; events: CalendarEvent[]; errors: unknown[] }) => {
            if (!active) return;
            // No Exchange calendar, or none could be read: say nothing rather than "no conflicts".
            busy = { ...busy, [key]: view.accounts && view.errors.length < view.accounts ? conflicts(view.events, event, when) : null };
          }).catch(() => {});
      }
      findNewer(event).then((found) => { if (active) newer = { ...newer, [key]: found }; }).catch(() => {});
    }
    return () => { active = false; };
  });

  /** A later version of this invitation in the same account (another REQUEST with a higher sequence, or a CANCEL). */
  async function findNewer(event: Invitation): Promise<{ id: number; cancelled: boolean } | null> {
    const title = inviteTitle(subject) || event.title;
    if (!title || !date) return null;
    const page = await api.messages.query({ subject: title, fromDate: new Date(+new Date(date) + 1000), ...(accountId ? { accountId } : {}) });
    const candidates = (page?.messages || []).filter((m: any) => m.id !== messageId).sort((a: any, b: any) => +new Date(b.date) - +new Date(a.date)).slice(0, 4);
    for (const candidate of candidates) {
      const tree = await api.messages.getFull(candidate.id).catch(() => null);
      if (!tree) continue;
      for (const text of calendarBodies(tree)) {
        const later = parseInvitations(closeCalendar(text), store.me).find((e) => e.uid === event.uid && e.recurrenceId === event.recurrenceId &&
          (e.sequence > event.sequence || (e.sequence === event.sequence && e.stamp > event.stamp) || e.method === "CANCEL"));
        if (later) return { id: candidate.id, cancelled: later.method === "CANCEL" };
      }
    }
    return null;
  }

  async function openNative() {
    opening = true;
    try {
      await api.messageDisplay.open({ messageId, location: "tab", active: true });
      // In window mode Thunderbird's window is behind Ember; bring it forward.
      await api.runtime.sendMessage({ type: "spark:show-thunderbird" }).catch(() => {});
    }
    catch (e: any) { store.toast({ text: `Couldn't open invitation: ${e?.message || e}`, kind: "error" }); }
    finally { opening = false; }
  }

  /** The invitation on one of Thunderbird's calendars (Google adds invitations to the calendar itself), or null. */
  async function calendarCopy(uid: string): Promise<{ accountId: string; id: string } | null> {
    if (!uid || typeof api.sparkCalendar.findInvitation !== "function") return null;
    return api.sparkCalendar.findInvitation(uid).catch(() => null);
  }
  const EXCHANGE_RESPONSE: Record<Partstat, "accept" | "tentative" | "decline"> = { ACCEPTED: "accept", TENTATIVE: "tentative", DECLINED: "decline" };
  /** Exchange mailboxes respond on the server (Outlook's request: calendar updated, organizer told); an invitation
   *  already on a Thunderbird calendar (Google's) is answered there; other accounts send the iMIP reply Thunderbird's
   *  own invitation bar sends. */
  async function respond(invitation: Invitation, partstat: Partstat) {
    const key = eventKey(invitation), ics = eventSources.get(key);
    if (!ics || responding) return;
    responding = key;
    const organizer = invitation.organizer.name || invitation.organizer.email;
    const comment = noteOpen ? note.trim() : "";
    const send = !exchange || notify;
    let route = "", code: string | undefined, verified: string | undefined, failure = "";
    try {
      let onCalendar = false;
      let copy: { accountId: string; id: string } | null = null;
      if (await api.sparkCalendar.serverResponse(messageId)) {
        route = "exchange";
        const result = await api.sparkCalendar.respond(messageId, EXCHANGE_RESPONSE[partstat], { note: comment, send });
        code = result?.code; verified = result?.verified;
        if (!exchangeConfirmed(EXCHANGE_RESPONSE[partstat], verified)) throw new Error(`Exchange took the answer, but your calendar still shows ${shownOnCalendar(verified!)}. Try again, or answer in Outlook.`);
        if (status) status = { ...status, response: EXCHANGE_RESPONSE[partstat], onCalendar: true };
        onCalendar = true;
      } else if (!invitation.recurrenceId && (copy = await calendarCopy(invitation.uid))) {
        // On the user's Google (or other CalDAV) calendar already: answer there, as Google Calendar does; its server
        // (or Thunderbird) tells the organizer.
        route = "calendar";
        const result = await api.sparkCalendar.respondEvent(copy.accountId, copy.id, EXCHANGE_RESPONSE[partstat]);
        verified = result?.verified;
        if (!exchangeConfirmed(EXCHANGE_RESPONSE[partstat], verified)) throw new Error(`Your calendar still shows ${shownOnCalendar(verified!)}.`);
        onCalendar = true;
      } else {
        route = "imip";
        const address = invitedAddress(ics, invitation.uid, store.me);
        const identity = store.identities.find((i) => i.email.toLowerCase() === address) || store.identities.find((i) => i.accountId === accountId) || store.identities[0];
        if (!identity) throw new Error("No sending identity is set up in Thunderbird.");
        if (!invitation.organizer.email) throw new Error("This invitation has no organizer address to reply to.");
        const name = identity.name || identity.email;
        await api.sparkCalendar.sendReply({
          identityId: identity.id,
          to: invitation.organizer.name ? `${invitation.organizer.name} <${invitation.organizer.email}>` : invitation.organizer.email,
          subject: replySubject(partstat, invitation.title),
          text: replyText(partstat, name, comment),
          calendar: buildReply(ics, invitation.uid, invitation.recurrenceId, { email: address || identity.email, name }, partstat, new Date(), comment),
        });
      }
      // Read-modify-write: other cards (and earlier responses) share this map.
      const saved = ((await api.storage.local.get("rsvpResponses").catch(() => ({}))) as any).rsvpResponses || {};
      responses = { ...saved, ...responses, [key]: partstat };
      await api.storage.local.set({ rsvpResponses: { ...saved, [key]: partstat } }).catch(() => {});
      answered = { ...answered, [key]: partstat };
      changing = { ...changing, [key]: false };
      noteOpen = false; note = "";
      window.dispatchEvent(new CustomEvent("spark:calendar-changed"));
      void api.runtime.sendMessage({ type: "spark:reminders" }).catch(() => {});
      const told = onCalendar ? (send ? `on your calendar, ${organizer} notified` : "on your calendar, organizer not notified") : `reply sent to ${organizer}`;
      store.toast({ text: `${PARTSTAT_LABEL[partstat]} · ${told}`, kind: "success" });
    } catch (e: any) {
      failure = e?.message || String(e);
      store.toast({ text: `Couldn't send your response: ${failure}`, kind: "error" });
    } finally {
      responding = "";
      void logAnswer({ at: new Date().toISOString(), route, response: partstat, sent: send, note: !!comment, code, verified, error: failure });
    }
  }

  /** The last 30 answers (route, Exchange's result code, what the calendar showed after): no message content. */
  async function logAnswer(entry: Record<string, unknown>) {
    const saved = ((await api.storage.local.get("calendarLog").catch(() => ({}))) as any).calendarLog || [];
    await api.storage.local.set({ calendarLog: [...saved, entry].slice(-30) }).catch(() => {});
  }

  async function removeFromCalendar() {
    removing = true;
    try {
      await api.sparkCalendar.removeFromCalendar(messageId);
      removed = true;
      window.dispatchEvent(new CustomEvent("spark:calendar-changed"));
      void api.runtime.sendMessage({ type: "spark:reminders" }).catch(() => {});
      store.toast({ text: "Removed from your calendar", kind: "success" });
    } catch (e: any) {
      store.toast({ text: `Couldn't remove it from your calendar: ${e?.message || e}`, kind: "error" });
    } finally { removing = false; }
  }

  const REPLY_VERB: Record<string, string> = { ACCEPTED: "accepted", TENTATIVE: "said maybe", DECLINED: "declined", DELEGATED: "delegated" };
  const at = (value: string) => Date.parse(value);
</script>

{#snippet joinButton(invitation: Invitation)}
  {#if invitation.join && !invitation.passed}
    <a class="pill sm join" class:primary={joinSoon(invitation.next, now)} href={invitation.join.url} target="_blank" rel="noopener noreferrer" title={invitation.join.url}>
      <Icon name="video" size={15} />Join {invitation.join.label}
    </a>
  {/if}
{/snippet}

{#if hasCalendar}
  {@const replies = invitations.length > 0 && invitations.every((e) => e.method === "REPLY" && e.replier)}
  <section class="calendar-invitation" class:compact={replies} aria-label={replies ? "Invitation response" : "Calendar invitation"} aria-busy={loading}>
    {#if loading}<p class="status">Reading invitation…</p>{:else if error}<p class="status" role="status">Couldn't preview invitation: {error}</p><button class="pill sm" onclick={() => retry++}>Retry</button>{/if}
    {#if !loading && !error && !invitations.length}<p class="status">No event details were available to preview. Open the invitation in Thunderbird.</p>{/if}
    {#if replies}
      {#each invitations as invitation, index (`${invitation.uid}:${invitation.recurrenceId}:${index}`)}
        {@const who = invitation.replier!}
        <div class="reply-line">
          <span class="verdict" data-response={who.response}><Icon name={who.response === "DECLINED" ? "x" : who.response === "TENTATIVE" ? "calendar" : "check"} size={15} stroke={2} /></span>
          <span><strong>{who.name || who.email}</strong> {REPLY_VERB[who.response] || "responded"} · {invitation.title}</span>
        </div>
        {#if invitation.comment}<p class="comment">“{invitation.comment}”</p>{/if}
      {/each}
    {:else}
      {#each invitations as invitation, index (`${invitation.uid}:${invitation.recurrenceId}:${index}`)}
        {@const key = eventKey(invitation)}
        {@const answer = currentAnswer({ session: answered[key], server: status, saved: status === null ? responses[key] : undefined, invitation: invitation.response })}
        {@const later = newer[key]}
        {@const stale = !!later || !!status?.outOfDate}
        {@const overlaps = busy[key]}
        <div class="event">
          <div class="label"><Icon name="calendar" size={18} />{invitationLabel(invitation)}</div>
          <h3>{invitation.title}</h3>
          <dl>
            <dt>When</dt><dd>{formatInvitationWhen(invitation)}</dd>
            {#if invitation.end && !invitation.start?.allDay}<dt>Until</dt><dd>{formatCalendarDate(invitation.end)}</dd>{/if}
            {#if invitation.recurring && invitation.next && !invitation.passed}<dt>Next</dt><dd>{new Date(invitation.next.start).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</dd>{/if}
            {#if invitation.location}<dt>Where</dt><dd>{invitation.location}</dd>{/if}
            {#if invitation.organizer.email}<dt>Organizer</dt><dd>{invitation.organizer.name} {invitation.organizer.name !== invitation.organizer.email ? `<${invitation.organizer.email}>` : ""}</dd>{/if}
            {#if invitation.recurring}<dt>Repeats</dt><dd>{invitation.recurrenceId ? "This occurrence of a recurring event" : "Recurring event"}</dd>{/if}
          </dl>
          {#if invitation.method === "REQUEST" && !invitation.passed && !stale && overlaps}
            {#if overlaps.length}
              <p class="conflict" role="note"><Icon name="alert" size={15} stroke={2} /><span>Overlaps with {#each overlaps.slice(0, 2) as other, i (other.id)}{i ? " and " : ""}<strong>{other.subject || "a busy time"}</strong> ({timeRange(at(other.start), at(other.end), other.allDay)}){/each}{overlaps.length > 2 ? ` and ${overlaps.length - 2} more` : ""}</span></p>
            {:else}
              <p class="free"><Icon name="check" size={15} stroke={2} />No conflicts on your calendar</p>
            {/if}
          {/if}
          {#if invitation.method !== "CANCEL" && invitation.join && !invitation.passed}<div class="join-row">{@render joinButton(invitation)}</div>{/if}
          {#if invitation.description}<details><summary>Description</summary><p class="description">{invitation.description}</p></details>{/if}

          {#if invitation.method === "CANCEL"}
            <div class="actions">
              {#if removed}<p class="state"><Icon name="check" size={15} stroke={2} />Removed from your calendar</p>
              {:else if status?.onCalendar}<button class="pill sm primary" disabled={removing} onclick={removeFromCalendar}><Icon name="trash" size={14} />{removing ? "Removing…" : "Remove from calendar"}</button>
              {:else if status}<p class="state muted">Not on your calendar</p>{/if}
            </div>
          {:else if invitation.canRespond && env.hasCalendarResponses}
            {#if invitation.passed}
              <p class="state muted">This meeting has passed{answer && answer !== "ORGANIZER" ? ` · ${ANSWER_TEXT[answer].replace("You ", "you ")}` : ""}.</p>
            {:else if stale}
              <div class="actions">
                <p class="state"><Icon name="alert" size={15} stroke={2} />{later?.cancelled ? "This meeting was cancelled later." : "This invitation has been updated since."}</p>
                {#if later}<button class="pill sm" onclick={() => store.openMessage(later.id)}>Open the {later.cancelled ? "cancellation" : "newest version"}</button>{/if}
              </div>
            {:else if answer && !changing[key]}
              <div class="actions">
                <p class="state"><Icon name={answer === "DECLINED" ? "x" : "check"} size={15} stroke={2} />{ANSWER_TEXT[answer]}</p>
                {#if answer !== "ORGANIZER"}<button class="pill ghost sm" onclick={() => (changing = { ...changing, [key]: true })}>Change</button>{/if}
              </div>
            {:else}
              {@const current = answered[key] || (answer && answer !== "ORGANIZER" ? answer : undefined)}
              <div class="rsvp" role="group" aria-label="Respond to {invitation.title}">
                {#each [["ACCEPTED", "Accept", "check"], ["TENTATIVE", "Maybe", "calendar"], ["DECLINED", "Decline", "x"]] as [value, label, icon] (value)}
                  <button class="pill sm" class:primary={current === value || (!current && value === "ACCEPTED")} aria-pressed={current === value} disabled={!!responding} onclick={() => respond(invitation, value as Partstat)}><Icon name={icon} size={14} />{responding === key ? "Sending…" : label}</button>
                {/each}
                <button class="pill ghost sm" aria-expanded={noteOpen} onclick={() => (noteOpen = !noteOpen)}><Icon name="note" size={14} />{noteOpen ? "Remove note" : "Add a note"}</button>
              </div>
              {#if noteOpen || exchange}
                <div class="options">
                  {#if noteOpen}<textarea bind:value={note} rows="2" maxlength="2000" placeholder="A note for {invitation.organizer.name || 'the organizer'}" aria-label="Note for the organizer"></textarea>{/if}
                  {#if exchange}<label class="notify"><input type="checkbox" bind:checked={notify} />Tell {invitation.organizer.name || "the organizer"} my answer</label>{/if}
                </div>
              {/if}
            {/if}
          {/if}
        </div>
      {/each}
      {#if !loading}<button class="pill ghost sm open-native" disabled={opening} onclick={openNative}><Icon name="open" size={15} />Open in Thunderbird</button>{/if}
    {/if}
  </section>
{/if}

<style>
  .calendar-invitation { border: 1px solid var(--accent-soft); border-radius: 12px; background: var(--accent-softer); padding: 16px; margin-bottom: 16px; }
  .calendar-invitation.compact { padding: 10px 14px; margin-bottom: 4px; }
  .label { display: flex; align-items: center; gap: 7px; color: var(--accent-text); font-size: 12px; font-weight: 600; }
  h3 { font-size: 17px; margin: 10px 0 12px; overflow-wrap: anywhere; }
  dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 6px 12px; font-size: 13px; margin: 0 0 12px; }
  dt { color: var(--text-2); } dd { margin: 0; overflow-wrap: anywhere; }
  .status { font-size: 12px; color: var(--text-2); }
  .rsvp, .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 14px 0 10px; }
  .actions .state { margin: 0; }
  .state { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 500; margin: 14px 0 10px; }
  .state.muted { color: var(--text-2); font-weight: 400; }
  .conflict, .free { display: flex; align-items: flex-start; gap: 7px; font-size: 13px; margin: -2px 0 10px; }
  .conflict { color: var(--warning-text); }
  .conflict strong { font-weight: 600; }
  .conflict :global(.icon), .free :global(.icon), .state :global(.icon) { margin-top: 1px; }
  .free { color: var(--text-2); }
  a.join { text-decoration: none; }
  .join-row { margin: 0 0 12px; }
  .options { display: flex; flex-direction: column; gap: 8px; margin: -2px 0 10px; }
  textarea { width: 100%; box-sizing: border-box; resize: vertical; font: inherit; font-size: 13px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--sep-strong); background: var(--card, var(--bg)); color: var(--text); }
  .notify { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-2); }
  .description { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; max-height: 240px; overflow-y: auto; }
  details { margin: 10px 0; } summary { font-size: 12px; color: var(--text-2); cursor: pointer; }
  .open-native { margin-left: -12px; } /* ghost button: line its icon up with the card text */
  .event + .event { border-top: 1px solid var(--sep); margin-top: 16px; padding-top: 16px; }
  .reply-line { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .reply-line + .reply-line { margin-top: 6px; }
  .verdict { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-text); flex: none; }
  .verdict[data-response="DECLINED"] { background: var(--hover); color: var(--text-2); }
  .comment { margin: 6px 0 0 30px; font-size: 13px; color: var(--text-2); white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
