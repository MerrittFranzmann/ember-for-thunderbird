// "Search all mail" uses Thunderbird's own search engine (sparkSearch Experiment): any case, every word,
// results within seconds. Before 0.1.62 it took 30-50 s at 21k emails (four case variants in JavaScript).
const pause = (ms = 100) => new Promise((r) => setTimeout(r, ms));
const out = {};
for (const [query, expect] of [["WEEKLY standup", "Ember calendar: Weekly standup"], ["budget sync", "Ember calendar: Budget sync"]]) {
  document.querySelector('[data-mailbox="inbox"] .item.parent').click(); await pause(1500);
  const input = (window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })), await new Promise((r) => setTimeout(r, 200)), document.querySelector('input[aria-label="Search mail (press / )"]'));
  input.value = query; input.dispatchEvent(new Event('input', { bubbles: true }));
  input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  for (let i = 0; i < 100 && ![...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Search all mail'); i++) await pause();
  await pause(800);
  const started = Date.now();
  [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Search all mail').click();
  await pause(300);
  while (document.querySelector('.load-status') && Date.now() - started < 30000) await pause();
  const ms = Date.now() - started;
  // Older results can sit in collapsed date sections.
  for (let i = 0; i < 6; i++) { const closed = document.querySelector('.bucket-toggle[aria-expanded="false"]'); if (!closed) break; closed.click(); await pause(200); }
  const subjects = [...document.querySelectorAll('.row .subject')].map((n) => n.textContent.trim());
  out[query] = { ms, rows: subjects.length, found: subjects.includes(expect) };
  if (!subjects.includes(expect)) throw String(`"${query}": ${expect} not found (${subjects.slice(0, 5).join("; ")})`);
  if (ms > 15000) throw String(`"${query}" took ${ms} ms`);
}
return out;
