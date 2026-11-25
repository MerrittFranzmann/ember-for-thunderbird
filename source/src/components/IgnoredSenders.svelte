<script lang="ts">
  // Senders you ignore: bulk senders whose mail you hardly open, with Unsubscribe and Archive all.
  import { store } from "../lib/store.svelte";
  import { composer } from "../lib/compose.svelte";
  import { IGNORE_RULE, type SenderSummary, type Unsubscribe } from "../lib/ignored-senders";
  import { fullDate, listDate } from "../lib/format";
  import Avatar from "./Avatar.svelte";
  import Icon from "./Icon.svelte";

  let busy = $state<Record<string, string>>({});
  let showKept = $state(false);
  let showDone = $state(true);

  async function unsubscribe(sender: SenderSummary & { unsubscribe: Unsubscribe | null }, archive: boolean) {
    if (!sender.unsubscribe) return;
    busy[sender.address] = archive ? "both" : "unsubscribe";
    try {
      const how = await store.unsubscribeSender(sender.address, sender.unsubscribe, !archive);
      if (how === "failed") return;
      if (how === "email" && sender.unsubscribe.mailto) {
        composer.openNew([{ name: "", email: sender.unsubscribe.mailto.to }]);
        if (composer.draft) composer.draft.subject = sender.unsubscribe.mailto.subject;
        composer.chooseSignature("none");
      }
      const archived = archive ? await store.archiveSender(sender.address, true) : 0;
      const done = how === "done" ? `Unsubscribed from ${sender.name}` : how === "page" ? `Finish unsubscribing from ${sender.name} in your browser` : `Send the email to unsubscribe from ${sender.name}`;
      if (!archive || !archived) store.toast({ text: done, kind: how === "done" ? "success" : "info", timeout: 6000 });
    } finally { delete busy[sender.address]; }
  }
  async function archive(sender: SenderSummary) {
    busy[sender.address] = "archive";
    try { await store.archiveSender(sender.address); } finally { delete busy[sender.address]; }
  }
  function show(sender: SenderSummary) { store.searchText = sender.address; store.searchMail(sender.address, "local"); }
  const how = (u: Unsubscribe | null) => !u ? "" : u.oneClick ? "One click" : u.web ? "Opens their page" : "Sends an email";
  const pct = (s: SenderSummary) => s.opened ? `opened ${s.opened}` : "never opened";
</script>

