<script lang="ts">
  import { store } from "../lib/store.svelte";
  import { categoryParent } from "../lib/inbox";
  import { accountLabel, isInboxGroup, mailboxGroups, sameView, splitInbox, type MailboxGroup } from "../lib/mailboxes";
  import { tick } from "svelte";
  import Icon from "./Icon.svelte";
  import Agenda from "./Agenda.svelte";
  import CalendarSide from "./CalendarSide.svelte";
  import { calendar } from "../lib/calendar.svelte";
  import FocusMenu from "./FocusMenu.svelte";
  import { lock } from "../lib/lock.svelte";
  import type { View } from "../lib/types";

  let { onOpenSettings }: { onOpenSettings: () => void } = $props();
  let expanded = $state<Record<string, boolean> | null>(null);
  // Work and Personal inboxes replace Inbox when some accounts are work accounts (inboxes.ts).
  // Focus: work accounts hidden now drop out of the all-account Inbox (its accounts and its count); Work stays, dimmed.
  const groups = $derived(splitInbox(mailboxGroups(store.accounts.map((node) => node.account), store.settings.accountNicknames), store.split ? store.settings.workAccounts : [], store.settings.showAllInboxes)
    .map((group) => group.key === "inbox" && store.hiddenAccounts.size ? { ...group, accounts: group.accounts.filter((entry) => !store.hiddenAccounts.has(entry.accountId)) } : group));
  const mailboxes = $derived(groups.filter((group) => !["archives", "junk"].includes(group.key)));
  // Order (like Spark): the inboxes, then Calendar and Attachments, then after a gap Pins, Sent, Trash and Drafts.
  const inboxes = $derived(mailboxes.filter((group) => isInboxGroup(group.key)));
  const others = $derived(mailboxes.filter((group) => !isInboxGroup(group.key)));
  // ⌘1 and ⌘2: the first two inboxes; ⌘3 Calendar; ⌘4 Attachments (App.svelte sends "ember:jump").
  function jump(n: number) {
    if (n <= 2) { const group = inboxes[n - 1]; if (group) go(group.view); }
    else if (n === 3) { if (calendar.available) go({ kind: "calendar" }); }
    else if (n === 4) go({ kind: "attachments" });
  }
  $effect(() => {
    const onJump = (e: Event) => jump((e as CustomEvent<number>).detail);
    window.addEventListener("ember:jump", onJump);
    return () => window.removeEventListener("ember:jump", onJump);
  });
  const folders = $derived(groups.filter((group) => ["archives", "junk"].includes(group.key)));
  const customAccounts = $derived(store.accounts.filter((account) => account.others.length));

  // Mailboxes that combine accounts (Inbox, Work, Personal, Sent…) never open up: right-click one to show a
  // single account's mail. While one is shown, the mailbox stays highlighted and names it.
  /** The account shown on its own in this mailbox, if one is. */
  function shownAccount(group: MailboxGroup) { return group.accounts.length > 1 ? group.accounts.find((entry) => isActive(entry.view)) : undefined; }
  let menu = $state<{ x: number; y: number; group: MailboxGroup } | null>(null);
  let menuEl: HTMLDivElement | undefined = $state();
  function openMenu(e: MouseEvent, group: MailboxGroup) {
    if (group.accounts.length < 2) return;
    e.preventDefault();
    // From the keyboard (the context-menu key, Shift+F10) the event has no position: under the mailbox instead.
    const at = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : (() => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); return { x: r.left + 24, y: r.bottom }; })();
    menu = { x: Math.min(at.x, innerWidth - 240), y: Math.min(at.y, innerHeight - 40 - 34 * (group.accounts.length + 1)), group };
    tick().then(() => menuEl?.querySelector<HTMLButtonElement>("button")?.focus());
  }
  function closeMenu() { menu = null; }
  function pick(view: View) { closeMenu(); go(view); }
  function menuKey(e: KeyboardEvent) {
    const items = Array.from(menuEl?.querySelectorAll<HTMLButtonElement>("button") || []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") closeMenu();
    else if (e.key === "ArrowDown") items[(i + 1) % items.length]?.focus();
    else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length]?.focus();
    else return;
    e.preventDefault(); e.stopPropagation();
  }
  function isExpanded(key: string) { return (expanded || store.settings.sidebarExpanded)[key] ?? (isInboxGroup(key) || key === "today"); }
  function toggle(key: string) {
    expanded = { ...(expanded || store.settings.sidebarExpanded), [key]: !isExpanded(key) };
    store.setSetting("sidebarExpanded", { ...expanded }).catch(() => store.toast({ text: "Couldn't save sidebar preferences.", kind: "error" }));
  }
  function isActive(view: View) {
    const v = store.view;
    // All-inbox Calendar/Updates/Newsletters have their own item under More: highlight just that one.
    const ownItem = v.kind === "category" && (v.cat === "calendar" || v.cat === "notification" || v.cat === "newsletter" || v.cat === "receipt") && !v.accountId && !v.folderId;
    if (ownItem && view.kind !== "category") return false;
    return sameView(v.kind === "category" && view.kind !== "category" ? categoryParent(v) : v, view);
  }
  function go(view: View) { store.searchText = ""; store.setView(view); }
  function count(value = 0) { return value ? value > 999 ? "999+" : String(value) : ""; }
  function unread(folderIds: string[]) { return folderIds.reduce((n, id) => n + (store.unread[id] || 0), 0); }
  function groupUnread(group: MailboxGroup) {
    return isInboxGroup(group.key) || group.key === "drafts" ? unread(group.accounts.flatMap((entry) => entry.folderIds)) : 0;
  }
