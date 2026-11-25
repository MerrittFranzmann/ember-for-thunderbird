<script lang="ts">
  // The cover over an Ember page while the Touch ID lock is on (lock.svelte.ts). Everything else on the page is
  // inert under it (no focus, clicks or keys; hidden from screen readers). Coming back to the window, or
  // pressing a key, asks for Touch ID straight away; the button asks too.
  import { lock } from "../lib/lock.svelte";
  import { lockReasonText } from "../lib/lock";
  import Icon from "./Icon.svelte";

  let cover: HTMLElement | undefined = $state();

  $effect(() => {
    const parent = cover?.parentElement;
    if (!cover || !parent) return;
    const made = new Set<HTMLElement>();
    const inert = () => {
      for (const el of parent.children) {
        if (el === cover || !(el instanceof HTMLElement) || el.inert) continue;
        el.inert = true;
        made.add(el);
      }
    };
    inert();
    // Toasts and dialogs that appear while locked are covered too.
    const watch = new MutationObserver(inert);
    watch.observe(parent, { childList: true });
    return () => { watch.disconnect(); for (const el of made) el.inert = false; };
  });

  function ask() { if (lock.locked && !lock.asking) void lock.unlock(); }
  function onKey(e: KeyboardEvent) {
    if (!lock.locked || ["Shift", "Control", "Alt", "Meta", "CapsLock", "Tab"].includes(e.key)) return;
    e.preventDefault();
    ask();
  }
</script>

<svelte:window onfocus={ask} onkeydown={onKey} />

<div class="lock" bind:this={cover} role={lock.ready ? "dialog" : undefined} aria-modal={lock.ready ? "true" : undefined} aria-label={lock.ready ? "Ember is locked" : undefined}>
  {#if lock.ready}
    <div class="card">
      <span class="badge"><Icon name="lock" size={30} stroke={1.6} /></span>
      <h1>Ember is locked</h1>
      <p class="why">{lockReasonText(lock.reason, lock.idleMinutes)}</p>
      <button class="pill primary unlock" disabled={lock.asking} onclick={ask}>
        <Icon name="fingerprint" size={18} />{lock.asking ? "Waiting for Touch ID…" : "Unlock with Touch ID"}
      </button>
      <p class="hint" role="status">{lock.failed ? "Not unlocked. Try again, or use your Mac's password." : "Or your Mac's password."}</p>
    </div>
  {/if}
</div>

<style>
  .lock {
    position: fixed; inset: 0; z-index: 10000;
    display: grid; place-items: center;
    background: radial-gradient(120% 80% at 50% 0%, var(--accent-soft), transparent 60%), var(--bg);
  }
  .card { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 24px; max-width: 360px; text-align: center; }
  .badge { width: 68px; height: 68px; border-radius: 50%; display: grid; place-items: center; background: var(--surface); color: var(--accent-text); box-shadow: var(--shadow-sm), 0 0 0 1px var(--sep); margin-bottom: 6px; }
  h1 { margin: 0; font-size: 21px; font-weight: 650; letter-spacing: -0.01em; color: var(--text); }
  .why { margin: 0; font-size: 13px; line-height: 1.45; color: var(--text-2); }
  .unlock { margin-top: 10px; height: 36px; padding: 0 18px; gap: 8px; font-size: 13.5px; font-weight: 600; display: inline-flex; align-items: center; }
  .unlock:disabled { opacity: .75; cursor: default; }
  .hint { margin: 0; min-height: 16px; font-size: 12px; color: var(--text-3); }
</style>
