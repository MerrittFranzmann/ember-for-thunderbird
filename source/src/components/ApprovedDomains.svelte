<script lang="ts">
  // The approved sender domains filter, shared by Attachments' Files and Links tabs.
  import { store } from "../lib/store.svelte";
  import { normalizeDomain } from "../lib/attachments";
  import Icon from "./Icon.svelte";

  let { managing = $bindable(false) }: { managing?: boolean } = $props();
  let domainInput = $state("");
  let domainError = $state("");

  async function setting(value: boolean) {
    try { await store.setSetting("attachmentApprovedOnly", value); }
    catch { store.toast({ text: "Couldn't save attachment preferences. Try again.", kind: "error" }); }
  }
  async function addDomain(e: SubmitEvent) {
    e.preventDefault();
    const domain = normalizeDomain(domainInput);
    if (!domain) { domainError = "Enter a domain such as example.org, without an email address or URL."; return; }
    try {
      await store.approveAttachmentDomain(domain);
      domainInput = "";
      domainError = "";
    } catch { domainError = "Couldn't save this domain. Try again."; }
  }
  async function removeDomain(domain: string) {
    try { await store.setSetting("approvedAttachmentDomains", store.settings.approvedAttachmentDomains.filter((d) => d !== domain)); }
    catch { store.toast({ text: "Couldn't save approved domains. Try again.", kind: "error" }); }
  }
</script>

<div class="filter-row">
  <label class="approved"><input type="checkbox" checked={store.settings.attachmentApprovedOnly} onchange={(e) => setting(e.currentTarget.checked)} /> Approved domains only</label>
  <button class="pill sm" aria-expanded={managing} onclick={() => (managing = !managing)}>Approved domains ({store.settings.approvedAttachmentDomains.length})</button>
</div>
{#if managing}
  <div class="domains">
    <p>Only exact sender domains match. Add subdomains separately. This filter uses the sender address; it does not verify who sent the email. Files and links share this list.</p>
    <form onsubmit={addDomain}>
      <input aria-label="Domain to approve" placeholder="example.org" bind:value={domainInput} aria-invalid={!!domainError} aria-describedby={domainError ? "domain-error" : undefined} />
      <button class="pill sm" type="submit">Add domain</button>
    </form>
    {#if domainError}<p class="error" id="domain-error" role="alert">{domainError}</p>{/if}
    <ul class="domain-list" aria-label="Approved sender domains">
      {#each store.settings.approvedAttachmentDomains as domain (domain)}
        <li><span>{domain}</span><button class="icon-btn sm" aria-label="Remove {domain}" onclick={() => removeDomain(domain)}><Icon name="x" size={14} /></button></li>
      {/each}
    </ul>
  </div>
{/if}

<style>
  .filter-row { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin: 14px 0 10px; justify-content: space-between; }
  .approved { display: flex; align-items: center; gap: 7px; font-size: 13px; }
  input[type=checkbox] { accent-color: var(--accent); }
  .domains { padding: 12px; margin-bottom: 10px; border: 1px solid var(--sep); background: var(--surface-2); border-radius: 10px; }
  .domains p { margin: 0 0 10px; color: var(--text-2); font-size: 12px; line-height: 1.5; }
  .domains form { display: flex; gap: 8px; }
  .domains form input { min-width: 0; width: 100%; color: var(--text); font: inherit; background: var(--surface); padding: 6px 10px; border: 1px solid var(--sep-strong); border-radius: 6px; }
  .domain-list { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; margin: 10px 0 0; padding: 0; }
  .domain-list li { display: flex; align-items: center; padding-left: 8px; background: var(--chip); border-radius: 7px; font-size: 12px; }
  .domains .error { color: var(--danger); margin: 8px 0; }
</style>
