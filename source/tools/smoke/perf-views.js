// View switching (perf suite): click a sidebar mailbox or inbox tab, time until the list shows that view
// and has stopped loading, plus the longest main-thread frame during each switch. Two passes; the
// second is mostly served from the view cache.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const sidebar = (label) => [...document.querySelectorAll('.sidebar .item')].find((b) => b.querySelector('.label')?.textContent.trim() === label);
const tab = (label) => [...document.querySelectorAll('.category-filter')].find((b) => b.textContent.trim() === label);
const steps = [
  ['Smart Inbox', () => sidebar('Inbox')],
  ['People', () => tab('People')],
  ['Notifications', () => tab('Notifications')],
  ['Newsletters', () => tab('Newsletters')],
  ['Pinned', () => tab('Pinned')],
  ['Sent', () => sidebar('Sent')],
  ['Archive', () => sidebar('Archive')],
  ['Smart Inbox', () => sidebar('Inbox')],
];
document.querySelector('button[aria-label="Close conversation"]')?.click();
sidebar('Inbox')?.click();
await pause(1500);
const out = [];
for (let pass = 0; pass < 2; pass++) {
  for (const [name, target] of steps) {
    const el = target();
    if (!el) { out.push({ pass, name, missing: true }); continue; }
    const gaps = []; let last = performance.now(), run = true;
    const loop = (n) => { gaps.push(n - last); last = n; if (run) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    const before = document.querySelector('.list-head h1')?.textContent;
    const t0 = performance.now();
    el.click();
    let titled = 0;
    for (let i = 0; i < 2000; i++) {
      const title = document.querySelector('.list-head h1')?.textContent;
      if (!titled && title !== before) titled = performance.now() - t0;
      if ((titled || title === before) && !document.querySelector('.list-head .mini-spin') && document.querySelector('.row, .empty, .list-empty')) break;
      await pause(4);
    }
    const ms = performance.now() - t0;
    run = false;
    await pause(60);
    out.push({ pass, name, ms: Math.round(ms), rows: document.querySelectorAll('.row').length, maxFrame: Math.round(Math.max(0, ...gaps)) });
    await pause(250);
  }
}
const sorted = (xs) => xs.slice().sort((a, b) => a - b);
const first = out.filter((r) => r.pass === 0 && r.ms), second = out.filter((r) => r.pass === 1 && r.ms);
const p = (xs, q) => sorted(xs)[Math.min(xs.length - 1, Math.floor(xs.length * q))];
return {
  firstPassMedian: p(first.map((r) => r.ms), 0.5), firstPassMax: p(first.map((r) => r.ms), 1),
  cachedMedian: p(second.map((r) => r.ms), 0.5), cachedMax: p(second.map((r) => r.ms), 1),
  worstFrame: Math.max(...out.map((r) => r.maxFrame || 0)),
  steps: out,
};
