// Newsletters -> Pinned, ten times: each switch must land on pins quickly and never run Thunderbird's
// folder-wide flagged search once the cache has finished an inventory.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const status = (await messenger.storage.local.get("cacheStatus")).cacheStatus || {};
const original = messenger.messages.query; let flaggedQueries = 0;
messenger.messages.query = function (q, ...rest) { if (q && q.flagged) flaggedQueries++; return original.call(this, q, ...rest); };
const button = (label) => [...document.querySelectorAll(".category-filter")].find((b) => b.textContent.trim() === label);
for (let i = 0; i < 200 && !button("Pinned"); i++) await pause(50);
const runs = [];
try {
  for (let i = 0; i < 10; i++) {
    button("Newsletters").click();
    for (let j = 0; j < 100 && document.querySelector(".list-head h1")?.textContent !== "Newsletters"; j++) await pause(10);
    await pause(150);
    const t0 = performance.now();
    button("Pinned").click();
    let ok = false;
    for (let j = 0; j < 500; j++) {
      const rows = [...document.querySelectorAll(".row")];
      if (document.querySelector(".list-head h1")?.textContent === "Pinned" && button("Pinned").getAttribute("aria-pressed") === "true" && rows.length && rows.every((r) => r.querySelector(".star"))) { ok = true; break; }
      await pause(10);
    }
    runs.push({ ok, ms: Math.round(performance.now() - t0), rows: document.querySelectorAll(".row").length, loading: !!document.querySelector(".mini-spin") });
  }
} finally { messenger.messages.query = original; }
return { cache: { phase: status.phase, lastInventoryAt: !!status.lastInventoryAt, lastCompletedAt: !!status.lastCompletedAt }, flaggedQueries, runs, pass: runs.every((r) => r.ok) };