</script>

{#snippet mailbox(group: MailboxGroup)}
  {@const workHidden = group.key === "inbox-work" && group.accounts.some((entry) => store.hiddenAccounts.has(entry.accountId))}
  {@const only = shownAccount(group)}
  {@const active = isActive(group.view) || !!only}
  <li class="mailbox-group" class:focus-hidden={workHidden} data-mailbox={group.key}>
    <button class="item parent" class:active aria-current={active ? "page" : undefined}
      aria-label="{group.label} — {only ? `only ${only.label}` : 'all accounts'}" aria-haspopup={group.accounts.length > 1 ? "menu" : undefined}
      title={group.accounts.length > 1 ? `${group.label}: right-click to show one account` : undefined}
      onclick={() => go(group.view)} oncontextmenu={(e) => openMenu(e, group)}>
      <span class="ic"><Icon name={group.icon} size={19} /></span>
      <span class="label">{group.label}{#if only}<span class="only"> · {only.label}</span>{/if}</span>
      <span class="count">{count(only ? (isInboxGroup(group.key) || group.key === "drafts" ? unread(only.folderIds) : 0) : groupUnread(group))}</span>
    </button>
    {#if workHidden}
      <p class="hidden-note">Hidden by Focus</p>
    {:else if group.key === "inbox" && store.hiddenAccounts.size}
      <p class="hidden-note">{store.hiddenAccounts.size === 1 ? "1 work account hidden" : `${store.hiddenAccounts.size} work accounts hidden`}</p>
    {/if}
  </li>
{/snippet}

<svelte:window onpointerdown={(e) => { if (menu && !menuEl?.contains(e.target as Node)) closeMenu(); }} onblur={closeMenu} />
{#if menu}
  {@const group = menu.group}
  <div class="context-menu" role="menu" tabindex="-1" aria-label="Show in {group.label}" bind:this={menuEl} style="left:{menu.x}px; top:{menu.y}px" onkeydown={menuKey}>
    <div class="menu-title">Show in {group.label}</div>
    <button role="menuitemradio" aria-checked={isActive(group.view)} onclick={() => pick(group.view)}>
      <span class="check" aria-hidden="true">{#if isActive(group.view)}<Icon name="check" size={13} stroke={2.4} />{/if}</span>
      <span class="name">All accounts</span>
      <span class="count">{count(groupUnread(group))}</span>
    </button>
    <div class="menu-sep" role="separator"></div>
    {#each group.accounts as entry (entry.key)}
      <button role="menuitemradio" aria-checked={isActive(entry.view)} title={entry.title} onclick={() => pick(entry.view)}>
        <span class="check" aria-hidden="true">{#if isActive(entry.view)}<Icon name="check" size={13} stroke={2.4} />{/if}</span>
        <span class="dot" style="background: var(--account-{entry.color})" aria-hidden="true"></span>
        <span class="name">{entry.label}</span>
        {#if isInboxGroup(group.key) || group.key === "drafts"}<span class="count">{count(unread(entry.folderIds))}</span>{/if}
      </button>
    {/each}
  </div>
{/if}

<nav class="sidebar" aria-label="Mailboxes">
  <div class="scroll">
    <ul class="group" aria-label="Mailboxes">
      {#each inboxes as group (group.key)}{@render mailbox(group)}{/each}
      {#if calendar.available}
        <li><button class="item utility" class:active={isActive({ kind: "calendar" })} aria-current={store.view.kind === "calendar" ? "page" : undefined} title="Your calendars (D, W, M, Y switch the view)" onclick={() => go({ kind: "calendar" })}><span class="ic"><Icon name="calendar" size={19} /></span><span class="label">Calendar</span></button></li>
      {/if}
      <li><button class="item utility" class:active={isActive({ kind: "attachments" })} aria-current={store.view.kind === "attachments" ? "page" : undefined} onclick={() => go({ kind: "attachments" })}><span class="ic"><Icon name="clip" size={19} /></span><span class="label">Attachments</span></button></li>
      {#each store.trips as trip (trip.id)}
        <li><button class="item utility" class:active={isActive({ kind: "trip", id: trip.id })} aria-current={isActive({ kind: "trip", id: trip.id }) ? "page" : undefined} onclick={() => go({ kind: "trip", id: trip.id })}><span class="ic trip-ic"><Icon name="suitcase" size={19} /></span><span class="label">{trip.city} trip</span><span class="count" class:trip-now={trip.phase === "now"}>{trip.phase === "now" ? "Now" : trip.phase === "past" ? "Ended" : new Date(trip.start.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></button></li>
      {/each}
    </ul>
    <ul class="group mail-places" aria-label="Pins, Sent, Trash and Drafts">
      {#each others as group (group.key)}{@render mailbox(group)}{/each}
    </ul>
    {#if store.view.kind === "calendar"}
      <CalendarSide />
    {:else}
    <Agenda />
    <h2 class="section-label">Folders</h2>
    <ul class="group" aria-label="Folders">
      {#each folders as group (group.key)}{@render mailbox(group)}{/each}
      <li class="mailbox-group">
        <button class="item more" aria-expanded={isExpanded("more")} aria-controls="more-folders" onclick={() => toggle("more")}>
          <span class="ic"><Icon name="more" size={19} stroke={2.6} /></span><span class="label">{isExpanded("more") ? "Less" : "More"}</span>
        </button>
        {#if isExpanded("more")}
          <ul class="children more-items" id="more-folders">
            {#each [{ cat: "calendar", label: "Invitations", icon: "calendar" }, { cat: "notification", label: "Updates", icon: "bell" }, { cat: "newsletter", label: "Newsletters", icon: "news" }, ...(store.settings.aiSort ? [{ cat: "receipt", label: "Receipts", icon: "receipt" }] : [])] as category (category.cat)}
              {@const view = { kind: "category", cat: category.cat } as View}
              <li><button class="item" class:active={isActive(view)} aria-current={isActive(view) ? "page" : undefined} onclick={() => go(view)}><span class="ic"><Icon name={category.icon} size={17} /></span><span class="label">{category.label}</span></button></li>
            {/each}
            <li><button class="item" class:active={isActive({ kind: "senders" })} aria-current={store.view.kind === "senders" ? "page" : undefined} onclick={() => go({ kind: "senders" })}><span class="ic"><Icon name="unsubscribe" size={17} /></span><span class="label">Senders you ignore</span></button></li>
            {#each customAccounts as account (account.account.id)}
              {@const key = `custom:${account.account.id}`}
              <li>
                <button class="item custom-heading" title="{account.account.name}: {isExpanded(key) ? 'hide' : 'show'} folders" aria-expanded={isExpanded(key)} onclick={() => toggle(key)}>
                  <span class="label">{accountLabel(account.account, store.settings.accountNicknames)}</span><span class="fold-count">{isExpanded(key) ? "" : account.others.length}</span>
                </button>
                {#if isExpanded(key)}
                  <ul class="children custom-folders">
                    {#each account.others as node (node.folder.id)}
                      {@const view = { kind: "folder", folderId: node.folder.id } as View}
                      <li><button class="item" class:active={isActive(view)} aria-current={isActive(view) ? "page" : undefined} title={node.folder.path} style="padding-left:{12 + node.depth * 10}px" onclick={() => go(view)}><span class="ic"><Icon name={node.folder.specialUse?.[0] || "folder"} size={17} /></span><span class="label">{node.folder.name}</span><span class="count">{count(store.unread[node.folder.id])}</span></button></li>
                    {/each}
                  </ul>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </li>
    </ul>
    {/if}
  </div>
  <div class="foot">
    <button class="icon-btn" onclick={onOpenSettings} title="Settings" aria-label="Settings"><Icon name="gear" /></button>
    {#if store.settings.agentAccess || store.agentActivity.length}
      {@const toReview = store.agentReview.length}
      <button class="icon-btn agent-btn" class:active={isActive({ kind: "activity" })} aria-current={store.view.kind === "activity" ? "page" : undefined}
        title={toReview ? `Agent Activity: ${toReview} to review` : "Agent Activity: what AI agents did in Ember"} aria-label={toReview ? `Agent Activity, ${toReview} to review` : "Agent Activity"}
        onclick={() => go({ kind: "activity" })}><Icon name="bot" />{#if toReview}<span class="agent-badge">{toReview > 99 ? "99+" : toReview}</span>{/if}</button>
    {/if}
    <FocusMenu />
    {#if store.settings.lockEnabled}<button class="icon-btn" onclick={() => lock.lockNow()} title="Lock Ember (⌘L)" aria-label="Lock Ember"><Icon name="lock" /></button>{/if}
    {#if store.updateStatus?.ready}
      <button class="update" disabled={store.updateStatus.installing} title="Ember restarts as the new version" onclick={() => store.installUpdate()}>{store.updateStatus.installing ? "Updating…" : `Update to ${store.updateStatus.ready}`}</button>
    {/if}

  </div>
</nav>

<style>
  .trip-ic { color: var(--trip); }
  .group.mail-places { margin-top: 18px; }
  .agent-btn { position: relative; }
  .agent-btn.active { background: var(--sidebar-active); color: var(--text); }
  .agent-badge { position: absolute; top: 1px; right: 0; min-width: 15px; height: 15px; padding: 0 4px; border-radius: 8px; background: var(--accent); color: var(--on-accent); font-size: 10px; font-weight: 700; line-height: 15px; text-align: center; box-sizing: border-box; }
  .trip-now { color: var(--trip); font-weight: 700; }
  .sidebar { height: 100%; box-sizing: border-box; padding-top: var(--titlebar, 0px); display: flex; flex-direction: column; background: var(--sidebar); border-right: 1px solid var(--sep); min-width: 0; }
  .scroll { flex: 1; overflow-y: auto; padding: 14px 8px 12px; }
  .group, .children { list-style: none; margin: 0; padding: 0; }
  .mailbox-group { margin: 3px 0; }
  .item { width: 100%; min-width: 0; height: 36px; display: flex; align-items: center; gap: 10px; padding: 0 10px 0 12px; border-radius: 8px; color: var(--text-2); text-align: left; transition: background var(--fast) var(--ease); }
  .item.parent { padding-left: 12px; }
  .item:hover { background: var(--hover); }
  .item.active { background: var(--sidebar-active); color: var(--text); font-weight: 600; }
  .item.active .ic, .item.active .count { color: var(--text); }
  .only { font-weight: 400; color: var(--text-2); }
  .dot { flex: none; width: 8px; height: 8px; border-radius: 50%; }
  .context-menu { position: fixed; z-index: 50; min-width: 220px; max-width: 320px; padding: 5px; border-radius: 10px; background: var(--surface); border: 1px solid var(--sep-strong); box-shadow: var(--shadow-lg); }
  .context-menu button { width: 100%; display: flex; align-items: center; gap: 9px; padding: 6px 9px; border-radius: 6px; font-size: 13px; color: var(--text); text-align: left; }
  .context-menu button:hover, .context-menu button:focus-visible { background: var(--hover); box-shadow: none; }
  .context-menu .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .context-menu .check { flex: none; width: 13px; display: grid; place-items: center; color: var(--accent-text); }
  .context-menu .count { font-size: 12px; color: var(--text-3); font-variant-numeric: tabular-nums; }
  .menu-title { padding: 6px 9px 4px; font-size: 11.5px; font-weight: 600; color: var(--text-2); }
  .menu-sep { height: 1px; margin: 4px 6px; background: var(--sep); }
  .ic { color: var(--text-2); display: grid; place-items: center; width: 19px; flex: none; }
  .label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .count { font-size: 12px; font-weight: 500; color: var(--text-2); font-variant-numeric: tabular-nums; }
  .utility { margin-top: 4px; }
  /* Dimmed, but its highlight stays readable when it's the open inbox. */
  .focus-hidden > .item.parent > :global(*) { opacity: 0.55; }
  .hidden-note { margin: 2px 0 0; padding: 0 12px 0 44px; font-size: 11.5px; color: var(--text-3); }
  .section-label { margin: 24px 0 8px; padding: 0 12px; font-size: 12px; font-weight: 500; color: var(--text-3); }
  .more-items { margin-left: 20px; }
  .custom-heading { padding-left: 12px; gap: 6px; font-size: 12px; margin-top: 8px; color: var(--text-3); }
  .fold-count { font-size: 11px; font-variant-numeric: tabular-nums; }
  .custom-folders { margin-left: 10px; }
  .foot { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-top: 1px solid var(--sep); }
  .update { margin-left: auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 5px 11px; border-radius: 999px; background: var(--accent); color: #fff; font-size: 12px; font-weight: 600; }
  .update:disabled { opacity: .6; }
</style>
