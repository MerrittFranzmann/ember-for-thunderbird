// Rapid back-to-back selection: click successive rows at a fixed interval, then wait for the last one.
const config = globalThis.__probeConfig || {};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const intervals = config.intervals || [300, 150, 80];
const count = config.count || 12;
const results = [];
const v = document.querySelector('.viewport');
for (const interval of intervals) {
  document.querySelector('button[aria-label="Close conversation"]')?.click();
  v.scrollTop = 0; await pause(1500);
  const gaps = []; let last = performance.now(), running = true, drift = 0, tick = performance.now(), stalls = 0;
  const loop = (now) => { gaps.push(now - last); last = now; if (running) requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  const timer = setInterval(() => { const now = performance.now(); const d = now - tick - 10; if (d > 50) stalls++; drift = Math.max(drift, d); tick = now; }, 10);
  const clickLag = [];
  const start = performance.now();
  for (let i = 0; i < count; i++) {
    const rows = [...document.querySelectorAll('.row')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const row = rows[i % rows.length];
    const t = performance.now(); row.click(); clickLag.push(performance.now() - t);
    await pause(interval);
  }
  const lastClick = performance.now();
  // The final selection is readable when its newest expanded card shows a body.
  let settleMs = null;
  for (let i = 0; i < 1000; i++) {
    const card = [...document.querySelectorAll('.msg.expanded')].at(-1);
    const paper = card?.querySelector('.paper, .plain');
    if (paper && paper.getBoundingClientRect().height > 30 && !card.querySelector('.skeleton')) { settleMs = Math.round(performance.now() - lastClick); break; }
    await pause(10);
  }
  await pause(1500); running = false; clearInterval(timer);
  const s = gaps.slice(1).sort((a, b) => a - b); clickLag.sort((a, b) => a - b);
  results.push({ interval, switches: count, totalMs: Math.round(lastClick - start), settleMs, frames: s.length, p50: +s[Math.floor(s.length * 0.5)].toFixed(1), p95: +s[Math.floor(s.length * 0.95)].toFixed(1), max: Math.round(s.at(-1)), over50: s.filter((g) => g > 50).length, over100: s.filter((g) => g > 100).length, maxStallMs: Math.round(drift), stallsOver50: stalls, clickHandlerMaxMs: Math.round(clickLag.at(-1)), clickHandlerP50Ms: Math.round(clickLag[Math.floor(clickLag.length / 2)]) });
}
document.querySelector('button[aria-label="Close conversation"]')?.click();
return results;
