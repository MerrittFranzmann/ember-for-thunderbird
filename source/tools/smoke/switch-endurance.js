// (A) key-repeat navigation, then (B) a long run of switches, in blocks, to expose lag that grows over time.
const config = globalThis.__probeConfig || {};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
function meter() {
  const gaps = []; let last = performance.now(), running = true, drift = 0, tick = performance.now();
  const loop = (now) => { gaps.push(now - last); last = now; if (running) requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  const timer = setInterval(() => { const now = performance.now(); drift = Math.max(drift, now - tick - 10); tick = now; }, 10);
  return () => { running = false; clearInterval(timer); const s = gaps.slice(1).sort((a, b) => a - b); return { frames: s.length, p95: +(s[Math.floor(s.length * 0.95)] || 0).toFixed(1), max: Math.round(s.at(-1) || 0), over50: s.filter((g) => g > 50).length, maxStallMs: Math.round(drift) }; };
}
const bodyShown = () => { const card = [...document.querySelectorAll('.msg.expanded')].at(-1); const p = card?.querySelector('.paper, .plain'); return !!p && p.getBoundingClientRect().height > 10 && !card.querySelector('.skeleton'); };
async function settle() { const t = performance.now(); while (!bodyShown() && performance.now() - t < 10000) await pause(5); return Math.round(performance.now() - t); }
const out = {};
document.querySelector('button[aria-label="Close conversation"]')?.click(); document.querySelector('.viewport').scrollTop = 0; await pause(800);
if (config.expandAll) for (const b of [...document.querySelectorAll('.bucket-toggle[aria-expanded="false"]')]) { b.click(); await pause(150); }
document.querySelector('.row')?.click(); await pause(800);
// (A) Holding j: key repeat at ~25/s.
let stop = meter();
for (let i = 0; i < (config.repeatSteps || 60); i++) { key('j'); await pause(config.repeatMs || 40); }
const repeatSettle = await settle(); await pause(500);
out.keyRepeat = { ...stop(), settleMs: repeatSettle };
for (let i = 0; i < 60; i++) { key('k'); await pause(15); } await pause(800);
// (B) Long run, per-switch time to a readable body.
const blocks = []; let block = null;
for (let i = 0; i < (config.steps || 80); i++) {
  if (i % 10 === 0) { if (block) blocks.push({ ...block.stop(), ...summarize(block.lat), domNodes: document.getElementsByTagName('*').length, iframes: document.querySelectorAll('iframe').length }); block = { stop: meter(), lat: [] }; }
  const t = performance.now(); key('j');
  await pause(0); const lat = await settle(); block.lat.push(lat);
  await pause(Math.max(0, (config.stepMs || 400) - (performance.now() - t)));
}
blocks.push({ ...block.stop(), ...summarize(block.lat), domNodes: document.getElementsByTagName('*').length, iframes: document.querySelectorAll('iframe').length });
function summarize(l) { const s = l.slice().sort((a, b) => a - b); return { bodyP50: s[Math.floor(s.length / 2)], bodyMax: s.at(-1) }; }
out.blocks = blocks;
return out;
