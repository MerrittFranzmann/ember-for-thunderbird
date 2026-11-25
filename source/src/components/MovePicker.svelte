<script lang="ts">
  import { store } from "../lib/store.svelte";
  import Icon from "./Icon.svelte";
  import type { Conversation } from "../lib/types";

  let { convs, onClose }: { convs: Conversation[]; onClose: () => void } = $props();

  let q = $state("");
  let active = $state(0);
  let input: HTMLInputElement | undefined = $state();

  $effect(() => {
    setTimeout(() => input?.focus(), 20);
  });

  const current = $derived(store.get(convs[0]?.ids[0])?.folder);
  const currentFolder = $derived(current?.id);
  // Where mail usually goes: your own folders, then Archive / Inbox / Junk / Trash; Sent, Drafts and
  // Templates last. Recent destinations come first, then the current account.
  const RANK: Record<string, number> = { archives: 1, inbox: 2, junk: 3, trash: 4, sent: 5, drafts: 6, templates: 7 };

  let options = $derived.by(() => {
    const out: { id: string; name: string; account: string; depth: number; role: string | null; rank: number; order: number }[] = [];
    let order = 0;
    for (const a of store.accounts) {
      for (const n of [...a.others, ...a.primary]) {
        if (n.folder.id === currentFolder) continue;
        if (n.role === "outbox" || n.folder.specialUse?.includes("outbox") || n.folder.isVirtual) continue;
        const recent = store.settings.recentMoveFolders.indexOf(n.folder.id);
        const rank = recent >= 0 ? recent - 10 : (a.account.id === current?.accountId ? 0 : 20) + (n.role ? RANK[n.role] ?? 0 : 0);
        out.push({ id: n.folder.id, name: n.folder.name, account: store.accountName(a.account.id), depth: n.depth, role: n.role, rank, order: order++ });
      }
    }
    out.sort((x, y) => x.rank - y.rank || x.order - y.order);
    const s = q.trim().toLowerCase();
    return s ? out.filter((o) => o.name.toLowerCase().includes(s)) : out;
  });

  $effect(() => {
    q;
    active = 0;
  });

  function choose(id: string) {
    store.moveTo(convs, id);
    onClose();
  }

  function onKey(e: KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "ArrowDown") {
      active = Math.min(options.length - 1, active + 1);
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      active = Math.max(0, active - 1);
      e.preventDefault();
    } else if (e.key === "Enter" && options[active]) {
      choose(options[active].id);
      e.preventDefault();
    } else if (e.key === "Escape") {
      onClose();
      e.preventDefault();
    }
  }
</script>

<div class="scrim" role="presentation" onclick={(e) => e.target === e.currentTarget && onClose()}>
  <div class="pop" role="dialog" aria-modal="true" aria-label="Move to folder" tabindex="-1" onkeydown={onKey}>
    <div class="search">
      <Icon name="search" size={16} />
      <input bind:this={input} bind:value={q} placeholder="Move to folder…" aria-label="Filter folders" role="combobox" aria-expanded="true" aria-controls="move-list" aria-activedescendant={options[active] ? `mv-${active}` : undefined} />
    </div>
    <ul id="move-list" role="listbox">
      {#each options as o, i (o.id)}
        <li id="mv-{i}" role="option" aria-selected={i === active} class:active={i === active} onclick={() => choose(o.id)} onmouseenter={() => (active = i)} onkeydown={() => {}}>
          <span class="ic" style="margin-left:{o.depth * 14}px"><Icon name={o.role || "folder"} size={16} /></span>
          <span class="name">{o.name}</span>
          <span class="acct">{o.account}</span>
        </li>
      {:else}
        <li class="none">No matching folders</li>
      {/each}
    </ul>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    background: var(--scrim);
    z-index: 60;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
  }
  .pop {
    width: min(460px, calc(100vw - 32px));
    background: var(--surface);
    border-radius: 14px;
    border: 1px solid var(--sep-strong);
    box-shadow: var(--shadow-lg);
    overflow: hidden;
    animation: pop var(--med) var(--ease);
  }
  @keyframes pop {
    from {
      transform: translateY(-6px);
      opacity: 0;
    }
  }
  .search {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--sep);
    color: var(--text-2);
  }
  .search input {
    flex: 1;
    border: 0;
    background: transparent;
    font-size: 15px;
    color: var(--text);
  }
  .search input:focus-visible {
    box-shadow: none;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 6px;
    max-height: 50vh;
    overflow: auto;
  }
  li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 8px;
    cursor: pointer;
  }
  li.active {
    background: var(--selected);
  }
  .ic {
    color: var(--text-2);
  }
  .name {
    flex: 1;
  }
  .acct {
    font-size: 12px;
    color: var(--text-2);
  }
  .none {
    color: var(--text-2);
    cursor: default;
  }
</style>
