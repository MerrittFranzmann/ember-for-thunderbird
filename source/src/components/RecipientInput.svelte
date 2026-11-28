<script lang="ts">
  import { suggest, type Suggestion } from "../lib/contacts";
  import { displayName, splitAddrs, avatarColor, initials, type Addr } from "../lib/format";

  let { label, value = $bindable([]), autofocus = false, id }: { label: string; value: Addr[]; autofocus?: boolean; id: string } = $props();

  let text = $state("");
  let input: HTMLInputElement | undefined = $state();
  let sugg = $state<Suggestion[]>([]);
  let active = $state(0);
  let open = $state(false);
  let seq = 0;
  // Long lists (reply all to a big thread) show the first few chips until expanded, like Spark.
  const COLLAPSED = 6;
  let showAll = $state(false);
  const shown = $derived(showAll || value.length <= COLLAPSED + 2 ? value : value.slice(0, COLLAPSED));

  $effect(() => {
    if (autofocus && input) setTimeout(() => input?.focus(), 30);
  });

  async function refresh() {
    const q = text.trim();
    const my = ++seq;
    if (!q) {
      sugg = [];
      open = false;
      return;
    }
    // Each keystroke asked Thunderbird to search every address book; wait for a pause in typing first.
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (my !== seq) return;
    const res = await suggest(q, new Set(value.map((a) => a.email.toLowerCase())));
    if (my !== seq) return;
    sugg = res;
    active = 0;
    open = res.length > 0;
  }

  function addFromText() {
    const parsed = splitAddrs(text.replace(/;/g, ","));
    const good = parsed.filter((a) => a.email.includes("@"));
    if (good.length) {
      value = [...value, ...good.filter((g) => !value.some((v) => v.email.toLowerCase() === g.email.toLowerCase()))];
      text = "";
      open = false;
      return true;
    }
    return false;
  }

  function pick(s: Suggestion) {
    value = [...value, { name: s.name, email: s.email }];
    text = "";
    sugg = [];
    open = false;
    input?.focus();
  }

  function remove(i: number) {
    value = value.filter((_, j) => j !== i);
    input?.focus();
  }

  function onKey(e: KeyboardEvent) {
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + sugg.length) % sugg.length;
      e.preventDefault();
    } else if ((e.key === "Enter" || e.key === "Tab") && open && sugg[active]) {
      // A complete address typed out is what's meant: Enter must not swap "ann@acme.com" for the top suggestion
      // "joann@acme.com" (suggestions match anywhere). An arrowed-to suggestion still wins.
      const typed = text.trim().replace(/^<|>$/g, "").toLowerCase();
      if (active === 0 && /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/.test(typed) && sugg[0].email.toLowerCase() !== typed) {
        const exact = sugg.find((s) => s.email.toLowerCase() === typed);
        if (exact) pick(exact); else addFromText();
        // ⌘↵ still sends (the composer handles it after this); a plain Enter or Tab only adds the address.
        if (!e.metaKey && !e.ctrlKey) e.preventDefault();
        return;
      }
      pick(sugg[active]);
      e.preventDefault();
    } else if (e.key === "Enter" || e.key === "," || e.key === ";") {
      if (text.trim() && addFromText()) e.preventDefault();
    } else if (e.key === "Backspace" && !text && value.length) {
      value = value.slice(0, -1);
    } else if (e.key === "Escape" && open) {
      open = false;
      e.stopPropagation();
    }
  }

  function onBlur() {
    setTimeout(() => {
      if (text.trim()) addFromText();
      open = false;
    }, 120);
  }

  function onPaste(e: ClipboardEvent) {
    const t = e.clipboardData?.getData("text") || "";
    if (t.includes("@") && /[,;\n]/.test(t)) {
      e.preventDefault();
      text = t.replace(/\n/g, ",");
      addFromText();
    }
  }
</script>

