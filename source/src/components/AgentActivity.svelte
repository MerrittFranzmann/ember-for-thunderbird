<script lang="ts">
  // Agent Activity: what AI agents did in Ember (agent-activity.ts), as sessions, with what they left for you on top.
  import { api } from "../lib/api";
  import { store } from "../lib/store.svelte";
  import { agentLook, dayOf, markWords, matches, rowsOf, sessionsOf, summaryOf, type ActivityEntry, type DraftState, type EmailRef, type Filter, type Session } from "../lib/agent-activity";
  import { displayName } from "../lib/format";
  import Avatar from "./Avatar.svelte";
  import Icon from "./Icon.svelte";

  let filter = $state<Filter>("all");
  let toggled = $state<Record<string, boolean>>({});

  const registry = $derived(store.agentRegistry?.agents || {});
  const look = (agent: string) => agentLook(agent, registry[agent]?.title);
  const entries = $derived(store.agentActivity.filter((e) => matches(e, filter)));
  const sessions = $derived(sessionsOf(entries));
  const days = $derived.by(() => {
    const out: { day: number; sessions: Session[] }[] = [];
    for (const s of sessions) { const last = out[out.length - 1]; if (last?.day === s.day) last.sessions.push(s); else out.push({ day: s.day, sessions: [s] }); }
    return out;
  });
  const review = $derived(store.agentReview);
  const agentIds = $derived([...new Set(store.agentActivity.map((e) => e.agent))]);
  const newAgents = $derived(Object.entries(registry).filter(([, info]) => info.alert && !info.blocked));
  const activeNow = $derived(Object.entries(registry).filter(([, info]) => store.clock - info.last < 5 * 60000 && !info.blocked).map(([id]) => look(id).name));

  function dayLabel(day: number) {
    const today = dayOf(Date.now());
    if (day === today) return "Today";
    if (day === today - 86400000 || today - day < 26 * 3600000) return "Yesterday";
    return new Date(day).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  }
  const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const range = (s: Session) => (s.start === s.end || time(s.start) === time(s.end) ? time(s.end) : `${time(s.start)} – ${time(s.end)}`);
  const waitingIn = (s: Session) => s.entries.filter((e) => store.agentDraftState(e) === "waiting").length;
  function isOpen(s: Session, index: number) {
    const opened = index === 0 || waitingIn(s) > 0;
    return toggled[s.key] ? !opened : opened;
  }
  const sender = (m: EmailRef) => displayName(m.from) || "Email";

  function markSentence(e: ActivityEntry): { verb: string; after: string } {
    const c = e.change || {};
    const rest = markWords({ ...c, top: undefined });
    if (c.top === true) return { verb: "Moved", after: ["to the top", rest].filter(Boolean).join(", ") };
    if (c.top === false) return { verb: "Took", after: ["off the top", rest].filter(Boolean).join(", ") };
    return { verb: "Marked", after: rest || "with a note" };
  }
  const draftTag: Record<DraftState, { label: string; cls: string; title: string }> = {
    waiting: { label: "Draft", cls: "accent", title: "Waiting in Drafts for you to review" },
    sent: { label: "Sent", cls: "good", title: "You sent a reply" },
    discarded: { label: "Discarded", cls: "muted", title: "No longer in Drafts" },
    replaced: { label: "Replaced", cls: "muted", title: "The agent wrote a newer draft" },
  };
  const KIND_ICON: Record<string, string> = { search: "search", browse: "listUl", read: "mailOpen", open: "open", draft: "draft", check: "gauge", calendar: "calendar", hold: "calendar" };
  const holdTag: Record<string, { label: string; cls: string; title: string }> = {
    held: { label: "Hold", cls: "accent", title: "On your calendar; nobody invited yet" },
    invited: { label: "Invited", cls: "good", title: "You sent the invitation" },
    kept: { label: "Hold", cls: "muted", title: "Kept as a hold; nobody invited" },
    removed: { label: "Removed", cls: "muted", title: "You removed the hold" },
  };
  const when = (start: number, end: number) => `${new Date(start).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · ${time(start)} – ${time(end)}`;
  const names = (people: { name: string; email: string }[]) => people.map((p) => p.name || p.email).join(", ");
  const kindIcon = (e: ActivityEntry) => (e.error ? "alert" : e.kind === "mark" ? (e.change?.top ? "toTop" : "tag") : KIND_ICON[e.kind] || "bot");

  function openEmail(m: EmailRef) { void store.openEmailById(m.id); }
  function openDraft(e: ActivityEntry) {
    if (e.draft && store.agentDraftState(e) === "waiting") void store.openAgentDraftId(e.draft);
    else if (e.emails?.[0]) openEmail(e.emails[0]);
  }
  function runSearch(q: string) { store.searchText = q; store.searchMail(q, "local"); }
  const openSettings = () => void Promise.resolve(api.runtime.sendMessage({ type: "spark:settings", section: "ai" })).catch(() => {});
  function reviewOpen(item: (typeof review)[number]) {
    store.dismissReview(item.entry.id);
    if (item.what === "draft" && item.entry.draft) void store.openAgentDraftId(item.entry.draft); else if (item.email) openEmail(item.email);
  }
