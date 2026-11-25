const wait = async (predicate, label, timeout = 20000) => {
  await new Promise(r => setTimeout(r, 100));
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 60)); }
};
async function openSearch(subject) {
  const search = (window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })), await new Promise((r) => setTimeout(r, 200)), document.querySelector('input[aria-label="Search mail (press / )"]'));
  search.value = subject;
  search.dispatchEvent(new Event('input', { bubbles: true }));
  search.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await wait(() => !!document.querySelector('.row'), 'rich mail search');
  document.querySelector('.row').click();
  await wait(() => !!document.querySelector('.msg .display'), 'HTML frame');
  await wait(() => document.querySelector('.msg .display')?.contentDocument?.body?.textContent?.trim(), 'rendered HTML body');
}
await openSearch('New logo lockup (inline image)');
// Inline images are patched into the live document; the frame is never rebuilt for them.
const inlineImage = () => document.querySelector('.msg .display')?.contentDocument?.querySelector('img[src^="data:image/png;base64,"]');
await wait(() => !!inlineImage(), 'inline image after text');
const frame = document.querySelector('.msg .display');
const inline = { cidResolved: !!inlineImage(), framesPerMessage: document.querySelectorAll('.msg.expanded iframe').length, sandbox: frame.getAttribute('sandbox'), height: frame.getBoundingClientRect().height, visibleAttachmentChips: document.querySelectorAll('.msg .att').length };
if (!inline.cidResolved || inline.framesPerMessage !== 1 || inline.visibleAttachmentChips !== 0 || inline.sandbox.includes('allow-scripts')) throw new Error('Inline rendering failed: ' + JSON.stringify(inline));
const found = await messenger.messages.query({ author: 'newsletter@theverge.example' });
if (!found.messages.length) throw new Error('Newsletter fixture missing');
await openSearch(found.messages[0].subject);
async function remotePreference(enabled) {
  document.querySelector('button[aria-label="Settings"]').click();
  await wait(() => !!document.querySelector('.panel'), 'settings');
  const row = [...document.querySelectorAll('.panel label')].find(n => n.textContent.includes('Always load remote images'));
  const box = row.querySelector('input');
  const previous = box.checked;
  box.checked = enabled;
  box.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 100));
  document.querySelector('button[aria-label="Close settings"]').click();
  await new Promise(r => setTimeout(r, 150));
  return previous;
}
const previous = await remotePreference(true);
let remote;
try {
  const allowed = { bar: !!document.querySelector('.remote-bar'), networkImages: document.querySelector('.msg .display').srcdoc.includes('img-src data: https: http:;') };
  if (allowed.bar || !allowed.networkImages) throw new Error('Automatic remote image loading failed: '+JSON.stringify(allowed));
  await remotePreference(false);
  const blocked = { bar: !!document.querySelector('.remote-bar'), blocked: document.querySelector('.msg .display').srcdoc.includes('img-src data:;'), height: document.querySelector('.msg .display').getBoundingClientRect().height };
  if (!blocked.bar || !blocked.blocked || blocked.height < 100) throw new Error('Remote image opt-out failed');
  remote = { allowed, blocked };
} finally { await remotePreference(previous); }
return { inline, remote, viewport: innerWidth, contentWidth: document.documentElement.scrollWidth };
