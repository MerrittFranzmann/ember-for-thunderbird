const wait = async (predicate, label, timeout = 20000) => {
  await new Promise(r => setTimeout(r, 100));
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`); await new Promise(r => setTimeout(r, 60)); }
};
const button = label => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === label);
if (document.querySelector('.sheet')) {
  document.querySelector('.sheet button[aria-label="Discard"]').click();
  await new Promise(r => setTimeout(r, 100));
  button('Discard')?.click();
}
[...document.querySelectorAll('.sidebar .item')].find(b => b.querySelector('.label')?.textContent === 'Attachments').click();
await wait(() => document.querySelector('.library') && !document.querySelector('.list-head .mini-spin'), 'attachment scan');
const box = document.querySelector('.approved input');
const original = box.checked;
const savedDomains = (await messenger.storage.local.get('approvedAttachmentDomains')).approvedAttachmentDomains || [];
let testDomain = null;
const toggle = value => { box.checked = value; box.dispatchEvent(new Event('change', { bubbles: true })); };
try {
toggle(false);
await wait(() => !!document.querySelector('.file'), 'all received files');
const total = document.querySelectorAll('.files > .file').length;
const first = document.querySelector('.file');
const filename = first.querySelector('.filename').textContent;
const domain = first.querySelector('.domain').textContent.split(' · ')[0];
testDomain = domain;
const author = first.querySelector('.sender').title;
const query = document.querySelector('input[aria-label="Search attachments"]');
query.value = filename;
query.dispatchEvent(new Event('input', { bubbles: true }));
await wait(() => [...document.querySelectorAll('.filename')].every(n => n.textContent.includes(filename)), 'filename search');
const searched = document.querySelectorAll('.file').length;
query.value = '';
query.dispatchEvent(new Event('input', { bubbles: true }));
await wait(() => document.querySelectorAll('.files > .file').length === total, 'clear search');
// Intercept only external-viewer/download side effects; the Save path still reads the real file.
const originalOpen = messenger.messages.openAttachment;
const originalDownload = messenger.downloads.download;
const openCalls = [];
let download = null;
try {
  Object.defineProperty(messenger.messages, 'openAttachment', { configurable: true, value: async (...args) => { openCalls.push(args); } });
  // Save goes through Thunderbird's download manager (an <a download> click does nothing in Thunderbird).
  Object.defineProperty(messenger.downloads, 'download', { configurable: true, value: async (options) => { download = options; return 1; } });
  first.querySelector('button[title="Open attachment"]').click();
  await wait(() => openCalls.length === 1, 'open API invocation');
  first.querySelector('button[title="Save attachment"]').click();
  await wait(() => !!download, 'save download call');
  if (download.filename !== filename || !download.url.startsWith('blob:') || download.saveAs !== true) throw new Error(`Invalid download: ${JSON.stringify(download)}`);
} finally {
  // Restore the resolved function: re-installing the original lazy getter breaks the API in this page.
  Object.defineProperty(messenger.messages, 'openAttachment', { configurable: true, writable: true, value: originalOpen });
  Object.defineProperty(messenger.downloads, 'download', { configurable: true, writable: true, value: originalDownload });
}
// Verify a real file can be read without launching an external file viewer or saving to disk.
let page = await messenger.messages.query({ attachment: true, author });
const headers = [...page.messages];
while (page.id) { page = await messenger.messages.continueList(page.id); headers.push(...page.messages); }
let downloaded = null;
for (const m of headers) {
  const atts = await messenger.messages.listAttachments(m.id);
  const attachment = atts.find(a => a.name === filename);
  if (attachment) { const file = await messenger.messages.getAttachmentFile(m.id, attachment.partName); downloaded = { name: file.name, size: file.size, type: file.type }; break; }
}
button(`Approved domains (${savedDomains.length})`).click();
await wait(() => !!document.querySelector('input[aria-label="Domain to approve"]'), 'domain editor');
const input = document.querySelector('input[aria-label="Domain to approve"]');
input.value = domain;
input.dispatchEvent(new Event('input', { bubbles: true }));
input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
await wait(() => !!document.querySelector(`button[aria-label="Remove ${domain}"]`), 'save domain');
toggle(true);
await wait(() => [...document.querySelectorAll('.domain')].every(n => [...savedDomains, domain].includes(n.textContent.split(' · ')[0])), 'approved domain filter');
const approved = document.querySelectorAll('.file').length;
const persisted = await messenger.storage.local.get('approvedAttachmentDomains');
const source = document.querySelector('.file .source');
const subject = source.textContent;
source.click();
await wait(() => document.querySelector('.reader .subject')?.textContent === subject, 'source conversation');
document.querySelector('button[aria-label="Close conversation"]').click();
await wait(() => !!document.querySelector('.app.library-wide'), 'return to file library');
return { total, searched, filename, domain, approved, downloaded, persisted: persisted.approvedAttachmentDomains.includes(domain), openCall: openCalls[0], saveFilename: download.filename, sourceConversation: subject };
} finally {
  if (testDomain && !savedDomains.includes(testDomain)) document.querySelector(`button[aria-label="Remove ${testDomain}"]`)?.click();
  const checkbox = document.querySelector('.approved input');
  if (checkbox && checkbox.checked !== original) { checkbox.checked = original; checkbox.dispatchEvent(new Event('change', { bubbles: true })); }
  await new Promise(r => setTimeout(r, 100));
}
