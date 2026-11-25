const pause = () => new Promise(r => setTimeout(r, 100));
const wait = async (predicate, label, timeout = 20000) => {
  await pause(); const start = Date.now();
  while (!predicate()) { if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`); await pause(); }
};
const inboxAccounts = () => [...document.querySelectorAll('[data-mailbox="inbox"] .account-item')];
inboxAccounts()[0].click();
await wait(() => !document.querySelector('.mini-spin') && !!document.querySelector('.category-filter'), 'account categories');
const accountTitle = document.querySelector('.list-head h1').textContent;
const cards = [...document.querySelectorAll('.category-filter')].map(n => n.textContent);
[...document.querySelectorAll('.category-filter')].find(n => n.textContent === 'Notifications').click();
await wait(() => document.querySelector('.list-head h1').textContent.includes('— Work (test)'), 'scoped category');
const categoryTitle = document.querySelector('.list-head h1').textContent;
document.querySelector('button[aria-label="Back to inbox"]').click();
await wait(() => document.querySelector('.list-head h1').textContent === accountTitle, 'back to same inbox');
inboxAccounts()[1].click();
await wait(() => !document.querySelector('.mini-spin') && !!document.querySelector('.category-filter'), 'second account categories');
[...document.querySelectorAll('.category-filter')].find(n => n.textContent === 'Notifications').click();
await wait(() => document.querySelector('.list-head h1').textContent.includes('— Local Folders'), 'second scoped category');
const secondCategoryTitle = document.querySelector('.list-head h1').textContent;

async function searchOpen(subject) {
  const input = (window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })), await new Promise((r) => setTimeout(r, 200)), document.querySelector('input[aria-label="Search mail (press / )"]'));
  input.value = subject; input.dispatchEvent(new Event('input', { bubbles: true }));
  input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await wait(() => !document.querySelector('.mini-spin') && !!document.querySelector('.row'), subject);
  document.querySelector('.row').click();
  await wait(() => !!document.querySelector('.msg.expanded .body') && !document.querySelector('.msg.expanded .skeleton'), 'message body');
}
async function mode(value) {
  document.querySelector('button[aria-label="Settings"]').click(); await pause();
  const select = document.querySelector('#history-mode'); select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
  await pause(); document.querySelector('button[aria-label="Close settings"]').click(); await pause();
}
await searchOpen('Spark smoke quoted history');
await wait(() => document.querySelectorAll('.thread .msg').length === 3 && document.querySelector('.thread').getAttribute('aria-busy') === 'false', 'related history messages');
await mode('jump');
document.querySelector('.msg:last-child .history-link').click();
await wait(() => document.querySelectorAll('.history-highlight').length === 2, 'jump to originals');
const jump = { highlighted: document.querySelectorAll('.history-highlight').length, expanded: document.querySelectorAll('.thread .expanded').length, panelOpen: !!document.querySelector('.history-panel') };
[...document.querySelectorAll('.text-action')].find(n => n.textContent === 'Back to latest reply').click();
await mode('panel');
document.querySelector('.msg:last-child .history-link').click();
await wait(() => !!document.querySelector('.history-panel'), 'history side panel');
const panel = { text: document.querySelector('.history-panel').textContent.includes('I will send the revised deck'), persisted: (await messenger.storage.local.get('quotedHistoryMode')).quotedHistoryMode };
document.querySelector('button[aria-label="Close quoted history"]').click();
await mode('jump');

// Outlook/Exchange invitations carry the calendar inline only (no .ics attachment).
await searchOpen('Spark smoke Outlook invitation');
await wait(() => document.querySelector('.calendar-invitation h3')?.textContent === 'Outlook review smoke test', 'inline invitation card');
const inlineRsvp = [...document.querySelectorAll('.calendar-invitation .rsvp button:not(.ghost)')].map(n => n.textContent.trim());
if (inlineRsvp.join() !== 'Accept,Maybe,Decline') throw new Error('Inline invitation response buttons missing: ' + inlineRsvp.join());

await searchOpen('Spark smoke calendar invitation');
await wait(() => !!document.querySelector('.calendar-invitation h3'), 'invitation card');
const invitation = { title: document.querySelector('.calendar-invitation h3').textContent, text: document.querySelector('.calendar-invitation').innerText };
// Accept / Maybe / Decline are in the card (sending is covered by tools/test_rsvp_flow.py);
// the native view stays one click away.
const rsvp = [...document.querySelectorAll('.calendar-invitation .rsvp button:not(.ghost)')].map(n => n.textContent.trim());
if (rsvp.join() !== 'Accept,Maybe,Decline') throw new Error('Invitation response buttons missing: ' + rsvp.join());
const response = [...document.querySelectorAll('.calendar-invitation button')].find(n => n.textContent.includes('Open in Thunderbird'));
if (!response) throw new Error('Open in Thunderbird action missing');
response.click(); await pause();
return { categories: { accountTitle, cards, categoryTitle, secondCategoryTitle }, jump, panel, invitation, rsvp, inlineRsvp, nativeResponseOpened: true };
