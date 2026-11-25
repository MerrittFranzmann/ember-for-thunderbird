// Counts reader/list recomputation while a message is open (needs a build with __sparkPerf counters).
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const page = window;
const take = () => { const list = Array.from(page.__sparkPerf || []).map((e) => Array.from(e)); page.__sparkPerf = []; const out = {}; for (const [name, ms] of list) { const o = (out[name] ||= { n: 0, ms: 0, max: 0 }); o.n++; o.ms = Math.round((o.ms + ms) * 10) / 10; o.max = Math.max(o.max, Math.round(ms * 10) / 10); } return out; };
const subject = (globalThis.__probeConfig || {}).subject || 'Perf newsletter 01';
const input = (window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })), await new Promise((r) => setTimeout(r, 200)), document.querySelector('input[aria-label="Search mail (press / )"]'));
input.value = subject; input.dispatchEvent(new Event('input', { bubbles: true })); input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
for (let i = 0; i < 500 && ![...document.querySelectorAll('.row .subject')].some((n) => n.textContent === subject); i++) await pause(10);
document.querySelector('button[aria-label="Close conversation"]')?.click(); await pause(500); take();
const out = {};
[...document.querySelectorAll('.row')].find((n) => n.querySelector('.subject')?.textContent === subject).click();
await pause(3000); out.open = take();
document.querySelector('.reader button[aria-label="Mark as unread"]')?.click(); await pause(2000); out.markUnread = take();
document.querySelector('.reader button[aria-label="Mark as read"]')?.click(); await pause(2000); out.markRead = take();
await pause(3000); out.idle3s = take();
return out;
