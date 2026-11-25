// Saved-mail search: time from submit to results, and long frames, for a few typical queries.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const input = document.querySelector('input[aria-label^="Search mail"]');
const out = [];
for (const q of ['invoice', 'Ada', 'budget review', 'newsletter', 'zzqq nothing', 'from:grace']) {
  const gaps = []; let last = performance.now(), run = true; const loop = (n) => { gaps.push(n - last); last = n; if (run) requestAnimationFrame(loop); }; requestAnimationFrame(loop);
  const t0 = performance.now();
  input.value = q; input.dispatchEvent(new Event('input', { bubbles: true })); input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await pause(30);
  for (let i = 0; i < 500 && document.querySelector('.list-head .mini-spin'); i++) await pause(5);
  const ms = Math.round(performance.now() - t0); run = false;
  out.push({ q, ms, rows: document.querySelectorAll('.row').length, count: document.querySelector('.list-head .n')?.textContent, maxFrame: Math.round(Math.max(...gaps)) });
  await pause(200);
}
document.querySelector('button[aria-label="Clear search"]')?.click();
return out;
