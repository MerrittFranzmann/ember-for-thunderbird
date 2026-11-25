// Cost of re-listing the Smart Inbox from Thunderbird (what happens when a cached inbox view is older
// than a minute): wall time, Thunderbird list calls, long frames and timer stalls while it runs.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const calls = { list: 0, continueList: 0, query: 0 }; const originals = {};
for (const name of Object.keys(calls)) { originals[name] = messenger.messages[name]; Object.defineProperty(messenger.messages, name, { configurable: true, writable: true, value: (...a) => { calls[name]++; return originals[name].apply(messenger.messages, a); } }); }
const gaps = []; let last = performance.now(), run = true; const loop = (n) => { gaps.push(n - last); last = n; if (run) requestAnimationFrame(loop); }; requestAnimationFrame(loop);
let drift = 0, tick = performance.now(); const timer = setInterval(() => { const n = performance.now(); drift = Math.max(drift, n - tick - 10); tick = n; }, 10);
try {
  [...document.querySelectorAll('.sidebar .item')].find((b) => b.querySelector('.label')?.textContent.trim() === 'Inbox').click();
  await pause(800);
  const t0 = performance.now();
  document.querySelector('.list-head button[aria-label="Refresh"]').click();
  await pause(50);
  for (let i = 0; i < 600 && document.querySelector('.list-head .mini-spin'); i++) await pause(20);
  const ms = Math.round(performance.now() - t0);
  run = false; clearInterval(timer);
  return { relistMs: ms, calls, longFrames: gaps.filter((g) => g > 50).length, maxFrame: Math.round(Math.max(...gaps)), maxTimerStall: Math.round(drift), rows: document.querySelectorAll('.row').length };
} finally { for (const [n, f] of Object.entries(originals)) Object.defineProperty(messenger.messages, n, { configurable: true, writable: true, value: f }); run = false; clearInterval(timer); }
