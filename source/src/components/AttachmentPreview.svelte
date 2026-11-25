<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { api } from "../lib/api";
  import { withDeadline } from "../lib/async";
  import type { ReceivedAttachment } from "../lib/attachments";
  import { previewKind } from "../lib/attachment-library";
  import { openAttachment, saveAttachment } from "../lib/attachment-actions";
  import { fileSize, displayName } from "../lib/format";
  import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from "../lib/pdf-preview";
  import Icon from "./Icon.svelte";
  let { item, onClose, onSource }: { item: ReceivedAttachment; onClose: () => void; onSource?: () => void } = $props();
  const kind = $derived(previewKind(item.attachment));
  let dialog: HTMLDivElement;
  let imageURL = $state("");
  let pdf = $state.raw<PDFDocumentProxy | null>(null);
  let pageNumber = $state(1);
  let zoom = $state(1);
  let width = $state(700);
  let canvas: HTMLCanvasElement | undefined = $state();
  let loading = $state(true);
  let rendering = $state(false);
  let error = $state("");
  let actionError = $state("");
  let loadingTask: PDFDocumentLoadingTask | undefined;
  let renderTask: RenderTask | undefined;
  let previousFocus: HTMLElement | null;
  let request = 0;
  onMount(() => { previousFocus = document.activeElement as HTMLElement; dialog.querySelector<HTMLButtonElement>('button[aria-label="Close attachment preview"]')?.focus(); });
  onDestroy(() => { request++; if (previousFocus?.isConnected) previousFocus.focus(); });
  $effect(() => {
    const selected = item; const type = kind;
    const current = ++request;
    loading = true; error = ""; imageURL = ""; pdf = null; pageNumber = 1; zoom = 1;
    if (selected.attachment.size > 50 * 1024 * 1024) { error = "This file is too large for an in-app preview. Open or save it instead."; loading = false; return; }
    let url = ""; let task: PDFDocumentLoadingTask | undefined;
    void (async () => {
      const file: File = await withDeadline(api.messages.getAttachmentFile(selected.message.id, selected.attachment.partName), 20000, undefined, "Attachment preview");
      if (current !== request) return;
      if (file.size > 50 * 1024 * 1024) throw new Error("Open or save this larger file to view it.");
      if (type === "image") { url = URL.createObjectURL(file); imageURL = url; loading = false; }
      else if (type === "pdf") {
        const { loadPDF } = await import("../lib/pdf-preview");
        if (current !== request) return;
        const data = new Uint8Array(await file.arrayBuffer());
        if (current !== request) return;
        task = loadPDF(data, (path) => api.runtime.getURL(path)); loadingTask = task;
        const document = await withDeadline(task.promise, 20000, undefined, "PDF preview");
        if (current !== request) { await task.destroy(); return; }
        pdf = document; loading = false;
      } else throw new Error("Preview is unavailable for this file type.");
    })().catch((failure) => { if (current === request) { error = failure?.message || "Couldn't display this file."; loading = false; } });
    return () => { request++; renderTask?.cancel(); void task?.destroy().catch(() => {}); if (url) URL.revokeObjectURL(url); };
  });
  $effect(() => {
    const document = pdf; const page = pageNumber; const scale = zoom; const element = canvas; const available = width;
    if (!document || !element) return;
    let cancelled = false; let task: RenderTask | undefined;
    rendering = true;
    void (async () => {
      const pdfPage = await document.getPage(page); if (cancelled) return;
      const natural = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: Math.max(240, Math.min(900, available - 40)) / natural.width * scale });
      const ratio = Math.min(devicePixelRatio || 1, 2, Math.sqrt(16000000 / (viewport.width * viewport.height)));
      element.width = Math.floor(viewport.width * ratio); element.height = Math.floor(viewport.height * ratio);
      element.style.width = `${viewport.width}px`; element.style.height = `${viewport.height}px`;
      task = pdfPage.render({ canvas: element, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] }); renderTask = task;
      await task.promise; if (!cancelled) rendering = false;
    })().catch((failure) => { if (!cancelled && failure?.name !== "RenderingCancelledException") { error = failure?.message || "Couldn't display this page."; rendering = false; } });
    return () => { cancelled = true; task?.cancel(); };
  });
  function keydown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    if (event.key === "Tab") {
      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,select,[tabindex="0"]')];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }
  async function action(save = false) { actionError = ""; try { await (save ? saveAttachment : openAttachment)(item.message.id, item.attachment); } catch (failure: any) { actionError = failure.message || "Couldn't open this file."; } }
</script>

<div class="preview-scrim" role="presentation" onclick={(event) => event.target === event.currentTarget && onClose()}>
  <div class="attachment-preview" bind:this={dialog} role="dialog" aria-modal="true" aria-label="Preview {item.attachment.name}" tabindex="-1" onkeydown={keydown}>
    <header><div><h2>{item.attachment.name}</h2><p>{displayName(item.message.author)} · {fileSize(item.attachment.size)}</p></div><button class="icon-btn" aria-label="Close attachment preview" onclick={onClose}><Icon name="x" /></button></header>
    <div class="preview-toolbar">
      {#if pdf}<button class="pill sm" aria-label="Previous PDF page" disabled={pageNumber <= 1 || rendering} onclick={() => pageNumber--}>Previous</button><span class="page-count" aria-live="polite">Page {pageNumber} of {pdf.numPages}</span><button class="pill sm" aria-label="Next PDF page" disabled={pageNumber >= pdf.numPages || rendering} onclick={() => pageNumber++}>Next</button><button class="pill sm" aria-label="Zoom out" disabled={zoom <= .5} onclick={() => zoom = Math.max(.5, zoom - .25)}>−</button><span>{Math.round(zoom * 100)}%</span><button class="pill sm" aria-label="Zoom in" disabled={zoom >= 2} onclick={() => zoom = Math.min(2, zoom + .25)}>+</button>{/if}
      <span class="grow"></span><button class="pill sm" onclick={() => action()}>Open</button><button class="pill sm" onclick={() => action(true)}>Save</button>{#if onSource}<button class="pill sm" onclick={onSource}>Show email</button>{/if}
    </div>
    {#if actionError}<p class="preview-error" role="alert">{actionError}</p>{/if}
    <div class="preview-content" bind:clientWidth={width} aria-busy={loading || rendering}>
      {#if loading}<p class="preview-status" role="status">Loading preview…</p>{/if}
      {#if error}<p class="preview-error" role="alert">{error}</p>{:else if kind === "pdf"}<canvas bind:this={canvas} aria-label="PDF page {pageNumber}" hidden={!pdf}></canvas>{:else if imageURL}<img class="preview-image" src={imageURL} alt={item.attachment.name} onerror={() => error = "Couldn't display this image. Open or save it instead."} />{/if}
    </div>
  </div>
</div>

<style>
  .preview-scrim { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(20,24,36,.45); }
  .attachment-preview { width: min(1040px,100%); height: min(900px,calc(100vh - 48px)); display: flex; flex-direction: column; border-radius: 15px; overflow: hidden; background: var(--surface); box-shadow: var(--shadow-lg); border: 1px solid var(--sep-strong); }
  header { display: flex; gap: 12px; justify-content: space-between; align-items: center; padding: 14px 18px; }
  header div { min-width: 0; }
  h2 { margin: 0; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  header p { margin: 5px 0 0; font-size: 12px; color: var(--text-2); }
  .preview-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 10px 16px; border-block: 1px solid var(--sep); font-size: 12px; }
  .grow { flex: 1; }
  .preview-content { position: relative; flex: 1; min-height: 0; overflow: auto; background: var(--surface-2); padding: 20px; text-align: center; }
  .preview-content canvas { display: inline-block; background: white; box-shadow: var(--shadow); }
  .preview-content canvas[hidden] { display: none; }
  .preview-image { max-width: 100%; max-height: 100%; object-fit: contain; }
  .preview-error, .preview-status { font-size: 13px; padding: 16px; color: var(--text-2); }
  .preview-error { color: var(--danger); }
  @media(max-width:600px) { .preview-scrim { padding: 8px; } .attachment-preview { height: calc(100vh - 16px); } }
</style>
