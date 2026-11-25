// Emails wider than the card shrink to fit (tools/seed_edge_fixtures.py "Edge: fixed 1200px table");
// ordinary newsletters keep 100%. The frame height follows the zoomed content (no gap).
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const open = async (s) => { const i = document.querySelector('input[aria-label^="Search mail"]'); i.value = s; i.dispatchEvent(new Event('input', { bubbles: true })); i.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); for (let n = 0; n < 200 && !document.querySelector('.list-head h1')?.textContent.startsWith('Search'); n++) await pause(20); await pause(600); [...document.querySelectorAll('.row')].find((r) => r.querySelector('.subject')?.textContent.includes(s))?.click(); let f; for (let n = 0; n < 150 && !(f = document.querySelector('.thread .msg.expanded iframe'))?.contentDocument?.querySelector('table, p, div'); n++) await pause(30); await pause(500); return { f, d: f?.contentDocument }; };
const wide = await open('Edge: fixed 1200px');
const table = wide.d.querySelector('table').getBoundingClientRect();
const out = { right: Math.round(table.right), width: wide.f.clientWidth, scrollW: wide.d.documentElement.scrollWidth, zoom: +wide.d.documentElement.style.zoom || 1, fits: table.right <= wide.f.clientWidth + 1 || +wide.d.documentElement.style.zoom === 0.5, gap: Math.round(wide.f.clientHeight - table.bottom) };
const plain = await open('Perf newsletter 01');
out.newsletterZoom = +plain.d.documentElement.style.zoom || 1;
document.querySelector('button[aria-label="Clear search"]')?.click();
out.pass = out.zoom < 1 && out.fits && out.gap < 40 && out.newsletterZoom === 1;
return out;
