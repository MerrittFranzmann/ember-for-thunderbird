// Save attachment goes through Thunderbird's download manager (downloads.download with the Save dialog).
// Before 0.1.64 it clicked an <a download> link, which does nothing in Thunderbird: no file, no dialog.
// The test can't answer the native Save dialog, so it passes saveAs:false and checks the download finishes
// (set browser.download.dir to a scratch folder first, or files land in ~/Downloads).
const pause = (ms = 100) => new Promise((r) => setTimeout(r, ms));
const wait = async (ok, label) => { const t = Date.now(); while (!(await ok())) { if (Date.now() - t > 15000) throw String(`Timed out: ${label}`); await pause(200); } };
const original = messenger.downloads.download;
const calls = [];
messenger.downloads.download = (options) => { calls.push({ ...options }); return original.call(messenger.downloads, { ...options, saveAs: false, conflictAction: 'uniquify' }); };
try {
  document.querySelector('[data-mailbox="inbox"] .item.parent').click(); await pause(1500);
  const input = (window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })), await new Promise((r) => setTimeout(r, 200)), document.querySelector('input[aria-label="Search mail (press / )"]'));
  input.value = 'twelve attachments'; input.dispatchEvent(new Event('input', { bubbles: true }));
  input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  const row = () => [...document.querySelectorAll('.row')].find((r) => r.querySelector('.subject')?.textContent.trim() === 'Edge: twelve attachments');
  await wait(() => !document.querySelector('.load-status') && !!row(), 'search result');
  await pause(500);
  row().click();
  await wait(() => !!document.querySelector('button[aria-label^="Save "]:not([aria-label*="PDF"])'), 'attachment Save button');
  const started = Date.now();
  document.querySelector('button[aria-label^="Save "]:not([aria-label*="PDF"])').click();
  await wait(() => calls.length > 0, 'downloads.download call');
  let item;
  await wait(async () => { [item] = (await messenger.downloads.search({ startedAfter: new Date(started - 1000).toISOString() })); return item && item.state !== 'in_progress'; }, 'download finished');
  if (calls[0].saveAs !== true) throw String('Save should ask where to save');
  if (item.state !== 'complete') throw String(`Download ${item.state}: ${item.error || ''}`);
  if (!item.filename.endsWith('quarterly-report-section-00-final-version.xlsx')) throw String(`Saved as ${item.filename}`);
  return { filename: item.filename, bytes: item.fileSize, saveAs: calls[0].saveAs };
} finally {
  messenger.downloads.download = original;
  document.querySelector('[data-mailbox="inbox"] .item.parent').click();
}
