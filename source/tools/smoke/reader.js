const wait = async (predicate, label, timeout = 20000) => {
  await new Promise(r => setTimeout(r, 100));
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`);
    await new Promise(r => setTimeout(r, 60));
  }
};
const button = (label) => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === label);
window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })); await new Promise(r => setTimeout(r, 200)); const input = document.querySelector('.search input');
input.value = 'Reading pane layout review'; input.dispatchEvent(new Event('input', { bubbles: true }));
input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
await wait(() => [...document.querySelectorAll('.row .subject')].some(n => n.textContent === 'Reading pane layout review'), 'inbox conversation');
const row = [...document.querySelectorAll('.row')].find(n => n.querySelector('.subject')?.textContent === 'Reading pane layout review');
const inboxCount = Number(row.querySelector('.cnt')?.textContent || 1);
row.click();
await wait(() => document.querySelectorAll('.thread .msg').length === 5 && document.querySelector('.thread')?.getAttribute('aria-busy') === 'false', 'five related messages');
await wait(() => !document.querySelector('.msg.expanded .skeleton'), 'newest body');
const initial = { inboxCount, count: document.querySelectorAll('.thread .msg').length, expanded: document.querySelectorAll('.thread .expanded').length, authors: [...document.querySelectorAll('.msg .name')].map(n => n.textContent), body: document.querySelector('.msg:last-child .body')?.textContent.trim() };
button('Expand all').click();
await wait(() => document.querySelectorAll('.thread .expanded').length === 5, 'expand all');
button('Collapse all').click();
await wait(() => document.querySelectorAll('.thread .expanded').length === 0, 'collapse all');
document.querySelector('.msg:last-child .head').click();
await wait(() => document.querySelectorAll('.thread .expanded').length === 1, 'individual expansion');
document.querySelector('.msg:last-child .reply-bar button[data-action="reply"]').click();
await wait(() => !!document.querySelector('.sheet'), 'reply composer');
if (initial.count !== 5 || initial.authors.join(',') !== 'Ada Lovelace,Me,Ada Lovelace,Me,Ada Lovelace') throw new Error('Incorrect thread ordering');
return { initial, expandedAfterCollapseAndToggle: document.querySelectorAll('.thread .expanded').length, composerText: document.querySelector('.sheet')?.innerText.slice(0,500), replyRecipient: document.querySelector(".sheet .chip")?.textContent || document.querySelector(".sheet")?.innerText.includes("Ada Lovelace") };
