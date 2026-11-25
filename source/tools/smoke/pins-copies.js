// One pinned email stored in two folders (seed_label_copies.py), as Gmail keeps Inbox/All Mail/Starred copies.
// Before 0.1.64 the copies were two conversations with one key: the keyed list threw and Pins never redrew
// (tab highlighted, title and list stuck on the previous view). Now Pins shows the email once.
const pause = (ms = 100) => new Promise((r) => setTimeout(r, ms));
const wait = async (ok, label) => { const t = Date.now(); while (!ok()) { if (Date.now() - t > 15000) throw String(`Timed out: ${label}`); await pause(); } };
const title = () => document.querySelector('.list-head h1')?.textContent || '';
const copies = () => [...document.querySelectorAll('.row .subject')].filter((n) => n.textContent.trim() === 'Copies: your statement is ready').length;
const out = {};
document.querySelector('[data-mailbox="inbox"] .item.parent').click();
await wait(() => title() === 'Smart Inbox' && !document.querySelector('.mini-spin'), 'smart inbox');
for (const round of [1, 2]) {
  [...document.querySelectorAll('.category-filter')].find((b) => b.textContent === 'Pinned').click();
  await wait(() => title().startsWith('Pinned'), `Pinned tab, round ${round} (title stayed "${title()}")`);
  await pause(300);
  out[`tab${round}`] = { title: title(), copies: copies(), rows: document.querySelectorAll('.row').length };
  if (copies() !== 1) throw String(`Pinned tab shows the email ${copies()} times`);
  [...document.querySelectorAll('.category-filter')].find((b) => b.textContent === 'All').click();
  await wait(() => title() === 'Smart Inbox', 'back to All');
}
document.querySelector('[data-mailbox="pins"] .item.parent').click();
await wait(() => title().startsWith('Pins'), `sidebar Pins (title stayed "${title()}")`);
await pause(300);
out.sidebar = { title: title(), copies: copies() };
if (copies() !== 1) throw String(`Sidebar Pins shows the email ${copies()} times`);
document.querySelector('[data-mailbox="inbox"] .item.parent').click();
await wait(() => title() === 'Smart Inbox', 'smart inbox again');
return out;
