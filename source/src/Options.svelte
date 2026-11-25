<script lang="ts">
  // Thunderbird's Add-ons Manager page for Ember: its settings have their own window (settings.html).
  import { api } from "./lib/api";

  const send = (message: object) => void Promise.resolve(api.runtime.sendMessage(message)).catch(() => {});
</script>

<div class="opts">
  <p>Ember's settings open in their own window. In Ember, press <kbd>⌘</kbd> <kbd>,</kbd> or the gear in the sidebar.</p>
  <p class="buttons">
    <button class="pill primary" onclick={() => send({ type: "spark:settings" })}>Open Settings</button>
    <button class="pill" onclick={() => send({ type: "spark:open" })}>Open Ember</button>
  </p>
</div>

<style>
  :global(body.options) {
    overflow: auto;
    background: var(--surface);
  }
  .opts {
    max-width: 560px;
    padding: 12px 18px 16px;
    font-size: 13px;
  }
  .buttons {
    display: flex;
    gap: 8px;
  }
</style>
