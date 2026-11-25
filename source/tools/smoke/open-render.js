// Reader open/render timings on the perf fixtures (tools/seed_perf_fixtures.py).
// Run in the Ember page: spark.py appfile tools/smoke/open-render.js. Times are ms after the row click.
const config = globalThis.__openRenderConfig || {};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (predicate, label, timeout = 20000) => { const start = performance.now(); while (!predicate()) { if (performance.now() - start > timeout) throw new Error(`Timed out: ${label}`); await pause(4); } };
const subjects = config.subjects || ['Perf newsletter 01', 'Perf newsletter 02', 'Perf inline images 01', 'Perf long thread'];
const input = (window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })), await new Promise((r) => setTimeout(r, 200)), document.querySelector('input[aria-label="Search mail (press / )"]'));
const records = [];
for (const subject of subjects) {
  input.value = subject; input.dispatchEvent(new Event('input', { bubbles: true })); input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await wait(() => !document.querySelector('.mini-spin') && [...document.querySelectorAll('.row .subject')].some((n) => n.textContent === subject), subject);
  for (let repeat = 0; repeat < (config.repeats || 2); repeat++) {
    document.querySelector('button[aria-label="Close conversation"]')?.click();
    await pause(300);
    const row = [...document.querySelectorAll('.row')].find((n) => n.querySelector('.subject')?.textContent === subject);
    // Frame gaps and event-loop stalls while the message opens and renders.
    const gaps = []; let last = performance.now(), running = true;
    const loop = (now) => { gaps.push(now - last); last = now; if (running) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    let drift = 0, tick = performance.now();
    const timer = setInterval(() => { const now = performance.now(); drift = Math.max(drift, now - tick - 10); tick = now; }, 10);
    const marks = {}; const heights = [];
    const start = performance.now();
    row.click();
    const card = () => [...document.querySelectorAll('.msg.expanded')].at(-1);
    const paper = () => card()?.querySelector('.paper, .plain');
    try {
      await wait(() => !!card(), 'shell'); marks.shell = performance.now() - start;
      await wait(() => !!paper(), 'body element'); marks.body = performance.now() - start;
      // Track the visible body height until it is stable (default 4 s) (or 12 s pass).
      let stableSince = performance.now(), previous = -1;
      while (performance.now() - start < 12000) {
        const h = Math.round(paper()?.getBoundingClientRect().height || 0);
        if (h !== previous) { heights.push([Math.round(performance.now() - start), h]); previous = h; stableSince = performance.now(); }
        if (performance.now() - stableSince > (config.stableMs || 4000) && h > 0) break;
        await pause(16);
      }
      const final = heights.at(-1)?.[1] || 0; marks.timeline = heights.slice(0, 12);
      marks.finalHeight = final;
      marks.halfHeightAt = heights.find(([, h]) => h >= final * 0.5)?.[0];
      marks.finalHeightAt = heights.at(-1)?.[0];
      marks.heightChanges = heights.length;
      marks.iframes = card()?.querySelectorAll('iframe').length || 0;
      marks.srcdocKB = Math.round([...(card()?.querySelectorAll('iframe') || [])].reduce((n, f) => n + (f.srcdoc?.length || 0), 0) / 1024);
    } finally { running = false; clearInterval(timer); }
    const sorted = gaps.slice(1).sort((a, b) => a - b);
    records.push({ subject, repeat, ...marks, maxFrameMs: Math.round(sorted.at(-1)), framesOver50ms: sorted.filter((g) => g > 50).length, maxStallMs: Math.round(drift), messages: document.querySelectorAll('.thread .msg').length });
  }
}
return { version: messenger.runtime.getManifest().version, records };