<section class="senders" aria-label="Senders you ignore">
  <div class="head">
    <p class="intro">Newsletters and notifications with {IGNORE_RULE.minEmails} or more emails in the last {IGNORE_RULE.days} days, of which you opened {Math.round(IGNORE_RULE.maxOpenedShare * 100)}% or fewer. People you've written to never show here.</p>
    <div class="summary" role="status" aria-live="polite">
      {#if store.ignoredPhase === "loading" && !store.ignored.length}Looking through your saved mail…
      {:else}{store.ignored.length} {store.ignored.length === 1 ? "sender" : "senders"} · {store.ignored.reduce((n, s) => n + s.total, 0).toLocaleString()} emails{/if}
      {#if store.ignoredPhase === "loading" && store.ignored.length}<span class="mini">Updating…</span>{/if}
    </div>
  </div>

  <div class="scroll">
    {#if store.ignoredPhase === "error"}
      <div class="empty" role="alert"><p>Couldn't look through your mail.</p><button class="pill" onclick={() => store.findIgnoredSenders()}>Try again</button></div>
    {:else if store.ignored.length}
      <ul class="list" aria-label="Senders">
        {#each store.ignored as sender (sender.address)}
          <li class="sender">
            <Avatar from={sender.latest.author} size={38} cat="newsletter" />
            <div class="info">
              <div class="name"><strong>{sender.name}</strong> <span>{sender.address}</span></div>
              <div class="stats"><b>{sender.total} emails</b> · {pct(sender)} · last <time title={fullDate(sender.latest.date)}>{listDate(sender.latest.date)}</time>{#if sender.inInbox}{` · ${sender.inInbox} in Inbox`}{/if}</div>
              {#if sender.subjects.length}<div class="subjects" title={sender.subjects.join("\n")}>{sender.subjects.join(" · ")}</div>{/if}
            </div>
            <div class="actions">
              {#if sender.unsubscribe}
                <button class="pill sm primary" disabled={!!busy[sender.address]} title="{how(sender.unsubscribe)}, then archives their emails in your Inbox" onclick={() => unsubscribe(sender, true)}><Icon name="unsubscribe" size={14} /> {busy[sender.address] === "both" ? "Working…" : "Unsubscribe & archive"}</button>
                <button class="pill sm" disabled={!!busy[sender.address]} title={how(sender.unsubscribe)} onclick={() => unsubscribe(sender, false)}>Unsubscribe</button>
              {:else}
                <span class="no-unsub" title="Their emails don't say how to unsubscribe">No unsubscribe link</span>
              {/if}
              <button class="pill sm" disabled={!!busy[sender.address]} title="Archive everything from them in your Inbox" onclick={() => archive(sender)}><Icon name="archive" size={14} /> {busy[sender.address] === "archive" ? "Archiving…" : "Archive all"}</button>
              <button class="icon-btn" title="Show their emails" aria-label="Show emails from {sender.name}" onclick={() => show(sender)}><Icon name="search" size={16} /></button>
              <button class="icon-btn" title="Keep: I want their mail" aria-label="Keep {sender.name}" onclick={() => store.keepSender(sender.address)}><Icon name="x" size={16} /></button>
            </div>
          </li>
        {/each}
      </ul>
    {:else if store.ignoredPhase !== "loading"}
      <div class="empty"><Icon name="done" size={32} /><h2>Nothing to clean up</h2><p>No newsletter or notification sender has gone unopened lately.</p></div>
    {/if}

    {#if store.unsubscribedList.length}
      <section class="extra" aria-label="Unsubscribed">
        <button class="extra-head" aria-expanded={showDone} onclick={() => (showDone = !showDone)}><Icon name={showDone ? "chevronDown" : "chevronRight"} size={14} /> Unsubscribed ({store.unsubscribedList.length})</button>
        {#if showDone}
          <ul class="list small">
            {#each store.unsubscribedList as sender (sender.address)}
              {@const at = store.settings.unsubscribedSenders[sender.address]}
              <li class="sender">
                <div class="info">
                  <div class="name"><strong>{sender.name}</strong> <span>{sender.address}</span></div>
                  <div class="stats">Unsubscribed {listDate(at)} · {#if sender.since}<span class="warn">{sender.since} {sender.since === 1 ? "email" : "emails"} since</span>{:else}nothing since{/if}{#if sender.inInbox}{` · ${sender.inInbox} in Inbox`}{/if}</div>
                </div>
                <div class="actions">
                  {#if sender.inInbox}<button class="pill sm" onclick={() => store.archiveSender(sender.address)}><Icon name="archive" size={14} /> Archive all</button>{/if}
                  <button class="pill sm" title="Take it off this list" onclick={() => store.forgetUnsubscribe(sender.address)}>Forget</button>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}

    {#if store.settings.keptSenders.length}
      <section class="extra" aria-label="Kept senders">
        <button class="extra-head" aria-expanded={showKept} onclick={() => (showKept = !showKept)}><Icon name={showKept ? "chevronDown" : "chevronRight"} size={14} /> Kept ({store.settings.keptSenders.length})</button>
        {#if showKept}
          <ul class="list small">
            {#each store.settings.keptSenders as address (address)}
              <li class="sender"><div class="info"><div class="name"><span>{address}</span></div></div><div class="actions"><button class="pill sm" onclick={() => store.keepSender(address, false)}>Put back</button></div></li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  </div>
  <p class="footnote">From saved mail (the last {IGNORE_RULE.days} days). Archive all also finds their older emails in your Inbox. Undo with ⌘Z.</p>
</section>

<style>
  .senders { display: flex; flex-direction: column; flex: 1; min-height: 0; }
  .head { padding: 16px 20px 12px; border-bottom: 1px solid var(--sep); }
  .intro { margin: 0 0 10px; color: var(--text-2); font-size: 13px; line-height: 1.5; max-width: 640px; }
  .summary { font-size: 12px; color: var(--text-2); display: flex; gap: 8px; }
  .mini { color: var(--text-3); }
  .scroll { flex: 1; min-height: 0; overflow-y: auto; }
  .list { list-style: none; margin: 0; padding: 0 20px; }
  .sender { display: flex; align-items: center; gap: 14px; padding: 14px 0; border-bottom: 1px solid var(--sep); }
  .list.small .sender { padding: 10px 0; }
  .info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .name { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .name span { color: var(--text-2); font-size: 12px; margin-left: 4px; }
  .stats { font-size: 12px; color: var(--text-2); }
  .stats b { color: var(--text); font-weight: 600; }
  .warn { color: var(--danger); }
  .subjects { font-size: 12px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .actions { display: flex; flex: none; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; max-width: 55%; }
  .actions .pill { display: inline-flex; align-items: center; gap: 5px; }
  .no-unsub { font-size: 11px; color: var(--text-3); }
  .extra { padding: 6px 0; }
  .extra-head { display: flex; align-items: center; gap: 6px; padding: 10px 20px; font-size: 12px; font-weight: 600; color: var(--text-2); }
  .empty { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 60px 24px; color: var(--text-2); }
  .empty h2 { font-size: 16px; color: var(--text); margin-bottom: 0; }
  .empty p { font-size: 13px; max-width: 350px; line-height: 1.5; }
  .footnote { margin: 0; padding: 12px 20px; border-top: 1px solid var(--sep); font-size: 12px; color: var(--text-2); }
</style>
