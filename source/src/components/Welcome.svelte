<script lang="ts">
  // Shown instead of the inbox while Thunderbird has no mail account (someone who has just installed Ember):
  // what Ember is, and a button to Thunderbird's own account setup. Ember fills in as soon as an account exists.
  import { store } from "../lib/store.svelte";

  let opening = $state(false);
  let opened = $state(false);
  async function add() {
    opening = true;
    try { await store.addAccount(); opened = true; } finally { opening = false; }
  }
</script>

<section class="welcome" aria-labelledby="welcome-title">
  <div class="card">
    <img class="logo" src="icons/ember.svg" alt="" width="72" height="72" />
    <h1 id="welcome-title">Welcome to Ember</h1>
    <p class="lead">A calmer way through your email, inside Thunderbird. Thunderbird keeps doing the accounts, syncing and sending; Ember is where you read, write and plan your day.</p>
    <button class="primary" disabled={opening} onclick={add}>{opening ? "Opening…" : "Add an email account"}</button>
    {#if opened}
      <p class="next" role="status">Thunderbird's account setup is open in its window. Gmail, Outlook and Microsoft 365, iCloud, Exchange and most other providers set themselves up from your address. Come back here when it's done: your mail appears as soon as the account is added.</p>
    {:else}
      <p class="hint">Thunderbird's account setup opens in its own window. Accounts you already use in Thunderbird appear here by themselves.</p>
    {/if}
  </div>
</section>

<style>
  .welcome { flex: 1; min-width: 0; display: flex; align-items: center; justify-content: center; padding: 32px; background: var(--bg); }
  .card { max-width: 460px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 14px; }
  .logo { filter: drop-shadow(0 8px 18px rgba(0, 0, 0, 0.2)); }
  h1 { margin: 6px 0 0; font-size: 26px; font-weight: 700; letter-spacing: -0.01em; color: var(--text); }
  .lead { margin: 0; font-size: 14.5px; line-height: 1.5; color: var(--text-2); }
  .primary { margin-top: 8px; height: 38px; padding: 0 22px; border: 0; border-radius: 10px; background: var(--accent); color: var(--on-accent); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; }
  .primary:disabled { opacity: 0.6; cursor: default; }
  .primary:focus-visible { outline: none; box-shadow: var(--focus); }
  .hint, .next { margin: 0; font-size: 12.5px; line-height: 1.45; color: var(--text-3); }
  .next { color: var(--text-2); }
</style>
