// Page stalls caused by cache maintenance: one snapshot transfer, then a periodic cache pass ("refresh").
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function watch(ms, action) {
  const gaps = []; let last = performance.now(), running = true, drift = 0, tick = performance.now();
  const loop = (now) => { gaps.push(now - last); last = now; if (running) requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  const timer = setInterval(() => { const now = performance.now(); drift = Math.max(drift, now - tick - 10); tick = now; }, 10);
  const started = performance.now(); const value = await action(); const actionMs = Math.round(performance.now() - started);
  await pause(ms); running = false; clearInterval(timer);
  const s = gaps.slice(1).sort((a, b) => a - b);
  return { actionMs, value, frames: s.length, p95: +s[Math.floor(s.length * 0.95)].toFixed(1), max: +s.at(-1).toFixed(1), over33: s.filter((g) => g > 33.4).length, maxStallMs: Math.round(drift) };
}
const out = {};
out.snapshot = await watch(1000, async () => { const r = await messenger.runtime.sendMessage({ type: 'spark:cache', command: 'snapshot' }); return { headers: r.value.headers.length }; });
// What the app does since 0.1.23: 400-header pages, yielding between them.
out.pagedSnapshot = await watch(1000, async () => { let n = 0, page = { next: 0 }; const token = 'probe' + Math.random(); while (page.next !== null) { page = (await messenger.runtime.sendMessage({ type: 'spark:cache', command: 'snapshot', offset: page.next, limit: 400, token })).value; n += page.headers.length; await new Promise((r) => setTimeout(r, 0)); } return { headers: n }; });
out.cachePass = await watch(12000, async () => { const r = await messenger.runtime.sendMessage({ type: 'spark:cache', command: 'refresh' }); return r.value.phase; });
return out;
