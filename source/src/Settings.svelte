<script lang="ts">
  // Ember's Settings window (settings.html, opened by the background): sections on the left, a search that
  // finds any setting by its words, and each setting's control. The texts live in settings-catalog.ts.
  // Changes save to storage; the Ember window follows them (store.loadSettings).
  import { onMount, tick } from "svelte";
  import { store } from "./lib/store.svelte";
  import { api, env, initEnv } from "./lib/api";
  import { sendSettings } from "./lib/send-settings.svelte";
  import { accountLabel } from "./lib/mailboxes";
  import { UNDO_SEND_CHOICES } from "./lib/outbox";
  import { parseList } from "./lib/focus";
  import { LOCK_AFTER_CHOICES, trustedNetwork } from "./lib/lock";
  import { lock } from "./lib/lock.svelte";
  import { scanner } from "./lib/virustotal-scanner.svelte";
  import { EICAR_SHA256, validKey } from "./lib/virustotal";
  import LockScreen from "./components/LockScreen.svelte";
  import { DEFAULT_IMPORTANT, INBOX_IDS, INBOX_LABEL, groupsOf, type InboxId } from "./lib/inboxes";
  import { readFeedback } from "./lib/spam";
  import { agentLook } from "./lib/agent-activity";
  import { SECTIONS, SETTINGS, matchingShortcuts, searchSettings, type Need, type SectionId, type SettingItem } from "./lib/settings-catalog";
  import Icon from "./components/Icon.svelte";

  let ready = $state(false);
  /** How many things Agent Activity keeps (Settings → AI → Agent Activity). */
  let activityCount = $state(0);
  let dark = $state(matchMedia("(prefers-color-scheme: dark)").matches);
  let query = $state("");
  let searchInput: HTMLInputElement | undefined = $state();
  let pane: HTMLElement | undefined = $state();
  const fromHash = () => (SECTIONS.find((s) => s.id === location.hash.slice(1))?.id ?? "general") as SectionId;
  let section = $state<SectionId>(fromHash());

  $effect(() => {
    const t = store.settings.theme === "system" ? (dark ? "dark" : "light") : store.settings.theme;
    document.documentElement.dataset.theme = t;
  });

  onMount(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onScheme = () => (dark = mq.matches);
    mq.addEventListener("change", onScheme);
    // The background opens a section of a window that's already open by changing its #hash.
    const onHash = () => { section = fromHash(); query = ""; };
    addEventListener("hashchange", onHash);
    const refresh = () => sendSettings.refresh();
    // Spam senders (Inboxes): the list follows marks made in the Ember window.
    const onStorage = (changes: any, area: string) => {
      if (area !== "local") return;
      if (changes.spamFeedback) store.spamFeedback = readFeedback(changes.spamFeedback.newValue);
      // Agents that have used Ember, and the activity log's size, follow the Ember window.
      if (changes.agentRegistry) store.agentRegistry = changes.agentRegistry.newValue || null;
      if (changes.agentActivity) activityCount = Array.isArray(changes.agentActivity.newValue) ? changes.agentActivity.newValue.length : 0;
    };
    api.storage?.onChanged?.addListener(onStorage);
    api.permissions?.onAdded?.addListener(refresh);
    api.permissions?.onRemoved?.addListener(refresh);
    void (async () => {
      await Promise.all([initEnv(), lock.init()]);
      await store.loadSettings();
      store.spamFeedback = readFeedback((await api.storage.local.get("spamFeedback").catch(() => ({})))?.spamFeedback);
      const agents = await api.storage.local.get({ agentRegistry: null, agentActivity: [] }).catch(() => ({}));
      store.agentRegistry = agents?.agentRegistry || null;
      activityCount = Array.isArray(agents?.agentActivity) ? agents.agentActivity.length : 0;
      sendSettings.refresh();
      ready = true;
      await tick();
      searchInput?.focus();
      void store.loadAccountList();
      void store.countPerformanceReports();
      void store.connectCache().catch(() => {});
    })();
    return () => {
      mq.removeEventListener("change", onScheme);
      removeEventListener("hashchange", onHash);
      api.permissions?.onAdded?.removeListener(refresh);
      api.permissions?.onRemoved?.removeListener(refresh);
      api.storage?.onChanged?.removeListener(onStorage);
    };
  });

  const has: Record<Need, () => boolean> = {
    calendar: () => typeof api?.sparkCalendar?.calendarView === "function",
    sparkOnly: () => env.hasSparkOnly,
    updates: () => env.hasUpdates,
    clef: () => typeof api?.sparkAI?.clef === "function",
    agents: () => typeof api?.sparkAgent?.start === "function",
    backgroundSend: () => sendSettings.supported,
    network: () => typeof api?.sparkFocus?.network === "function",
    lock: () => typeof api?.sparkLock?.state === "function" && lock.available,
    scan: () => typeof api?.sparkScan?.lookup === "function",
  };
  // Settings → Inboxes: a Work/Personal inbox's group names, order and hidden groups.
  function saveGroups(inbox: InboxId, change: { order?: string[]; hidden?: string[]; labels?: Record<string, string> }) {
    void store.setSetting("inboxGroups", { ...store.settings.inboxGroups, [inbox]: { ...(store.settings.inboxGroups[inbox] || {}), ...change } }).catch(() => {});
  }
  function moveGroup(inbox: InboxId, id: string, by: number) {
    const ids = groupsOf(inbox, store.settings).map((g) => g.id);
    const i = ids.indexOf(id), j = i + by;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    saveGroups(inbox, { order: ids });
  }
  function renameGroup(inbox: InboxId, id: string, name: string) {
    const labels = { ...(store.settings.inboxGroups[inbox]?.labels || {}) };
    if (name.trim()) labels[id] = name.trim(); else delete labels[id];
    saveGroups(inbox, { labels });
  }
  function showGroup(inbox: InboxId, id: string, show: boolean) {
    const hidden = (store.settings.inboxGroups[inbox]?.hidden || []).filter((g) => g !== id);
    saveGroups(inbox, { hidden: show ? hidden : [...hidden, id] });
  }
  const senderRules = $derived(INBOX_IDS.flatMap((inbox) => Object.entries(store.settings.senderGroups[inbox] || {}).map(([email, group]) => ({ inbox, email, group: groupsOf(inbox, store.settings).find((g) => g.id === group)?.label || group }))));

  function shown(item: SettingItem): boolean {
    if (item.needs && !has[item.needs]()) return false;
    // Ember-only mode always opens Ember when Thunderbird starts.
    if (item.id === "openOnStartup") return !(env.hasSparkOnly && store.settings.windowMode && store.settings.sparkOnly);
    return true;
  }
  const items = $derived(ready ? SETTINGS.filter(shown) : []);
  const sections = $derived(SECTIONS.filter((s) => items.some((item) => item.section === s.id)));
  const results = $derived(query.trim() ? searchSettings(query, items) : []);
  const resultSections = $derived(sections.filter((s) => results.some((item) => item.section === s.id)));
  const current = $derived(sections.find((s) => s.id === section) ?? sections[0]);

  function go(id: SectionId) {
    section = id;
    query = "";
    history.replaceState(null, "", `#${id}`);
    pane?.scrollTo(0, 0);
  }

  function onKey(e: KeyboardEvent) {
    if (lock.covering) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "w") { e.preventDefault(); window.close(); return; }
    if ((mod && e.key.toLowerCase() === "f") || (e.key === "/" && !(e.target as HTMLElement)?.closest("input, select, textarea"))) {
      e.preventDefault();
      searchInput?.focus();
      searchInput?.select();
      return;
    }
    if (e.key === "Escape" && query) { e.preventDefault(); query = ""; searchInput?.focus(); }
  }

  const checked = (e: Event) => (e.target as HTMLInputElement).checked;

  // Focus (focus.ts): the network now comes from the background's focusState.
  const DAYS: [number, string][] = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];
  const here = $derived(store.focusState?.network ?? null);
  const hereKnown = $derived(here?.key ? store.settings.workNetworks.find((n) => n.key === here.key) : undefined);
  let networkName = $state("");
  let checkingNetwork = $state(false);
  async function checkNetwork() {
    checkingNetwork = true;
    try { await api.runtime.sendMessage({ type: "spark:focus" }); } catch { /* shown as unknown */ } finally { checkingNetwork = false; }
  }
  function addNetwork() {
    if (!here?.key || hereKnown) return;
    const name = networkName.trim() || (here.dns?.[0] ? here.dns[0].split(".").slice(-2, -1)[0] || "Work" : "Work");
    void store.setSetting("workNetworks", [...store.settings.workNetworks, { key: here.key, name }]);
    networkName = "";
  }
  // Lock (lock.ts): turning it on or off asks for Touch ID first; trusted networks are Focus's network keys.
  let lockBusy = $state(false);
  async function setLock(e: Event) {
    const input = e.currentTarget as HTMLInputElement, on = input.checked;
    input.checked = !on; // until macOS says yes
    lockBusy = true;
    try { if (await lock.verify(on ? "turn on the Ember lock" : "turn off the Ember lock")) await store.setSetting("lockEnabled", on); }
    finally { lockBusy = false; }
  }
  const hereTrusted = $derived(trustedNetwork(store.settings, here?.key));
  let trustedName = $state("");
  function trustNetwork() {
    if (!here?.key || hereTrusted) return;
    void store.setSetting("lockTrustedNetworks", [...store.settings.lockTrustedNetworks, { key: here.key, name: trustedName.trim() || hereKnown?.name || "Home" }]);
    trustedName = "";
  }
  // VirusTotal: Test key looks up the EICAR test file's fingerprint (only the hash is sent).
  let vtTesting = $state(false);
  let vtTest = $state<{ ok: boolean; text: string } | null>(null);
  async function testVirusTotal() {
    vtTesting = true;
    try { vtTest = await scanner.test(store.settings.virusTotalKey.trim(), EICAR_SHA256); } finally { vtTesting = false; }
  }
  const toggleDay = (day: number) => store.setSetting("workDays", store.settings.workDays.includes(day) ? store.settings.workDays.filter((d) => d !== day) : [...store.settings.workDays, day].sort());
  const listText = (list: string[]) => list.join(", ");

  const updateText = $derived.by(() => {
    const status = store.updateStatus;
    if (!status) return "Not checked yet";
    if (status.error) return `Couldn't update: ${status.error}`;
    if (status.ready) return `Ember ${status.ready} is ready`;
    return `Up to date (${status.current}) · checked ${new Date(status.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  });

  // AI agents (MCP): the server Ember puts in ~/Library/Application Support/Ember, and the Claude Code command.
  const AGENT_SERVER = "~/Library/Application Support/Ember/ember-mcp.mjs";
  const AGENT_COMMAND = `claude mcp add --scope user ember -- node "$HOME/Library/Application Support/Ember/ember-mcp.mjs"`;
  // AI sorting (Clef): the background's progress, and "Test connection" with the values entered.
  let aiTesting = $state(false);
  let aiTest = $state<{ ok: boolean; error?: string; answer?: string; confidence?: number; ms: number } | null>(null);
  async function testClef() {
    aiTesting = true;
    try { aiTest = await api.runtime.sendMessage({ type: "spark:ai-test", settings: { clefAccount: store.settings.clefAccount, clefToken: store.settings.clefToken, clefModel: store.settings.clefModel } }); }
    catch (error: any) { aiTest = { ok: false, error: error?.message || String(error), ms: 0 }; }
    finally { aiTesting = false; }
  }
  const aiStatusText = $derived.by(() => {
    if (!store.settings.clefAccount || !store.settings.clefToken) return "Enter your Cloudflare account ID and API token to turn this on.";
    if (!store.settings.aiSort) return "Off.";
    const status = store.aiSortStatus;
    if (!status || status.state === "off") return "Starting…";
    const count = `${status.sorted.toLocaleString()} of ${status.total.toLocaleString()} Inbox emails sorted`;
    if (status.state === "running") return `Sorting… ${count}`;
    if (status.state === "error") return `${count}. ${status.error}`;
    return `${count}. New mail is sorted as it arrives.`;
  });
</script>

<svelte:window onkeydown={onKey} />

{#snippet toggle(item: SettingItem, key: keyof typeof store.settings, disabled = false, on = !!store.settings[key])}
  <label class="row">
    <span class="txt"><b>{item.title}</b>{#if item.text}<small>{item.text}</small>{/if}</span>
    <input type="checkbox" class="switch" {disabled} checked={on} onchange={(e) => store.setSetting(key, checked(e) as any)} />
  </label>
{/snippet}

{#snippet heading(item: SettingItem)}
  <span class="txt"><b>{item.title}</b>{#if item.text}<small>{item.text}</small>{/if}</span>
{/snippet}

{#snippet setting(item: SettingItem)}
  {#if item.id === "theme"}
    <div class="row">
      {@render heading(item)}
      <div class="seg" role="radiogroup" aria-label="Appearance">
        {#each [["system", "Auto"], ["light", "Light"], ["dark", "Dark"]] as [v, l] (v)}
          <button role="radio" aria-checked={store.settings.theme === v} class:on={store.settings.theme === v} onclick={() => store.setSetting("theme", v as any)}>{l}</button>
        {/each}
      </div>
    </div>
  {:else if item.id === "quotedHistoryMode"}
    <div class="row">
      {@render heading(item)}
      <select aria-label={item.title} value={store.settings.quotedHistoryMode} onchange={(e) => store.setSetting("quotedHistoryMode", e.currentTarget.value as "panel" | "jump")}>
        <option value="panel">History side panel</option>
        <option value="jump">Jump to original messages</option>
      </select>
    </div>
  {:else if item.id === "emailDarkMode"}
    <div class="row">
      {@render heading(item)}
      <select aria-label={item.title} value={store.settings.emailDarkMode} onchange={(e) => store.setSetting("emailDarkMode", e.currentTarget.value as "adapt" | "paper")}>
        <option value="adapt">Adapt colours to dark mode</option>
        <option value="paper">Keep original colours on white</option>
      </select>
    </div>
  {:else if item.id === "undoSend"}
    <div class="row">
      {@render heading(item)}
      <select aria-label={item.title} value={String(store.settings.undoSend)} onchange={(e) => store.setSetting("undoSend", Number(e.currentTarget.value))}>
        {#each UNDO_SEND_CHOICES as [seconds, text] (seconds)}<option value={String(seconds)}>{text}</option>{/each}
      </select>
    </div>
  {:else if item.id === "sendLater"}
    <div class="row">{@render heading(item)}<span class="glyph"><Icon name="clock" size={18} /></span></div>
  {:else if item.id === "backgroundSend"}
    <div class="row">
      {@render heading(item)}
      {#if sendSettings.enabled}<span class="state">Enabled</span>{:else}<button class="pill sm" disabled={sendSettings.busy} onclick={() => sendSettings.enable()}>{sendSettings.busy ? "Enabling…" : "Enable"}</button>{/if}
    </div>
    {#if sendSettings.error}<p class="note" role="status">{sendSettings.error}</p>{/if}
  {:else if item.id === "signatures"}
    <div class="row">{@render heading(item)}</div>
    {#each store.settings.signatures as sig (sig.id)}
      <div class="row sub">
        <input class="field name" aria-label="Signature name" value={sig.name} onchange={(e) => store.setSetting("signatures", store.settings.signatures.map((x) => x.id === sig.id ? { ...x, name: e.currentTarget.value.trim() || x.name } : x))} />
        <span class="preview">{new DOMParser().parseFromString(sig.html, "text/html").body.textContent?.trim().slice(0, 80)}</span>
        <button class="pill sm" onclick={() => store.setSetting("signatures", store.settings.signatures.filter((x) => x.id !== sig.id))}>Delete</button>
      </div>
    {:else}
      <p class="note">No saved signatures yet.</p>
    {/each}
  {:else if item.id === "workHours"}
    <div class="row">{@render heading(item)}</div>
    <div class="row sub wrap">
      <div class="days" role="group" aria-label="Work days">
        {#each DAYS as [day, label] (day)}<button class="day" aria-pressed={store.settings.workDays.includes(day)} onclick={() => toggleDay(day)}>{label}</button>{/each}
      </div>
      <label class="time">From <input type="time" class="field short" aria-label="Work starts" value={store.settings.workStart} onchange={(e) => store.setSetting("workStart", e.currentTarget.value || "09:00")} /></label>
      <label class="time">to <input type="time" class="field short" aria-label="Work ends" value={store.settings.workEnd} onchange={(e) => store.setSetting("workEnd", e.currentTarget.value || "17:00")} /></label>
    </div>
  {:else if item.id === "quietHours"}
    <div class="row">
      {@render heading(item)}
      <select aria-label={item.title} value={store.settings.quietHours} onchange={(e) => store.setSetting("quietHours", e.currentTarget.value as "off" | "outsideWork" | "always")}>
        <option value="off">Off</option>
        <option value="outsideWork">Outside work hours</option>
        <option value="always">All the time</option>
      </select>
    </div>
    {#if store.focusState && store.settings.quietHours !== "off"}<p class="note">{store.focusState.quiet ? "Quiet now." : "Not quiet now."}</p>{/if}
  {:else if item.id === "letThrough"}
    <div class="row">{@render heading(item)}</div>
    <label class="row sub column">
      <small class="status">People</small>
      <textarea class="field area" rows="2" placeholder="boss@work.org, Grace Hopper, @family.org" aria-label="People to let through" value={listText(store.settings.letThroughPeople)} onchange={(e) => store.setSetting("letThroughPeople", parseList(e.currentTarget.value))}></textarea>
    </label>
    <label class="row sub column">
      <small class="status">Words in the subject</small>
      <textarea class="field area" rows="2" placeholder="urgent, school, flight" aria-label="Subject words to let through" value={listText(store.settings.letThroughSubjects)} onchange={(e) => store.setSetting("letThroughSubjects", parseList(e.currentTarget.value))}></textarea>
    </label>
  {:else if item.id === "workAccounts" || item.id === "inboxAccounts"}
    <div class="row">{@render heading(item)}</div>
    {#each store.accounts as node (node.account.id)}
      <label class="row sub">
        <span class="address">{accountLabel(node.account, store.settings.accountNicknames)}</span>
        <input type="checkbox" class="switch" aria-label="{accountLabel(node.account, store.settings.accountNicknames)} is a work account" checked={store.settings.workAccounts.includes(node.account.id)}
          onchange={(e) => store.setSetting("workAccounts", checked(e) ? [...store.settings.workAccounts, node.account.id] : store.settings.workAccounts.filter((id) => id !== node.account.id))} />
      </label>
    {/each}
    {#if item.id === "inboxAccounts" && !store.split}<p class="note">Turn on a work account (and keep another account off) to split your mail into Work and Personal.</p>
    {:else if store.focusState?.hiddenAccounts.length}<p class="note">Work mail is hidden now.</p>{/if}
  {:else if item.id === "workGroups" || item.id === "personalGroups"}
    {@const inbox = item.id === "workGroups" ? "work" : "personal"}
    <div class="row">{@render heading(item)}</div>
    {#each groupsOf(inbox, store.settings) as group, i (group.id)}
      {@const all = groupsOf(inbox, store.settings).length}
      <div class="row sub group-row" title={group.description}>
        <span class="glyph"><Icon name={group.icon} size={16} /></span>
        <input class="field name" aria-label="Name of the {INBOX_LABEL[inbox]} group {group.label}" value={group.label} onchange={(e) => renameGroup(inbox, group.id, e.currentTarget.value)} />
        <span class="preview">{group.description}</span>
        <button class="icon-btn" aria-label="Move {group.label} up" disabled={i === 0} onclick={() => moveGroup(inbox, group.id, -1)}><span class="up"><Icon name="chevronDown" size={15} /></span></button>
        <button class="icon-btn" aria-label="Move {group.label} down" disabled={i === all - 1} onclick={() => moveGroup(inbox, group.id, 1)}><Icon name="chevronDown" size={15} /></button>
        <input type="checkbox" class="switch" aria-label="Show {group.label}" checked={!group.hidden} onchange={(e) => showGroup(inbox, group.id, checked(e))} />
      </div>
    {/each}
  {:else if item.id === "senderGroups"}
    <div class="row">{@render heading(item)}</div>
    {#each senderRules as rule (rule.inbox + rule.email)}
      <div class="row sub">
        <span class="address">{rule.email}</span>
        <span class="preview">{INBOX_LABEL[rule.inbox]} → {rule.group}</span>
        <button class="pill sm" onclick={() => store.setSenderGroup(rule.inbox, rule.email, null)}>Remove</button>
      </div>
    {:else}
      <p class="note">None yet.</p>
    {/each}
  {:else if item.id === "spamSenders"}
    <div class="row">{@render heading(item)}</div>
    {#each Object.entries(store.spamFeedback.senders).sort((a, b) => b[1] - a[1]) as [address, at] (address)}
      <div class="row sub">
        <span class="address">{address}</span>
        <span class="preview">since {new Date(at).toLocaleDateString()}</span>
        <button class="pill sm" aria-label="Remove {address} from spam senders" onclick={() => store.forgetSpamSender(address)}>Remove</button>
      </div>
    {:else}
      <p class="note">None yet.</p>
    {/each}
  {:else if item.id === "inboxImportant"}
    <div class="row">{@render heading(item)}</div>
    {#each INBOX_IDS as inbox (inbox)}
      <label class="row sub column">
        <small class="status">{INBOX_LABEL[inbox]}</small>
        <textarea class="field area" rows="2" aria-label="What's important in {INBOX_LABEL[inbox]}" value={store.settings.inboxImportant[inbox] ?? DEFAULT_IMPORTANT[inbox]}
          onchange={(e) => store.setSetting("inboxImportant", { ...store.settings.inboxImportant, [inbox]: e.currentTarget.value.trim() })}></textarea>
      </label>
    {/each}
  {:else if item.id === "workNetworks"}
    <div class="row">{@render heading(item)}</div>
    {#each store.settings.workNetworks as net (net.key)}
      <div class="row sub">
        <input class="field name" aria-label="Network name" value={net.name} onchange={(e) => store.setSetting("workNetworks", store.settings.workNetworks.map((n) => n.key === net.key ? { ...n, name: e.currentTarget.value.trim() || n.name } : n))} />
        <span class="preview">{net.key === here?.key ? "You're on this network" : ""}</span>
        <button class="pill sm" onclick={() => store.setSetting("workNetworks", store.settings.workNetworks.filter((n) => n.key !== net.key))}>Remove</button>
      </div>
    {/each}
    <div class="row sub">
      {#if !here?.key}
        <small class="status">Ember can't tell which network this is (offline?).</small>
      {:else if hereKnown}
        <small class="status">This network is “{hereKnown.name}”.</small>
      {:else}
        <small class="status">This network{here.dns?.length ? ` (${here.dns.join(", ")})` : ""}</small>
        <input class="field name" placeholder="Name, e.g. Office" aria-label="Name for this network" bind:value={networkName} />
        <button class="pill sm primary" onclick={addNetwork}>Add as work network</button>
      {/if}
      <button class="pill sm" disabled={checkingNetwork} onclick={checkNetwork}>{checkingNetwork ? "Checking…" : "Check again"}</button>
    </div>
  {:else if item.id === "lockEnabled"}
    <label class="row">
      {@render heading(item)}
      <input type="checkbox" class="switch" disabled={lockBusy} checked={store.settings.lockEnabled} onchange={setLock} />
    </label>
  {:else if item.id === "lockAfter"}
    <div class="row">
      {@render heading(item)}
      <select aria-label={item.title} disabled={!store.settings.lockEnabled} value={String(store.settings.lockAfter)} onchange={(e) => store.setSetting("lockAfter", Number(e.currentTarget.value))}>
        {#each LOCK_AFTER_CHOICES as [minutes, text] (minutes)}<option value={String(minutes)}>{text}</option>{/each}
      </select>
    </div>
  {:else if item.id === "lockOnSleep" || item.id === "lockOnStart"}
    {@render toggle(item, item.id as "lockOnSleep" | "lockOnStart", !store.settings.lockEnabled)}
  {:else if item.id === "lockTrustedNetworks"}
    <div class="row">{@render heading(item)}</div>
    {#each store.settings.lockTrustedNetworks as net (net.key)}
      <div class="row sub">
        <input class="field name" aria-label="Network name" value={net.name} onchange={(e) => store.setSetting("lockTrustedNetworks", store.settings.lockTrustedNetworks.map((n) => n.key === net.key ? { ...n, name: e.currentTarget.value.trim() || n.name } : n))} />
        <span class="preview">{net.key === here?.key ? "You're on this network" : ""}</span>
        <button class="pill sm" onclick={() => store.setSetting("lockTrustedNetworks", store.settings.lockTrustedNetworks.filter((n) => n.key !== net.key))}>Remove</button>
      </div>
    {/each}
    <div class="row sub">
      {#if !here?.key}
        <small class="status">Ember can't tell which network this is (offline?).</small>
      {:else if hereTrusted}
        <small class="status">This network is “{hereTrusted.name}”.</small>
      {:else}
        <small class="status">This network{hereKnown ? ` (work network “${hereKnown.name}”)` : here.dns?.length ? ` (${here.dns.join(", ")})` : ""}</small>
        <input class="field name" placeholder="Name, e.g. Home" aria-label="Name for this trusted network" bind:value={trustedName} />
        <button class="pill sm primary" onclick={trustNetwork}>Don't lock here</button>
      {/if}
      <button class="pill sm" disabled={checkingNetwork} onclick={checkNetwork}>{checkingNetwork ? "Checking…" : "Check again"}</button>
    </div>
  {:else if item.id === "virusTotalKey"}
    <div class="row">{@render heading(item)}</div>
    <div class="row sub">
      <input class="field mono" type="password" placeholder="API key (64 letters and digits)" aria-label="VirusTotal API key" autocomplete="off" spellcheck="false" value={store.settings.virusTotalKey} onchange={(e) => { vtTest = null; void store.setSetting("virusTotalKey", e.currentTarget.value.trim()); }} />
      <button class="pill sm" disabled={vtTesting || !validKey(store.settings.virusTotalKey)} onclick={testVirusTotal}>{vtTesting ? "Testing…" : "Test key"}</button>
    </div>
    {#if vtTest}<p class="note" class:good={vtTest.ok} class:bad={!vtTest.ok} role="status">{vtTest.text}</p>
    {:else if store.settings.virusTotalKey && !validKey(store.settings.virusTotalKey)}<p class="note bad">That doesn't look like a VirusTotal API key (64 letters and digits).</p>{/if}
  {:else if item.id === "virusTotalAuto"}
    {@render toggle(item, "virusTotalAuto", !validKey(store.settings.virusTotalKey))}
  {:else if item.id === "virusTotalUpload"}
    <div class="row">{@render heading(item)}<span class="glyph"><Icon name="shield" size={18} /></span></div>
  {:else if item.id === "lockNow"}
    <div class="row">{@render heading(item)}<button class="pill sm" disabled={!store.settings.lockEnabled} onclick={() => lock.lockNow()}>Lock now</button></div>
  {:else if item.id === "workMailRule"}
    <div class="row">
      {@render heading(item)}
      <select aria-label={item.title} value={store.settings.workMailRule} onchange={(e) => store.setSetting("workMailRule", e.currentTarget.value as "networkOrHours" | "network")}>
        <option value="networkOrHours">On a work network, or in work hours</option>
        <option value="network">Only on a work network</option>
      </select>
    </div>
  {:else if item.id === "meetingReminder"}
    <div class="row">
      {@render heading(item)}
      <select aria-label={item.title} value={String(store.settings.meetingReminder)} onchange={(e) => store.setSetting("meetingReminder", Number(e.currentTarget.value))}>
        <option value="1">1 minute before</option>
        <option value="5">5 minutes before</option>
        <option value="10">10 minutes before</option>
        <option value="15">15 minutes before</option>
        <option value="-1">As set in Outlook</option>
        <option value="0">Off</option>
      </select>
    </div>
  {:else if item.id === "accountNicknames"}
    <div class="row">{@render heading(item)}</div>
    {#each store.accounts as node (node.account.id)}
      <label class="row sub">
        <span class="address" title={node.account.name}>{accountLabel(node.account)}</span>
        <input class="field" placeholder="Nickname, e.g. Work" aria-label="Nickname for {accountLabel(node.account)}" value={store.settings.accountNicknames[node.account.id] || ""}
          onchange={(e) => { const value = e.currentTarget.value.trim(); const next = { ...store.settings.accountNicknames }; if (value) next[node.account.id] = value; else delete next[node.account.id]; void store.setSetting("accountNicknames", next); }} />
      </label>
    {/each}
  {:else if item.id === "aiSort"}
    {@render toggle(item, "aiSort", !store.settings.clefAccount || !store.settings.clefToken)}
    <label class="row sub">
      <span class="address">Account ID</span>
      <input class="field mono" placeholder="32 letters and digits" aria-label="Cloudflare account ID" autocomplete="off" spellcheck="false" value={store.settings.clefAccount}
        onchange={(e) => { aiTest = null; void store.setSetting("clefAccount", e.currentTarget.value.trim()); }} />
    </label>
    <label class="row sub">
      <span class="address">API token</span>
      <input class="field mono" type="password" placeholder="Workers AI token" aria-label="Cloudflare API token" autocomplete="off" spellcheck="false" value={store.settings.clefToken}
        onchange={(e) => { aiTest = null; void store.setSetting("clefToken", e.currentTarget.value.trim()); }} />
    </label>
    <label class="row sub">
      <span class="address">Model</span>
      <select aria-label="Clef model" value={store.settings.clefModel} onchange={(e) => store.setSetting("clefModel", e.currentTarget.value as "clef" | "clef-flash")}>
        <option value="clef-flash">Clef-flash: faster, cheaper</option>
        <option value="clef">Clef: larger, may be more accurate</option>
      </select>
    </label>
    <div class="row sub">
      <small class="status">{aiStatusText}</small>
      <button class="pill sm" disabled={aiTesting || !store.settings.clefAccount || !store.settings.clefToken} onclick={testClef}>{aiTesting ? "Testing…" : "Test connection"}</button>
    </div>
    {#if aiTest}<p class="note" class:good={aiTest.ok} class:bad={!aiTest.ok} role="status">{aiTest.ok ? `Connected: a sample email was sorted as ${aiTest.answer} (${Math.round((aiTest.confidence || 0) * 100)}% sure) in ${aiTest.ms} ms. No email of yours was sent.` : aiTest.error}</p>{/if}
    <p class="note">Get both in the Cloudflare dashboard: the account ID is on your account's home page; for the token, open My Profile → API Tokens → Create Token → "Workers AI" template. The token is kept in Thunderbird's profile on this Mac.</p>
  {:else if item.id === "agentAccess"}
    {@render toggle(item, "agentAccess")}
    {#if store.settings.agentAccess}
      <div class="row sub"><small class="status">{store.agentSocket?.path ? "Listening for agents." : store.agentSocket?.error ? `Couldn't start: ${store.agentSocket.error}` : "Starts when Ember's window is open."}</small></div>
      <p class="note">To connect Claude Code, run this once in Terminal:</p>
      <code class="command">{AGENT_COMMAND}</code>
      <p class="note">Other agents: run <code>node "{AGENT_SERVER}"</code> as an MCP server over stdio. Ember must be open (its window can stay minimized).</p>
    {/if}
  {:else if item.id === "agentAlert"}
    {@render toggle(item, "agentAlert")}
  {:else if item.id === "agentsSeen"}
    <div class="row">{@render heading(item)}</div>
    {#each Object.entries(store.agentRegistry?.agents || {}).sort((a, b) => b[1].last - a[1].last) as [id, info] (id)}
      {@const look = agentLook(id, info.title)}
      <div class="row sub agent-row">
        <span class="agent-badge" style:background={look.color}>{look.initials}</span>
        <span class="address">{look.name}{#if info.blocked} · Blocked{:else if info.alert} · New{/if}</span>
        <span class="preview">last used {new Date(info.last).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {info.count} {info.count === 1 ? "request" : "requests"}</span>
        <button class="pill sm" class:danger-text={!info.blocked} aria-label="{info.blocked ? 'Unblock' : 'Block'} {look.name}" onclick={() => store.setAgent(id, { blocked: !info.blocked, alert: false })}>{info.blocked ? "Unblock" : "Block"}</button>
      </div>
    {:else}
      <p class="note">None yet.</p>
    {/each}
  {:else if item.id === "agentActivityDays"}
    <div class="row">
      {@render heading(item)}
      <select aria-label="Keep agent activity for" value={String(store.settings.agentActivityDays)} onchange={(e) => store.setSetting("agentActivityDays", Number(e.currentTarget.value))}>
        {#each [7, 30, 90] as days (days)}<option value={String(days)}>{days} days</option>{/each}
      </select>
    </div>
    <div class="row sub">
      <small class="status">{activityCount ? `${activityCount.toLocaleString()} ${activityCount === 1 ? "thing" : "things"} kept` : "Nothing kept yet."}</small>
      <button class="pill sm danger-text" disabled={!activityCount} onclick={() => { if (confirm("Clear everything agents did from Agent Activity? Their marks and drafts stay.")) void store.clearAgentActivity(); }}>Clear activity</button>
    </div>
  {:else if item.id === "emailLinks"}
    {@render toggle(item, "emailLinks")}
    {#if store.settings.emailLinks}
      <div class="row sub"><small class="status">{store.mailLinkStatus?.url ? `Links open at ${store.mailLinkStatus.url}` : store.mailLinkStatus?.error ? `Couldn't start: ${store.mailLinkStatus.error}` : "Starting…"}</small></div>
    {/if}
  {:else if item.id === "sparkOnly"}
    {@render toggle(item, "sparkOnly", !store.settings.windowMode, store.settings.windowMode && store.settings.sparkOnly)}
  {:else if item.id === "addAccount"}
    <div class="row">{@render heading(item)}<button class="pill sm" onclick={() => store.addAccount()}>Add…</button></div>
  {:else if item.id === "switchToThunderbird"}
    <div class="row">{@render heading(item)}<button class="pill sm" onclick={() => store.switchToThunderbird()}>Switch</button></div>
  {:else if item.id === "cache"}
    <div class="row">{@render heading(item)}</div>
    <div class="row sub column">
      <small class="status" role="status">
        {#if store.cacheStatus.phase === "index"}Finding emails to save… {store.cacheStatus.total} found
        {:else if store.cacheStatus.phase === "paused"}Paused · saved mail is still available
        {:else if store.cacheStatus.phase === "bodies"}Saving and indexing… {store.cacheStatus.done} / {store.cacheStatus.total}
        {:else if store.cacheStatus.phase === "ready"}{store.cacheStatus.saved.toLocaleString()} emails saved · ready for fast reading
        {:else if store.cacheStatus.phase === "error"}{store.cacheStatus.error || "Saving mail needs another attempt."}
        {:else}{store.cacheStatus.saved.toLocaleString()} emails saved · checking for updates shortly{/if}
      </small>
      {#each Object.entries(store.cacheStatus.accounts || {}) as [id, progress] (id)}
        <div class="progress"><span>{store.accountName(id) || progress.name || "Mailbox"}</span><span>{progress.done} / {progress.total}{progress.failed ? ` · ${progress.failed} need retry` : ""}</span><progress value={progress.done} max={progress.total || 1} aria-label="Saving progress for {id}"></progress></div>
      {/each}
      <div class="buttons">
        <button class="pill sm" onclick={() => store.pauseLocalCache(store.cacheStatus.phase !== "paused")}>{store.cacheStatus.phase === "paused" ? "Resume saving" : "Pause saving"}</button>
        <button class="pill sm" disabled={store.cacheStatus.phase === "index" || store.cacheStatus.phase === "bodies" || store.cacheStatus.phase === "paused"} onclick={() => store.retryLocalCache()}>Refresh saved mail</button>
      </div>
    </div>
  {:else if item.id === "autoUpdate"}
    {@render toggle(item, "autoUpdate")}
    <div class="row sub">
      <small class="status">{updateText}</small>
      <button class="pill sm" disabled={store.updateStatus?.installing} onclick={() => store.checkForUpdate()}>Check now</button>
      {#if store.updateStatus?.ready}<button class="pill sm primary" disabled={store.updateStatus.installing} onclick={() => store.installUpdate()}>{store.updateStatus.installing ? "Updating…" : `Update to ${store.updateStatus.ready}`}</button>{/if}
    </div>
  {:else if item.id === "shortcuts"}
    <dl class="keys">
      {#each query.trim() && matchingShortcuts(query).length ? matchingShortcuts(query) : matchingShortcuts("") as [k, l] (k)}
        <dt><kbd>{k}</kbd></dt>
        <dd>{l}</dd>
      {/each}
    </dl>
  {:else if item.id === "perfRecorder"}
    {@render toggle(item, "perfRecorder")}
    <div class="row sub buttons">
      <button class="pill sm" disabled={!store.settings.perfRecorder} onclick={() => store.savePerformanceReport("button").then(() => store.countPerformanceReports())}>Save report now</button>
      <button class="pill sm" disabled={!store.perfReports} onclick={() => store.exportPerformanceReports()}>Export saved reports ({store.perfReports})</button>
      <button class="pill sm" disabled={!store.perfReports} onclick={() => store.clearPerformanceReports()}>Clear</button>
    </div>
  {:else if item.id === "about"}
    <div class="row"><span class="txt"><b>Ember for Thunderbird {api.runtime?.getManifest?.().version ?? ""}</b><small>Thunderbird {env.tb}</small></span><button class="pill sm" onclick={() => api.runtime.sendMessage({ type: "spark:open" })}>Open Ember</button></div>
  {:else if item.id in store.settings}
    {@render toggle(item, item.id as keyof typeof store.settings)}
  {/if}
{/snippet}

<div class="settings">
  <nav class="side" aria-label="Settings sections">
    <div class="search">
      <Icon name="search" size={15} />
      <input bind:this={searchInput} bind:value={query} type="search" placeholder="Search settings" aria-label="Search settings" autocomplete="off" spellcheck="false" />
    </div>
    <ul>
      {#each sections as s (s.id)}
        <li><button class:on={!query.trim() && current?.id === s.id} aria-current={!query.trim() && current?.id === s.id ? "page" : undefined} onclick={() => go(s.id)}><span class="ico"><Icon name={s.icon} size={16} /></span>{s.label}</button></li>
      {/each}
    </ul>
  </nav>

  <main class="pane" bind:this={pane}>
    {#if !ready}
      <p class="empty">Loading…</p>
    {:else if query.trim()}
      <h1>Search</h1>
      {#each resultSections as s (s.id)}
        <h2><button class="jump" onclick={() => go(s.id)}>{s.label}</button></h2>
        <div class="card">{#each results.filter((item) => item.section === s.id) as item (item.id)}<div class="item">{@render setting(item)}</div>{/each}</div>
      {:else}
        <p class="empty">No settings match “{query.trim()}”.</p>
      {/each}
    {:else if current}
      <h1>{current.label}</h1>
      <div class="card">{#each items.filter((item) => item.section === current.id) as item (item.id)}<div class="item">{@render setting(item)}</div>{/each}</div>
    {/if}
  </main>
</div>
{#if lock.covering}<LockScreen />{/if}

<style>
  :global(body) { background: var(--bg); }
  .settings { display: grid; grid-template-columns: 220px 1fr; height: 100vh; }
  .side { background: var(--sidebar); border-right: 1px solid var(--sep); padding: 14px 10px; overflow-y: auto; }
  .search { display: flex; align-items: center; gap: 7px; height: 32px; padding: 0 10px; margin-bottom: 12px; border-radius: 9px; background: var(--surface); border: 1px solid var(--sep-strong); color: var(--text-3); }
  .search:focus-within { box-shadow: var(--focus); border-color: transparent; }
  .search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; font-size: 13px; }
  .side ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 1px; }
  .side li button { display: flex; align-items: center; gap: 9px; width: 100%; height: 32px; padding: 0 8px; border-radius: 8px; font-size: 13.5px; color: var(--text); text-align: left; }
  .side li button:hover { background: var(--hover); }
  .side li button.on { background: var(--sidebar-active); font-weight: 600; }
  .ico { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 7px; background: var(--accent-soft); color: var(--accent-text); flex: none; }
  .pane { overflow-y: auto; padding: 22px 28px 40px; }
  h1 { font-size: 20px; font-weight: 650; margin: 0 0 16px; }
  h2 { margin: 20px 0 8px; font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--text-2); }
  h2:first-of-type { margin-top: 0; }
  .jump { color: inherit; font: inherit; letter-spacing: inherit; text-transform: inherit; }
  .jump:hover { color: var(--accent-text); }
  .card { max-width: 680px; border: 1px solid var(--sep-strong); border-radius: 12px; background: var(--surface); overflow: hidden; }
  .item + .item { border-top: 1px solid var(--sep); }
  .empty { color: var(--text-2); font-size: 13px; }
  .row { display: flex; align-items: center; gap: 14px; padding: 12px 16px; min-height: 30px; }
  .row.sub { padding-top: 4px; padding-bottom: 8px; }
  .group-row .field.name { width: 190px; flex: none; }
  .group-row .up { display: inline-flex; transform: rotate(180deg); }
  .row.column { flex-direction: column; align-items: stretch; gap: 8px; }
  .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .txt b { font-weight: 550; font-size: 13.5px; }
  .txt small { color: var(--text-2); font-size: 12px; line-height: 1.45; }
  .glyph, .state { color: var(--text-2); font-size: 12.5px; flex: none; }
  .status { flex: 1; color: var(--text-2); font-size: 12px; }
  .note { margin: 0 16px 10px; font-size: 11.5px; color: var(--text-3); line-height: 1.45; }
  .note.good { color: var(--success); }
  .note.bad { color: var(--danger); }
  .note code { font-size: 11px; }
  .command { display: block; margin: 0 16px 10px; padding: 8px 10px; border-radius: 8px; background: var(--surface-2); border: 1px solid var(--sep); font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; user-select: all; }
  select, .field { height: 30px; border: 1px solid var(--sep-strong); border-radius: 8px; padding: 0 8px; background: var(--surface-2); color: var(--text); font: inherit; font-size: 13px; }
  select { flex: none; max-width: 240px; }
  .field { width: 240px; }
  .field.name { width: 150px; }
  .field.short { width: 136px; }
  .field.area { width: 100%; height: auto; min-height: 52px; padding: 6px 8px; resize: vertical; line-height: 1.4; box-sizing: border-box; }
  .row.wrap { flex-wrap: wrap; gap: 10px; }
  .days { display: flex; gap: 4px; flex-wrap: wrap; }
  .day { height: 28px; padding: 0 10px; border-radius: 999px; border: 1px solid var(--sep-strong); font-size: 12.5px; color: var(--text-2); }
  .day[aria-pressed="true"] { background: var(--accent); border-color: transparent; color: var(--on-accent); font-weight: 600; }
  .time { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-2); }
  .row.sub select { width: 300px; max-width: none; }
  .field.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; width: 300px; }
  .address { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--text-2); }
  .preview { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--text-2); }
  .agent-badge { flex: none; width: 24px; height: 24px; border-radius: 7px; color: #fff; font-size: 10px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
  .agent-row .address { flex: 0 1 auto; color: var(--text); font-weight: 600; }
  .danger-text { color: var(--danger); }
  .buttons { display: flex; flex-wrap: wrap; gap: 8px; }
  .progress { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px; font-size: 11px; color: var(--text-2); }
  .progress progress { width: 100%; height: 5px; accent-color: var(--accent); }
  .pill.sm { height: 28px; padding: 0 12px; font-size: 12.5px; border: 1px solid var(--sep-strong); flex: none; }
  .pill.sm.primary { border-color: transparent; }
  .switch { appearance: none; width: 38px; height: 22px; border-radius: 999px; background: var(--surface-3); border: 1px solid var(--sep-strong); position: relative; cursor: pointer; flex: none; transition: background var(--fast) var(--ease); }
  .switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3); transition: transform var(--fast) var(--ease); }
  .switch:checked { background: var(--accent); border-color: transparent; }
  .switch:checked::after { transform: translateX(16px); }
  .switch:disabled { opacity: .5; cursor: default; }
  .switch:focus-visible { box-shadow: var(--focus); }
  .seg { display: flex; padding: 2px; border-radius: 9px; background: var(--surface-3); flex: none; }
  .seg button { padding: 4px 12px; border-radius: 7px; font-size: 12.5px; color: var(--text-2); }
  .seg button.on { background: var(--surface); color: var(--text); box-shadow: var(--shadow-sm); font-weight: 600; }
  .keys { display: grid; grid-template-columns: 90px 1fr; gap: 8px 12px; margin: 0; padding: 14px 16px; font-size: 13px; align-items: center; }
  .keys dd { margin: 0; }
  @media (max-width: 620px) {
    .settings { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
    .side { border-right: 0; border-bottom: 1px solid var(--sep); }
    .side ul { flex-direction: row; flex-wrap: wrap; }
    .side li button { width: auto; }
    .pane { padding: 16px; }
  }
</style>
