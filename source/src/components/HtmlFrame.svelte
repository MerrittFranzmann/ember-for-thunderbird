<script lang="ts">
  // Renders untrusted email HTML in one frame sized to its content.
  //  - sandbox has no allow-scripts, so nothing in the email executes (and the
  //    extension CSP plus the srcdoc CSP apply as well). allow-same-origin only
  //    lets this component read the frame's height and patch inline images; popups
  //    are allowed so links open outside.
  //  - The height follows the live document (ResizeObserver), so text appears at
  //    full size as soon as it is parsed instead of after every remote image loads.
  //  - Inline (cid:) images are set on the live document; resolving them never
  //    rebuilds or reloads the frame.
  //  - In dark mode the email follows Ember's rules (email-dark.ts): designed dark
  //    emails get a dark canvas, "paper" emails stay white, the rest are recoloured.
  import { perf } from "../lib/perf-recorder";
  import { adaptToDark, nativeDarkCss, parseColor, type DarkStyle, type RGB } from "../lib/email-dark";
  import { bodyMenuItems, imageFileName, mailtoAddress, type BodyAction } from "../lib/context-menu";
  import { api } from "../lib/api";
  import { store } from "../lib/store.svelte";
  import { composer } from "../lib/compose.svelte";
  import ContextMenu, { type MenuItem } from "./ContextMenu.svelte";
  let { srcdoc, title = "Message body", cid, dark = false, darkStyle = "paper" }: { srcdoc: string; title?: string; cid?: Map<string, string>; dark?: boolean; darkStyle?: DarkStyle } = $props();
  // On a dark canvas the paper card disappears and the email sits on the message card.
  const onCanvas = $derived(dark && darkStyle !== "paper");

  const MAX_HEIGHT = 60000;
  // Emails that size html/body to the viewport would otherwise grow with the frame.
  const FIT_CSS = ":root:root,:root:root>body{height:auto!important;min-height:0!important;}";

  let frame: HTMLIFrameElement | undefined = $state();
  let height = $state(120);
  let doc = $state.raw<Document | null>(null);

  let observer: ResizeObserver | undefined;
  let parsed: ((extra?: Record<string, unknown>) => void) | undefined;
  let sized: ((extra?: Record<string, unknown>) => void) | undefined;
  let loaded: ((extra?: Record<string, unknown>) => void) | undefined;
  let lastGrowth = 0;
  let growthRun = 0;
  let resizedAt = 0;

  function measure() {
    const root = doc?.documentElement;
    if (!root) return;
    // The root's scrollHeight never drops below the frame's own height, so use
    // the content boxes (html is height:auto via FIT_CSS) plus body overflow.
    const body = doc!.body;
    // scrollHeight is in the email's own (unzoomed) pixels; rects are already zoomed (see fit()).
    const zoom = parseFloat(root.style.zoom) || 1;
    const content = Math.max(root.getBoundingClientRect().height, body ? body.getBoundingClientRect().top + body.scrollHeight * zoom : 0);
    const next = Math.min(Math.ceil(content) + 2, MAX_HEIGHT);
    if (next === height) return;
    if (next > height) {
      // Content that tracks the viewport (100vh blocks) grows by the same step after each of our resizes.
      const growth = next - height;
      growthRun = growth === lastGrowth && performance.now() - resizedAt < 100 ? growthRun + 1 : 0;
      lastGrowth = growth;
      if (growthRun >= 4) return;
    }
    resizedAt = performance.now();
    height = next;
    sized?.({ px: next }); sized = undefined;
  }

  /** Emails laid out wider than the card (fixed 600–1200 px tables) shrink to fit, like Spark and
   *  Apple Mail, instead of being cut off behind a hidden sideways scrollbar. Run on load, when images
   *  finish and when the card width changes; never from measure(), so zooming can't feed back into it. */
  let fitWidth = 0;
  function fit() {
    const d = doc, root = d?.documentElement;
    clipped = false; // re-measured below (a reused frame mustn't keep the previous email's fade)
    if (!root || !d.body || !frame) return;
    const available = frame.clientWidth;
    if (!available) return;
    fitWidth = available;
    root.style.removeProperty("zoom");
    let zoom = 1;
    // Zooming changes the width the email lays out in (tables can re-flow), so correct up to twice.
    // Widest top-level element's right edge: rects are in on-screen (zoomed) pixels at any zoom.
    const right = () => Math.max(0, ...Array.from(d.body.children, (el) => el.getBoundingClientRect().right));
    for (let pass = 0; pass < 3 && zoom > 0.5; pass++) {
      // First pass at 100%: scrollWidth also sees wide content inside a full-width wrapper.
      const width = pass === 0 ? Math.max(right(), root.scrollWidth, d.body.scrollWidth) : right();
      if (width <= available + 1) break;
      zoom = Math.max(0.5, zoom * (available - 2) / width);
      root.style.setProperty("zoom", String(zoom));
    }
    measure();
    updateClipped();
  }

  // Wider than the card even at the smallest zoom: the rest scrolls sideways, but macOS hides the
  // scrollbar, so a fade on the right edge shows there's more (until scrolled to the end).
  let clipped = $state(false);
  function updateClipped() {
    const se = doc?.scrollingElement;
    clipped = !!se && se.scrollWidth - se.clientWidth - se.scrollLeft > 4;
  }

  function applyInlineImages(d: Document, map: Map<string, string> | undefined) {
    if (!map?.size) return;
    for (const el of Array.from(d.querySelectorAll<HTMLElement>("[data-cid-src],[data-cid-background],[data-cid-poster]"))) {
      for (const attr of ["src", "background", "poster"]) {
        const id = el.getAttribute(`data-cid-${attr}`);
        const url = id === null ? undefined : map.get(id) || map.get(safeDecode(id));
        if (url) { el.setAttribute(attr, url); el.removeAttribute(`data-cid-${attr}`); }
      }
    }
  }

  /** The message card's colour, so recoloured mail blends into it (Ember uses its own dark surface). */
  function canvasColor(): RGB {
    const card = frame?.closest(".msg, .history-panel, .quoted") || frame?.parentElement;
    const c = card ? parseColor(getComputedStyle(card).backgroundColor) : null;
    return c && c.a > 0 ? c : { r: 31, g: 33, b: 36 };
  }

  function applyDark(d: Document) {
    const canvas = canvasColor();
    if (darkStyle === "native") {
      // After Ember's base sheet (the first <style>) but before the email's own styles.
      const style = d.createElement("style");
      style.textContent = nativeDarkCss(canvas);
      const base = d.head?.querySelector("style");
      if (base) base.after(style); else d.head?.prepend(style);
    } else {
      const end = perf.span("frame.dark-adapt");
      const changed = adaptToDark(d, canvas);
      end({ changed, nodes: d.getElementsByTagName("*").length });
    }
  }

  function safeDecode(value: string) {
    try { return decodeURIComponent(value); } catch { return value; }
  }

  // Attach to each new srcdoc document as soon as it exists (before its subresources load).
  function attach() {
    const d = frame?.contentDocument;
    if (!d || d === doc || d.URL !== "about:srcdoc" || !d.documentElement) return false;
    observer?.disconnect();
    doc = d;
    parsed?.({ nodes: d.getElementsByTagName("*").length, images: d.images.length }); parsed = undefined;
    growthRun = 0; lastGrowth = 0;
    d.addEventListener("scroll", updateClipped, { passive: true });
    // Right-click in the email: Ember's menu (never Thunderbird's). A click in the email closes it.
    d.addEventListener("contextmenu", (e) => openBodyMenu(e, d));
    d.addEventListener("pointerdown", () => { menu = null; });
    const style = d.createElement("style");
    style.textContent = FIT_CSS;
    (d.body || d.documentElement).append(style);
    applyInlineImages(d, cid);
    // A white sheet inside a dark card needs inner margins; elsewhere text aligns with the card.
    if (dark && !onCanvas) {
      const inset = d.createElement("style");
      inset.textContent = "body{padding:16px 18px;}";
      const base = d.head?.querySelector("style");
      if (base) base.after(inset); else d.head?.prepend(inset);
    }
    if (onCanvas) {
      const apply = () => applyDark(d);
      if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", apply, { once: true }); else apply();
    }
    observer = new ResizeObserver(measure);
    observer.observe(d.documentElement);
    if (d.body) observer.observe(d.body);
    if (d.readyState === "loading") d.addEventListener("DOMContentLoaded", fit, { once: true }); else fit();
    return true;
  }

  $effect(() => {
    const kb = Math.round(srcdoc.length / 1024);
    const element = frame;
    if (!element) return;
    parsed = perf.span("frame.parse", { kb }); sized = perf.span("frame.first-size", { kb }); loaded = perf.span("frame.all-loaded", { kb });
    let raf = 0, frames = 0;
    // The srcdoc document usually exists within a frame or two; load also attaches.
    const poll = () => { if (!attach() && ++frames < 120) raf = requestAnimationFrame(poll); };
    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  });

  $effect(() => {
    const d = doc, map = cid;
    if (d) applyInlineImages(d, map);
  });

  $effect(() => () => observer?.disconnect());

  // The card got narrower or wider (window resize, reader layout change): fit again.
  $effect(() => {
    const element = frame;
    if (!element) return;
    const widthObserver = new ResizeObserver(() => { if (doc && element.clientWidth !== fitWidth) fit(); });
    widthObserver.observe(element);
    return () => widthObserver.disconnect();
  });

  // ===== the email's right-click menu (context-menu.ts) =====
  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  function openBodyMenu(e: MouseEvent, d: Document) {
    e.preventDefault();
    const target = e.target as Node | null;
    const el = (target?.nodeType === 3 ? target.parentElement : target) as Element | null;
    const link = el?.closest?.("a[href]") as HTMLAnchorElement | null;
    const img = el?.closest?.("img") as HTMLImageElement | null;
    const selection = d.getSelection()?.toString() || "";
    const found = bodyMenuItems({ selection, href: link?.href, image: img ? img.currentSrc || img.src : undefined });
    if (!found.length || !frame) { menu = null; return; }
    // The frame's own viewport maps one to one onto its box in the page.
    const box = frame.getBoundingClientRect();
    menu = { x: box.left + e.clientX, y: box.top + e.clientY, items: found.map((item) => ({ label: item.label, icon: item.icon, run: () => bodyAction(item.action, { selection, link, img }) })) };
  }
  async function bodyAction(action: BodyAction, { selection, link, img }: { selection: string; link: HTMLAnchorElement | null; img: HTMLImageElement | null }) {
    const copy = async (text: string, what: string) => { await navigator.clipboard.writeText(text); store.toast({ text: `${what} copied`, kind: "success" }); };
    try {
      const href = link?.href || "";
      if (action === "copy") await copy(selection, "Text");
      else if (action === "search") { const q = selection.replace(/\s+/g, " ").trim(); store.searchText = q; await store.searchMail(q); }
      else if (action === "open-link") await api.windows.openDefaultBrowser(href);
      else if (action === "copy-link") await copy(href, "Link");
      else if (action === "write-to") {
        const email = mailtoAddress(href);
        const name = (link?.textContent || "").trim();
        composer.openNew([{ name: name && name !== email && !name.includes("@") ? name : "", email }]);
      }
      else if (action === "copy-address") await copy(mailtoAddress(href), "Email address");
      else if (action === "copy-image" && img) await copyImage(img);
      else if (action === "save-image" && img) await saveImage(img.currentSrc || img.src);
    } catch (error: any) {
      store.toast({ text: `Couldn't do that: ${error?.message || error}`, kind: "error" });
    }
  }
  async function copyImage(img: HTMLImageElement) {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    canvas.getContext("2d")!.drawImage(img, 0, 0);
    let png: Blob | null;
    try { png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png")); }
    catch { throw new Error("this image comes from another site, so it can only be saved"); }
    if (!png) throw new Error("the image isn't loaded");
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
    store.toast({ text: "Image copied", kind: "success" });
  }
  async function saveImage(src: string) {
    let url = src, filename = imageFileName(src);
    // Inline images (blob:, data:) are saved from their bytes, with an extension that fits their type.
    if (!/^https?:/i.test(src)) {
      const blob = await (await fetch(src)).blob();
      url = URL.createObjectURL(blob);
      filename = `image.${(blob.type.split("/")[1] || "png").replace("jpeg", "jpg").replace(/\+.*$/, "")}`;
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
    await api.downloads.download({ url, filename, saveAs: true });
  }

  function onLoad() {
    attach();
    fit();
    loaded?.({ images: doc?.images.length }); loaded = undefined;
  }
</script>

<div class="paper" class:on-canvas={onCanvas}>
  <iframe
    class="display"
    bind:this={frame}
    {title}
    {srcdoc}
    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    referrerpolicy="no-referrer"
    style="height:{height}px; color-scheme:{dark ? 'dark' : 'light'}"
    onload={onLoad}></iframe>
  {#if clipped}<div class="more-right" aria-hidden="true"></div>{/if}
</div>
{#if menu}<ContextMenu x={menu.x} y={menu.y} items={menu.items} label="Email actions" onclose={() => (menu = null)} />{/if}

<style>
  .paper {
    position: relative;
    background: var(--paper);
    border-radius: 10px;
    border: 1px solid var(--paper-border);
    overflow: hidden;
  }
  .paper.on-canvas {
    background: transparent;
    border-color: transparent;
    border-radius: 0;
  }
  .more-right {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 56px;
    pointer-events: none;
    /* The email fades into what it sits on: the white sheet, or the card when it's shown on the card. */
    background: linear-gradient(to right, transparent, var(--paper) 85%);
  }
  .on-canvas .more-right {
    background: linear-gradient(to right, transparent, var(--card) 85%);
  }
  iframe {
    border: 0;
    display: block;
    width: 100%;
    background: #fff;
  }
  .on-canvas iframe {
    background: transparent;
  }
  .display:focus-visible {
    box-shadow: var(--focus);
  }
</style>
