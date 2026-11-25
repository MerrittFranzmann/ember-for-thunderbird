// Cost of a read/unread toggle (u) and of the automatic mark-as-read after opening, on the Smart Inbox.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const meter = () => { const gaps = []; let last = performance.now(), run = true; const loop = (n) => { gaps.push(n - last); last = n; if (run) requestAnimationFrame(loop); }; requestAnimationFrame(loop); return () => { run = false; return { maxFrame: Math.round(Math.max(...gaps)), over50: gaps.filter((g) => g > 50).length }; }; };
[...document.querySelectorAll('.sidebar .item')].find((b) => b.querySelector('.label')?.textContent.trim() === 'Inbox').click();
await pause(800);
const rows = () => [...document.querySelectorAll('.row')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
rows()[1].click(); await pause(2500); // includes auto mark-read
const out = {};
let stop = meter(); const t = performance.now();
for (let i = 0; i < 4; i++) { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', bubbles: true, cancelable: true })); await pause(400); }
out.toggles = { ...stop(), ms: Math.round(performance.now() - t) };
stop = meter();
rows()[3].click(); await pause(2500);
out.openAndAutoRead = stop();
return out;
