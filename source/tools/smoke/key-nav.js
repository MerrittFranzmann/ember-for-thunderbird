// J / K navigation at key-repeat speed: handler cost per press, long frames, and how long the reader
// takes to show the selected conversation once keys stop.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const press = (key) => { const t = performance.now(); window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); return performance.now() - t; };
document.querySelector('button[aria-label="Close conversation"]')?.click();
document.activeElement?.blur();
await pause(300);
const gaps = []; let last = performance.now(), stop = false;
const loop = (now) => { const g = now - last; last = now; if (g > 34) gaps.push(Math.round(g)); if (!stop) requestAnimationFrame(loop); };
requestAnimationFrame(loop);
const runs = [];
for (const [interval, count] of [[33, 30], [80, 20], [200, 10]]) {
  gaps.length = 0; const handlers = [];
  for (let i = 0; i < count; i++) { handlers.push(press('j')); await pause(interval); }
  const t0 = performance.now(); const want = document.querySelector('.row.selected .subject, .row[aria-selected="true"] .subject')?.textContent;
  let shownMs = null;
  for (let i = 0; i < 300; i++) { const h = document.querySelector('.thread h1, .reader h1, .thread .subject')?.textContent; if (want && h && h.includes(want.slice(0, 20))) { shownMs = Math.round(performance.now() - t0); break; } await pause(10); }
  handlers.sort((a, b) => a - b);
  runs.push({ interval, presses: count, handlerP50: +handlers[count >> 1].toFixed(1), handlerMax: +handlers[count - 1].toFixed(1), longFrames: gaps.filter((g) => g > 50).length, maxFrame: Math.max(0, ...gaps), readerAfterStopMs: shownMs, want: want?.slice(0, 30) });
  for (let i = 0; i < count; i++) press('k'); await pause(400);
}
stop = true;
return runs;
