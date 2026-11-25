const pause = () => new Promise(r => setTimeout(r, 100));
const wait = async (predicate, label, timeout = 20000) => {
  await pause();
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`); await pause(); }
};
const inbox = document.querySelector('[data-mailbox="inbox"]');
const accounts = [...inbox.querySelectorAll('.account-item')];
if (accounts.length < 2) throw new Error('Two inbox fixture accounts required');
const compact = {
  mailboxLabels: [...document.querySelectorAll('.sidebar .parent .label')].map(n => n.textContent),
  accountRows: accounts.length,
  // No arrows: Inbox always lists its accounts, other mailboxes only while open.
  arrows: document.querySelectorAll('.sidebar .disclosure, .sidebar .chev').length,
  otherOpenGroups: document.querySelectorAll('.sidebar .mailbox-group:not([data-mailbox="inbox"]) .children').length,
};
accounts[0].click();
await wait(() => !document.querySelector('.mini-spin') && !!document.querySelector('.bucket-toggle'), 'first account inbox');
if(!document.querySelector('.row')) { document.querySelector('.bucket-toggle').click(); await pause(); }
// Mail that arrived today (earlier tests) can leave only a short, unscrollable Today group open.
for (const toggle of document.querySelectorAll('.bucket-toggle[aria-expanded="false"]')) {
  const v = document.querySelector('.viewport'); if (v.scrollHeight - v.clientHeight > 600) break;
  toggle.click(); await pause();
}
const total = document.querySelector('.list-head .n').textContent;
const viewport = document.querySelector('.viewport');
viewport.scrollTop = 430;
viewport.dispatchEvent(new Event('scroll'));
await pause();
accounts[1].click();
await wait(() => !document.querySelector('.mini-spin') && !!document.querySelector('.bucket-toggle'), 'second account inbox');
if(!document.querySelector('.row')) { document.querySelector('.bucket-toggle').click(); await pause(); }
const original = messenger.messages.list;
let calls = 0;
let release;
const gate = new Promise(resolve => release = resolve);
let beforeRefresh;
let automaticRefreshCalls=0;
try {
  Object.defineProperty(messenger.messages, 'list', { configurable: true, value: async (...args) => { calls++; await gate; return original(...args); } });
  accounts[0].click();
  await pause();
  automaticRefreshCalls=calls; // Native background changes may legitimately invalidate a snapshot.
  const restored = document.querySelector('.viewport').scrollTop;
  if (Math.abs(restored - 430) > 1) throw new Error(`Scroll was not restored: ${restored}`);
  const totalBeforeRefresh = document.querySelector('.list-head .n').textContent;
  if (!calls) document.querySelector('.list-head button[aria-label="Refresh"]').click();
  await pause();
  beforeRefresh = { total: document.querySelector('.list-head .n').textContent, rows: document.querySelectorAll('.row').length, status: document.querySelector('.load-status')?.textContent, scroll: restored };
  if (beforeRefresh.total !== totalBeforeRefresh || !beforeRefresh.rows || beforeRefresh.status !== 'Refreshing…') throw new Error('Cached list changed during refresh: ' + JSON.stringify({ initialTotal: total, totalBeforeRefresh, beforeRefresh }));
  release();
  await wait(() => !document.querySelector('.mini-spin'), 'manual refresh');
} finally {
  release();
  Object.defineProperty(messenger.messages, 'list', { configurable: true, writable: true, value: original }); // Restore the resolved function: re-installing the original lazy getter breaks the API in this page.
}
// Opening Sent lists its accounts under it; leaving it folds them away.
const sent = document.querySelector('[data-mailbox="sent"]');
const sentBefore = sent.querySelectorAll('.account-item').length;
sent.querySelector('.parent').click();
await wait(() => !document.querySelector('.mini-spin'), 'all-account sent');
const sentAccounts = sent.querySelectorAll('.account-item').length;
const sentTitle = document.querySelector('.list-head h1').textContent;
// One account with a Sent folder lists none (its row would repeat the mailbox); two or more list each.
if (sentTitle !== 'Sent' || sentBefore || sentAccounts === 1 || compact.arrows || compact.otherOpenGroups) throw new Error('Grouped Sent mailbox navigation failed: ' + JSON.stringify({ sentTitle, sentBefore, sentAccounts, compact }));
inbox.querySelectorAll('.account-item')[0].click();
await pause();
const sentFolded = sent.querySelectorAll('.account-item').length === 0;
if (!sentFolded) throw new Error('Sent accounts stayed open after leaving Sent');
return { compact, cacheReturnBackendCalls: automaticRefreshCalls, beforeRefresh, sentAccounts, sentTitle, sentFolded, viewport: innerWidth, contentWidth: document.documentElement.scrollWidth };
