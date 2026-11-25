<script lang="ts" module>
  /** Conversations whose line the user hid (until Ember reloads). */
  const hidden = $state<Record<string, boolean>>({});
</script>

<script lang="ts">
  // Under an email's subject: what an AI agent did to it (Agent Activity), e.g. "Claude Code moved this to the top
  // and drafted a reply · 2:14 PM", with Open draft and See activity.
  import { store } from "../lib/store.svelte";
  import { aiKey } from "../lib/ai-sort";
  import { agentLook, touchesOf } from "../lib/agent-activity";
  import { listDate } from "../lib/format";
  import type { Conversation } from "../lib/types";
  import Icon from "./Icon.svelte";

  let { conv }: { conv: Conversation } = $props();

  const ids = $derived(new Set([...store.headersOf(conv), conv.latest].map((m) => aiKey(m)).filter(Boolean)));
  const touches = $derived(touchesOf(store.agentActivity, ids));
  const latest = $derived(touches[0]);
  const look = $derived(latest ? agentLook(latest.agent, store.agentRegistry?.agents?.[latest.agent]?.title) : null);
  const words = $derived.by(() => {
    if (!latest) return "";
    const out: string[] = [];
    for (const e of touches.filter((t) => t.agent === latest.agent)) {
      const c = e.change || {};
      const said = e.kind === "draft" ? "drafted a reply" : c.top === true ? "moved this to the top" : c.top === false ? "took this off the top" : c.reply ? "marked this needs reply" : c.important ? "marked this important" : c.note ? "left a note" : "";
      if (said && !out.includes(said)) out.push(said);
    }
    return out.slice(0, 2).join(" and ");
  });
  const note = $derived(touches.find((e) => e.agent === latest?.agent && e.change?.note)?.change?.note || "");
  const draft = $derived(store.aiRev >= 0 ? store.agentDraftOf(conv) : null);
  const when = (at: number) => (new Date(at).toDateString() === new Date().toDateString() ? new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : listDate(at));
</script>

{#if latest && look && words && !hidden[conv.key]}
  <div class="agent-line">
    <span class="badge" style:background={look.color} title={look.name}>{look.initials}</span>
    <span class="text"><b>{look.name}</b> {words} · {when(latest.at)}</span>
    <span class="acts">
      {#if draft}<button class="text-action strong" onclick={() => store.openAgentDraftId(draft)}>Open draft</button>{/if}
      <button class="text-action" onclick={() => store.setView({ kind: "activity" })}>See activity</button>
      <button class="hide" aria-label="Hide this line" title="Hide" onclick={() => (hidden[conv.key] = true)}><Icon name="x" size={12} /></button>
    </span>
  </div>
  {#if note}<div class="agent-note">Note: “{note}”</div>{/if}
{/if}

<style>
  .agent-line { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 6px 0 2px; font-size: 13px; color: var(--text-2); }
  .badge { width: 20px; height: 20px; border-radius: 6px; color: #fff; font-size: 8.5px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; flex: none; }
  .text b { color: var(--text); font-weight: 600; }
  .acts { display: inline-flex; align-items: center; gap: 2px; }
  .text-action { border: 0; background: transparent; color: var(--accent-text); font: inherit; font-size: 13px; padding: 2px 6px; border-radius: 6px; cursor: pointer; }
  .text-action:hover { background: var(--hover); }
  .text-action.strong { font-weight: 600; }
  .hide { width: 22px; height: 22px; border: 0; border-radius: 6px; background: transparent; color: var(--text-3); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
  .hide:hover { background: var(--hover); }
  .agent-note { margin: 0 0 4px 28px; font-size: 13px; color: var(--text-3); }
</style>