<div class="field">
  <label class="lbl" for={id}>{label}</label>
  <div class="chips" role="group" aria-label="{label} recipients">
    {#each shown as a, i (a.email + i)}
      <span class="chip" title={a.email}>
        <span class="mini" style="background:{avatarColor(a.email)}" aria-hidden="true">{initials(a)}</span>
        <span class="chip-name">{a.name || a.email}</span>
        <button class="x" aria-label="Remove {displayName(a)}" onclick={() => remove(i)} tabindex="-1">×</button>
      </span>
    {/each}
    {#if shown.length < value.length}
      <button class="more-chip" onclick={() => { showAll = true; input?.focus(); }} aria-label="Show all {value.length} recipients">+{value.length - shown.length} more</button>
    {/if}
    <div class="input-wrap">
      <input
        {id}
        bind:this={input}
        bind:value={text}
        oninput={refresh}
        onkeydown={onKey}
        onblur={onBlur}
        onpaste={onPaste}
        autocomplete="off"
        spellcheck="false"
        role="combobox"
        aria-expanded={open}
        aria-controls="{id}-list"
        aria-autocomplete="list"
        aria-activedescendant={open ? `${id}-opt-${active}` : undefined} />
      {#if open}
        <ul class="sugg" id="{id}-list" role="listbox">
          {#each sugg as s, i (s.email)}
            <li
              id="{id}-opt-{i}"
              role="option"
              aria-selected={i === active}
              class:active={i === active}
              onmousedown={(e) => {
                e.preventDefault();
                pick(s);
              }}>
              <span class="mini big" style="background:{avatarColor(s.email)}" aria-hidden="true">{initials(s)}</span>
              <span class="s-text">
                <span class="s-name">{s.name || s.email}</span>
                <span class="s-email">{s.email}</span>
              </span>
              <span class="src">{s.source === "contact" ? "Contact" : "Recent"}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
</div>

<style>
  .more-chip { height: 26px; padding: 0 10px; border-radius: 999px; font-size: 12.5px; font-weight: 600; color: var(--accent-text); background: var(--accent-softer); }
  .more-chip:hover { background: var(--accent-soft); }
  .field {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 6px 20px;
    border-bottom: 1px solid var(--sep);
    min-height: 44px;
  }
  .lbl {
    width: 44px;
    flex: none;
    color: var(--text-2);
    font-size: 13px;
    padding-top: 7px;
  }
  .chips {
    flex: 1;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    min-width: 0;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 4px 0 3px;
    border-radius: 999px;
    background: var(--chip);
    font-size: 13px;
    max-width: 260px;
  }
  .chip-name {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mini {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    color: #fff;
    font-size: 9.5px;
    font-weight: 700;
    display: grid;
    place-items: center;
    flex: none;
  }
  .mini.big {
    width: 30px;
    height: 30px;
    font-size: 11px;
  }
  .x {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    color: var(--text-2);
    font-size: 15px;
    line-height: 1;
  }
  .x:hover {
    background: var(--hover);
    color: var(--text);
  }
  .input-wrap {
    position: relative;
    flex: 1;
    min-width: 140px;
  }
  input {
    width: 100%;
    height: 30px;
    border: 0;
    background: transparent;
    font-size: 14px;
  }
  input:focus-visible {
    box-shadow: none;
  }
  .sugg {
    position: absolute;
    z-index: 10;
    left: -8px;
    top: 34px;
    width: min(380px, 80vw);
    list-style: none;
    margin: 0;
    padding: 6px;
    background: var(--surface);
    border: 1px solid var(--sep-strong);
    border-radius: 12px;
    box-shadow: var(--shadow-lg);
  }
  .sugg li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 8px;
    border-radius: 8px;
    cursor: pointer;
  }
  .sugg li.active {
    background: var(--selected);
  }
  .s-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .s-name {
    font-weight: 550;
    font-size: 13.5px;
  }
  .s-email {
    font-size: 12px;
    color: var(--text-2);
  }
  .src {
    font-size: 11px;
    color: var(--text-2);
  }
</style>
