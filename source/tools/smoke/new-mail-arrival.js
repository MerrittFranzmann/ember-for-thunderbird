// New mail while the Smart Inbox is open: import one message into the first inbox and wait for its row.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
[...document.querySelectorAll('.sidebar .item')].find((b) => b.querySelector('.label')?.textContent.trim() === 'Inbox').click();
document.querySelector('button[aria-label="Close conversation"]')?.click();
await pause(800);
const [inbox] = await messenger.folders.query({ specialUse: ['inbox'] });
const subject = 'Arrival probe ' + Date.now();
const raw = `From: Grace Hopper <grace@navy.test>\r\nTo: merritt@spark.test\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${Date.now()}@arrival.test>\r\n\r\nNew.\r\n`;
const gaps = []; let last = performance.now(), run = true; const loop = (n) => { gaps.push(n - last); last = n; if (run) requestAnimationFrame(loop); }; requestAnimationFrame(loop);
const t0 = performance.now();
await messenger.messages.import(new File([raw], 'arrival.eml', { type: 'message/rfc822' }), inbox.id, { new: true });
let seenAt = null;
for (let i = 0; i < 400 && !seenAt; i++) { if ([...document.querySelectorAll('.row .subject')].some((n) => n.textContent === subject)) seenAt = Math.round(performance.now() - t0); else await pause(10); }
await pause(800); run = false;
return { seenAt, maxFrame: Math.round(Math.max(...gaps)), over50: gaps.filter((g) => g > 50).map(Math.round) };
