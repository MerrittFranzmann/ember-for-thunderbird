// Main-thread frame gaps while scrolling the reader (an open newsletter) and the Smart Inbox list.
// Programmatic rAF-driven scrolling: a proxy for repaint/layout cost, not a hardware display measurement.
const config = globalThis.__probeConfig || {};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function sweep(el, ms = 4000, distance = Infinity) {
  const max = Math.min(distance, el.scrollHeight - el.clientHeight);
  el.scrollTop = 0; await pause(300);
  const gaps = []; let last = performance.now(); const start = last;
  await new Promise((done) => { const step = (now) => { gaps.push(now - last); last = now; const p = Math.min((now - start) / ms, 1); el.scrollTop = Math.round(max * (p < 0.5 ? p * 2 : (1 - p) * 2)); if (p < 1) requestAnimationFrame(step); else done(); }; requestAnimationFrame(step); });
  const s = gaps.slice(1).sort((a, b) => a - b);
  return { distancePx: max, frames: s.length, p50: +s[Math.floor(s.length * 0.5)].toFixed(1), p95: +s[Math.floor(s.length * 0.95)].toFixed(1), max: +s.at(-1).toFixed(1), over33: s.filter((g) => g > 33.4).length, over50: s.filter((g) => g > 50).length };
}
const out = {};
const subject = config.subject || 'Perf newsletter 01';
const input = (window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })), await new Promise((r) => setTimeout(r, 200)), document.querySelector('input[aria-label="Search mail (press / )"]'));
input.value = subject; input.dispatchEvent(new Event('input', { bubbles: true })); input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
for (let i = 0; i < 500 && ![...document.querySelectorAll('.row .subject')].some((n) => n.textContent === subject); i++) await pause(10);
[...document.querySelectorAll('.row')].find((n) => n.querySelector('.subject')?.textContent === subject).click();
await pause(config.settleMs || 5000);
const reader = document.querySelector('.reader .scroll');
out.reader = [await sweep(reader), await sweep(reader)];
// Smart Inbox list.
document.querySelector('button[aria-label="Close conversation"]')?.click();
const smart = [...document.querySelectorAll('nav button, aside button')].find((b) => /^\s*Inbox\b/.test(b.textContent || ''));
smart?.click(); await pause(2500);
for (const b of [...document.querySelectorAll('.bucket-toggle[aria-expanded="false"]')]) { b.click(); await pause(200); }
await pause(1500);
const list = document.querySelector('.viewport');
out.listRows = document.querySelectorAll('.row').length; out.listHeight = list.scrollHeight;
out.list = [await sweep(list, 5000, 7000), await sweep(list, 5000, 7000)];
return out;