</script>

{#snippet emailChip(m: EmailRef, onclick: () => void)}
  <button class="chip" title="{sender(m)}: {m.subject || m.id}" {onclick}>
    {#if m.from}<Avatar from={m.from} size={22} />{:else}<span class="blank"><Icon name="mail" size={13} /></span>{/if}
    <b>{m.from ? sender(m) : "Email"}</b><span class="subj">{m.subject || m.id}</span>
  </button>
{/snippet}

{#snippet badge(agent: string, size = 28)}
  {@const a = look(agent)}
  <span class="badge" style:background={a.color} style:width="{size}px" style:height="{size}px" style:font-size="{size * 0.41}px" title={a.name}>{a.initials}</span>
{/snippet}

<section class="activity" aria-label="Agent Activity">
  <div class="head">
    <p class="sub">
      {#if activeNow.length}<span class="live"><span class="dot"></span>{activeNow.join(" and ")} {activeNow.length === 1 ? "is" : "are"} active</span><span aria-hidden="true">·</span>{/if}
      <span>Kept on this Mac for {store.settings.agentActivityDays} days</span>
    </p>
    <label class="filter"><span class="sr">Show</span>
      <select bind:value={filter}>
        <option value="all">All activity</option>
        <option value="drafts">Drafts</option>
        <option value="marks">Marks</option>
        <option value="reads">Reads and searches</option>
        {#each agentIds as id (id)}<option value="agent:{id}">{look(id).name}</option>{/each}
        <option value="everything">Everything, with status checks</option>
      </select>
    </label>
    <button class="pill sm" onclick={openSettings}><Icon name="gear" size={15} /> Settings</button>
  </div>

  <div class="scroll">
    {#each newAgents as [id, info] (id)}
      <div class="new-agent" role="status">
        {@render badge(id)}
        <span class="text"><b>A new agent, {look(id).name}, used Ember</b> for the first time {dayLabel(dayOf(info.first)).toLowerCase()} at {time(info.first)}.</span>
        <button class="pill sm" onclick={() => store.setAgent(id, { alert: false })}>That was me</button>
        <button class="pill sm danger" onclick={() => store.setAgent(id, { blocked: true, alert: false })}>Block {look(id).name}</button>
      </div>
    {/each}

    {#if review.length && filter === "all"}
      <section class="review" aria-label="To review">
        <div class="review-head"><span>To review</span><span class="n">{review.length}</span></div>
        {#each review as item (item.entry.id + (item.email?.id || ""))}
          {#if item.what === "hold"}
            <div class="review-row">
              <span class="kind"><Icon name="calendar" size={15} /></span>
              <span class="what hold-what">
                <span>Hold on your calendar: <b>{item.hold.subject}</b>, {when(item.hold.start, item.hold.end)}</span>
                <span class="by">{look(item.entry.agent).name}, {time(item.entry.at)}{item.hold.invite.length ? ` · invite ${names(item.hold.invite)}? Nothing is sent until you say so.` : " · nobody to invite"}</span>
              </span>
              <span class="btns">
                {#if item.hold.invite.length}<button class="pill sm primary" onclick={() => store.decideHold(item.entry, "invite")}>Invite {item.hold.invite.length === 1 ? (item.hold.invite[0].name || item.hold.invite[0].email).split(" ")[0] : `${item.hold.invite.length} people`}</button>{/if}
                <button class="pill sm" onclick={() => store.decideHold(item.entry, "keep")}>Keep as a hold</button>
                <button class="pill sm danger" onclick={() => store.decideHold(item.entry, "remove")}>Remove</button>
              </span>
            </div>
          {:else}
          <div class="review-row">
            <span class="kind"><Icon name={item.what === "draft" ? "draft" : "toTop"} size={15} /></span>
            <span class="what">
              <span>{item.what === "draft" ? "Reply draft to" : "Moved to the top:"}</span>
              {@render emailChip(item.email, () => reviewOpen(item))}
              <span class="by">{look(item.entry.agent).name}, {time(item.entry.at)}</span>
            </span>
            <span class="btns">
              <button class="pill sm primary" onclick={() => reviewOpen(item)}>{item.what === "draft" ? "Open draft" : "Open"}</button>
              <button class="pill sm" onclick={() => store.dismissReview(item.entry.id)}>Dismiss</button>
            </span>
          </div>
          {/if}
        {/each}
      </section>
    {/if}

    {#if !store.agentActivity.length}
      <div class="empty">
        <span class="empty-ic"><Icon name="bot" size={28} /></span>
        {#if store.settings.agentAccess}
          <h2>Waiting for an agent</h2>
          <p>Agents are on. Ask Claude Code, Codex or Claude about your email and what they do will show up here.</p>
        {:else}
          <h2>AI agents can't use Ember right now</h2>
          <p>Turn them on and Claude Code, Codex or Claude can find and read your mail, mark what needs you, and write reply drafts for you to review. Everything they do shows up here.</p>
          <div class="empty-btns">
            <button class="pill primary" onclick={() => store.setSetting("agentAccess", true)}>Turn on agents</button>
            <button class="pill" onclick={openSettings}>How to connect one</button>
          </div>
          <small>They can't send, move or delete your mail.</small>
        {/if}
      </div>
    {:else if !sessions.length}
      <div class="empty"><h2>Nothing here</h2><p>No agent activity matches this filter.</p></div>
    {/if}

    {#each days as group (group.day)}
      <section aria-label={dayLabel(group.day)}>
        <h2 class="day"><span>{dayLabel(group.day)}</span><span class="n">{group.sessions.length} {group.sessions.length === 1 ? "session" : "sessions"}</span></h2>
        {#each group.sessions as s, i (s.key)}
          {@const open = isOpen(s, i)}
          {@const waiting = waitingIn(s)}
          <div class="session" data-agent={s.agent}>
            <button class="session-head" aria-expanded={open} onclick={() => (toggled[s.key] = !toggled[s.key])}>
              {@render badge(s.agent)}
              <span class="info">
                <span class="line1"><b>{look(s.agent).name}</b><span class="range">{range(s)}</span>
                  {#if registry[s.agent]?.alert}<span class="tag warn">New agent</span>{/if}
                  {#if registry[s.agent]?.blocked}<span class="tag bad">Blocked</span>{/if}
                  {#if waiting}<span class="tag accent">{waiting === 1 ? "1 draft to review" : `${waiting} drafts to review`}</span>{/if}
                  {#if s.entries.some((e) => e.error)}<span class="tag bad">Something failed</span>{/if}
                </span>
                {#if s.reason}<span class="reason">“{s.reason}”</span>{/if}
                <span class="summary">{summaryOf(s.entries)}</span>
              </span>
              <Icon name={open ? "chevronDown" : "chevronRight"} size={16} />
            </button>
            {#if open}
              <div class="rows">
                {#each rowsOf([...s.entries].reverse()) as row (row.kind === "reads" ? row.entries[0].id : row.entry.id)}
                  {#if row.kind === "reads"}
                    <div class="row">
                      <span class="kind"><Icon name="mailOpen" size={16} /></span>
                      <div class="body">
                        <div class="sentence">Read {row.emails.length} emails</div>
                        <div class="chips">{#each row.emails as m (m.id)}{@render emailChip(m, () => openEmail(m))}{/each}</div>
                      </div>
                      <time>{time(row.at)}</time>
                    </div>
                  {:else}
                    {@const e = row.entry}
                    {@const state = store.agentDraftState(e)}
                    {@const holdState = store.agentHoldState(e)}
                    {@const struck = !!e.undone || state === "discarded" || state === "replaced" || holdState === "removed"}
                    <div class="row" class:failed={!!e.error} class:struck>
                      <span class="kind" class:write={e.kind === "mark" || e.kind === "draft" || e.kind === "hold"} class:bad={!!e.error}><Icon name={kindIcon(e)} size={16} /></span>
                      <div class="body">
                        <div class="sentence">
                          {#if e.kind === "search"}
                            <span>Searched your emails for</span>
                            <button class="chip q" onclick={() => runSearch(e.query || "")}><Icon name="search" size={13} /><span>“{e.query}”</span></button>
                            {#if e.found !== undefined}<span class="found">{e.found} found</span>{/if}
                          {:else if e.kind === "browse"}
                            <span>Browsed your emails:</span><span class="chip q static"><Icon name="listUl" size={13} /><span>{e.query}</span></span>
                            {#if e.found !== undefined}<span class="found">{e.found} found</span>{/if}
                          {:else if e.kind === "read"}
                            <span>{e.error ? "Tried to read" : "Read"}</span>{#each e.emails || [] as m (m.id)}{@render emailChip(m, () => openEmail(m))}{/each}
                          {:else if e.kind === "open"}
                            <span>Showed you</span>{#each e.emails || [] as m (m.id)}{@render emailChip(m, () => openEmail(m))}{/each}
                          {:else if e.kind === "mark"}
                            {@const said = markSentence(e)}
                            <span>{said.verb}</span>{#each (e.emails || []).slice(0, 3) as m (m.id)}{@render emailChip(m, () => openEmail(m))}{/each}
                            {#if (e.emails?.length || 0) > 3}<span class="found">and {(e.emails?.length || 0) - 3} more</span>{/if}
                            <span>{said.after}</span>
                          {:else if e.kind === "draft"}
                            <span>{e.error ? "Tried to draft a reply to" : "Drafted a reply to"}</span>{#each e.emails || [] as m (m.id)}{@render emailChip(m, () => openDraft(e))}{/each}
                          {:else if e.kind === "calendar"}
                            <span>{e.what === "free" ? `Found free times ${e.query || ""}` : `Looked at your calendar${e.query ? `: ${e.query}` : ""}`}</span>
                            {#if e.what === "events" && e.found !== undefined}<span class="found">{e.found} {e.found === 1 ? "event" : "events"}</span>{/if}
                          {:else if e.kind === "hold"}
                            {#if e.hold}<span>Held {when(e.hold.start, e.hold.end)}: <b>{e.hold.subject}</b>{e.hold.invite.length ? ` (to invite ${names(e.hold.invite)})` : ""}</span>
                            {:else}<span>Tried to hold time{e.query ? ` for “${e.query}”` : ""}</span>{/if}
                          {:else}
                            <span>{e.what === "marked" ? "Looked at your marked emails" : "Checked Ember's status"}</span>
                          {/if}
                          {#if e.error}<span class="tag bad" title={e.error}>Failed</span>
                          {:else if e.undone}<span class="tag muted" title="You took this back">Undone</span>
                          {:else if state}<span class="tag {draftTag[state].cls}" title={draftTag[state].title}>{draftTag[state].label}</span>
                          {:else if holdState}<span class="tag {holdTag[holdState].cls}" title={holdTag[holdState].title}>{holdTag[holdState].label}</span>{/if}
                        </div>
                        {#if e.error}<div class="note">{e.error}</div>{/if}
                        {#if e.kind === "mark" && e.change?.note}<div class="note">Note: “{e.change.note}”</div>{/if}
                        {#if e.kind === "draft" && e.preview}<div class="preview">{e.preview}</div>{/if}
                      </div>
                      {#if e.kind === "mark" && e.before && !e.undone && !e.error}
                        <button class="pill sm undo" onclick={() => store.undoAgentMark(e)}><Icon name="refresh" size={13} /> Undo</button>
                      {/if}
                      <time>{time(e.at)}</time>
                    </div>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {/each}
      </section>
    {/each}
  </div>
</section>

<style>
  .activity { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 4px 20px 12px; border-bottom: 1px solid var(--sep); }
  .sub { flex: 1 1 240px; margin: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 13px; color: var(--text-3); }
  .live { display: inline-flex; align-items: center; gap: 6px; color: var(--success); font-weight: 600; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--success); }
  .filter select { height: 30px; padding: 0 26px 0 10px; border: 1px solid var(--sep-strong); border-radius: 8px; background: var(--surface); color: var(--text); font: inherit; font-size: 13px; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .scroll { flex: 1; overflow-y: auto; padding: 8px 20px 48px; }
  .new-agent { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; margin-top: 10px; padding: 10px 14px; border-radius: 12px; background: color-mix(in srgb, var(--star) 16%, transparent); }
  .new-agent .text { flex: 1 1 300px; min-width: 0; }
  .pill.danger { color: var(--danger); font-weight: 600; }
  .review { margin-top: 12px; border: 1px solid var(--sep-strong); border-radius: 14px; padding: 4px 0 8px; }
  .review-head { display: flex; justify-content: space-between; padding: 8px 16px 4px; font-weight: 650; }
  .review-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 6px 16px; }
  .hold-what { flex-direction: column; align-items: flex-start !important; gap: 2px !important; }
  .hold-what b { font-weight: 650; }
  .review-row .what { flex: 1 1 320px; min-width: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 7px; }
  .review-row .kind { width: 28px; height: 28px; border-radius: 8px; background: var(--accent-soft); color: var(--accent-text); display: inline-flex; align-items: center; justify-content: center; }
  .btns { display: inline-flex; gap: 6px; }
  .by, .found { font-size: 13px; color: var(--text-3); }
  .n { font-weight: 500; color: var(--text-3); font-size: 13px; }
  .day { display: flex; justify-content: space-between; margin: 0; padding: 18px 6px 8px; font-size: 14px; font-weight: 600; color: var(--text-2); }
  .session { border: 1px solid var(--sep); border-radius: 14px; margin-bottom: 10px; overflow: hidden; }
  .session-head { width: 100%; display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; border: 0; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
  .session-head:hover { background: var(--hover); }
  .session-head > :global(svg) { flex: none; margin-top: 6px; color: var(--text-3); }
  .badge { flex: none; border-radius: 8px; color: #fff; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14); }
  .info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .line1 { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
  .range { font-size: 13px; color: var(--text-3); }
  .reason { font-size: 14px; }
  .summary { font-size: 13px; color: var(--text-2); }
  .tag { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 6px; font-size: 11.5px; font-weight: 600; text-decoration: none; }
  .tag.accent { background: var(--accent-soft); color: var(--accent-text); }
  .tag.good { background: color-mix(in srgb, var(--success) 13%, transparent); color: var(--success); }
  .tag.bad { background: color-mix(in srgb, var(--danger) 11%, transparent); color: var(--danger); }
  .tag.warn { background: color-mix(in srgb, var(--star) 18%, transparent); color: var(--warning-text); }
  .tag.muted { background: var(--chip); color: var(--text-2); }
  .rows { padding: 0 10px 10px 16px; }
  .row { display: flex; align-items: flex-start; gap: 10px; padding: 6px 8px; border-radius: 10px; }
  .row:hover { background: var(--hover); }
  .kind { flex: none; width: 26px; height: 30px; display: inline-flex; align-items: center; justify-content: center; color: var(--text-3); }
  .kind.write { color: var(--accent-text); }
  .kind.bad { color: var(--danger); }
  .body { flex: 1; min-width: 0; }
  .row.failed .body { opacity: 0.7; }
  .row.struck .sentence > :not(.tag) { text-decoration: line-through; text-decoration-color: var(--text-3); opacity: 0.7; }
  .sentence { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 7px; min-height: 30px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
  .chip { display: inline-flex; align-items: center; gap: 7px; max-width: 100%; min-width: 0; height: 28px; padding: 0 12px 0 3px; border: 0; border-radius: 14px; background: var(--chip); color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
  .chip:hover { background: color-mix(in srgb, var(--chip) 80%, var(--text) 8%); }
  .chip b { font-weight: 600; white-space: nowrap; }
  .chip .subj { color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 280px; }
  .chip.q { padding: 0 11px 0 9px; gap: 6px; }
  .chip.static { cursor: default; }
  .blank { width: 22px; height: 22px; border-radius: 50%; background: var(--surface-3); color: var(--text-2); display: inline-flex; align-items: center; justify-content: center; }
  .note { margin-top: 2px; font-size: 13px; color: var(--text-2); }
  .preview { margin-top: 6px; padding: 8px 12px; border-radius: 10px; background: var(--surface-2); font-size: 13px; line-height: 1.45; color: var(--text-2); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .undo { opacity: 0; transition: opacity var(--fast); }
  .row:hover .undo, .row:focus-within .undo { opacity: 1; }
  time { flex: none; width: 66px; padding-top: 6px; text-align: right; font-size: 13px; color: var(--text-3); font-variant-numeric: tabular-nums; }
  .empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 80px 24px; text-align: center; color: var(--text-2); }
  .empty h2 { margin: 0; font-size: 17px; color: var(--text); }
  .empty p { margin: 0; max-width: 440px; }
  .empty-ic { width: 60px; height: 60px; border-radius: 16px; background: var(--surface-2); display: inline-flex; align-items: center; justify-content: center; color: var(--text-2); }
  .empty-btns { display: flex; gap: 8px; margin-top: 6px; }
  .empty small { color: var(--text-3); }
</style>
