// Invitation card states and the Today agenda (fixtures: tools/seed_calendar_fixtures.py).
// Config `step` runs one state and leaves it on screen for a screenshot; "all" runs every step.
// Exchange answers are stubbed in this page only (sparkCalendar.*), then restored; nothing is sent.
const pause = () => new Promise((r) => setTimeout(r, 100));
const wait = async (predicate, label, timeout = 20000) => {
  await pause(); const start = Date.now();
  const holds = () => { try { return predicate(); } catch { return false; } }; // a card can be mid-render
  while (!holds()) { if (Date.now() - start > timeout) throw String(`Timed out: ${label}`); await pause(); }
};
const step = (globalThis.__probeConfig || {}).step || "all";
const card = () => document.querySelector('.msg.expanded .calendar-invitation');
const text = (node) => (node?.innerText || "").replace(/\s+/g, " ").trim();
async function searchOpen(subject) {
  const input = (window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true })), await new Promise((r) => setTimeout(r, 200)), document.querySelector('input[aria-label="Search mail (press / )"]'));
  input.value = subject; input.dispatchEvent(new Event('input', { bubbles: true }));
  input.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  const found = () => [...document.querySelectorAll('.row')].some((r) => r.innerText.includes(subject));
  // Older results sit in collapsed date sections ("This year"): open them until the row shows.
  let widened = false;
  await wait(() => {
    if (document.querySelector('.mini-spin')) return false;
    if (found()) return true;
    const closed = document.querySelector('.bucket-toggle[aria-expanded="false"]');
    if (closed) { closed.click(); return false; }
    // Saved mail may not have indexed a just-seeded email yet: ask Thunderbird, as "Search all mail" does.
    const all = !widened && [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Search all mail');
    if (all && document.body.innerText.includes('No results')) { widened = true; all.click(); }
    return false;
  }, subject, 150000); // Thunderbird's full-text search takes 8-17 s per query on the 21k-email fixture
  [...document.querySelectorAll('.row')].find((r) => r.innerText.includes(subject)).click();
  await wait(() => !!document.querySelector('.msg.expanded .body') && !document.querySelector('.msg.expanded .skeleton'), 'message body');
}
const native = messenger.sparkCalendar;
const originals = Object.fromEntries(["serverResponse", "meetingStatus", "calendarView", "respond", "removeFromCalendar"].map((name) => [name, native[name]]));
const calls = [];
function stubExchange({ answer = "accept", outOfDate = false } = {}) {
  native.serverResponse = async () => true;
  native.meetingStatus = async () => ({ response: answer, outOfDate, onCalendar: true, cancelled: false });
  native.respond = async (id, response, options) => { calls.push({ id, response, options }); return { via: "exchange", sent: options?.send !== false }; };
  native.removeFromCalendar = async (id) => { calls.push({ id, removed: true }); return { removed: true }; };
  native.calendarView = async (start, end) => {
    const from = Date.parse(start), to = Date.parse(end), now = Date.now();
    if (to - from >= 20 * 3600000) { // the agenda's whole day
      const iso = (t) => new Date(t).toISOString();
      return { accounts: 1, errors: [], events: [
        { accountId: "a", id: "now", uid: "N", subject: "Studio 2 Tutorial", start: iso(now - 600000), end: iso(now + 1200000), allDay: false, location: "Microsoft Teams Meeting", freeBusy: "Busy", response: "accept", cancelled: false, body: "Join the meeting now<https://teams.microsoft.com/l/meetup-join/19%3ameeting_now%40thread.v2/0?context=%7b%7d>" },
        { accountId: "a", id: "later", uid: "L", subject: "Roadmap overview", start: iso(now + 3 * 3600000), end: iso(now + 3.5 * 3600000), allDay: false, location: "", freeBusy: "Busy", response: "none", cancelled: false, body: "https://northwind.zoom.us/j/81234567890" },
        { accountId: "a", id: "done", uid: "D", subject: "Earlier today", start: iso(now - 7200000), end: iso(now - 3600000), allDay: false, location: "", freeBusy: "Busy", response: "accept", cancelled: false },
      ] };
    }
    return { accounts: 1, errors: [], events: [
      { accountId: "a", id: "tt", uid: "T", subject: "Weekly sync", start: new Date(from - 900000).toISOString(), end: new Date(from + 900000).toISOString(), allDay: false, location: "", freeBusy: "Busy", response: "accept", cancelled: false },
    ] };
  };
}
function restore() { Object.assign(native, originals); }
const out = {};
// Answers given by earlier runs would hide the buttons this probe checks.
{
  const saved = (await messenger.storage.local.get("rsvpResponses")).rsvpResponses || {};
  for (const key of Object.keys(saved)) if (key.startsWith("spark-cal-")) delete saved[key];
  await messenger.storage.local.set({ rsvpResponses: saved });
}
try {
  if (step === "all" || step === "upcoming") {
    restore();
    await searchOpen('Roadmap review');
    await wait(() => !!card()?.querySelector('.rsvp'), 'upcoming card');
    const join = card().querySelector('a.join');
    out.upcoming = { buttons: [...card().querySelectorAll('.rsvp button')].map((b) => b.textContent.trim()), join: join?.href, joinText: text(join), conflictLine: !!card().querySelector('.conflict, .free'), notify: !!card().querySelector('.notify') };
    if (!out.upcoming.join?.startsWith('https://northwind.zoom.us/j/81234567890')) throw String('Zoom join link missing: ' + out.upcoming.join);
    [...card().querySelectorAll('.rsvp button')].find((b) => b.textContent.includes('Add a note')).click();
    await wait(() => !!card().querySelector('textarea'), 'note box');
    out.upcoming.noteBox = true;
  }
  if (step === "all" || step === "past") {
    await searchOpen('Kickoff (past)');
    await wait(() => !!card()?.querySelector('.state'), 'past card');
    out.past = { state: text(card().querySelector('.state')), buttons: card().querySelectorAll('.rsvp button').length, join: !!card().querySelector('a.join') };
    if (!out.past.state.startsWith('This meeting has passed') || out.past.buttons) throw String('Past meeting still answerable: ' + JSON.stringify(out.past));
  }
  if (step === "all" || step === "stale") {
    await searchOpen('Budget sync');
    const older = [...document.querySelectorAll('.msg:not(.expanded)')].find((m) => m.innerText.includes('Ada'));
    if (older) { older.querySelector('button').click(); await pause(); }
    await wait(() => [...document.querySelectorAll('.msg.expanded .calendar-invitation')].some((c) => c.innerText.includes('updated since')), 'superseded notice');
    const stale = [...document.querySelectorAll('.msg.expanded .calendar-invitation')].find((c) => c.innerText.includes('updated since'));
    out.stale = { notice: text(stale.querySelector('.state')), open: !!stale.querySelector('.actions button'), buttons: stale.querySelectorAll('.rsvp button').length };
  }
  if (step === "all" || step === "weekly") {
    await searchOpen('Weekly standup');
    await wait(() => !!card()?.querySelector('.rsvp'), 'weekly card');
    out.weekly = { next: text([...card().querySelectorAll('dt')].find((d) => d.textContent === 'Next')?.nextElementSibling), join: text(card().querySelector('a.join')) };
    if (!out.weekly.next || !out.weekly.join.includes('Teams')) throw String('Weekly series: ' + JSON.stringify(out.weekly));
  }
  if (step === "all" || step === "cancel") {
    await searchOpen('Design review');
    await wait(() => card()?.innerText.includes('Canceled event'), 'cancel card');
    out.cancel = { label: text(card().querySelector('.label')), remove: !!card().querySelector('.actions button'), rsvp: !!card().querySelector('.rsvp') };
  }
  if (step === "all" || step === "replies") {
    await searchOpen('Ember offsite');
    const row = [...document.querySelectorAll('.row')].find((r) => r.innerText.includes('Ember offsite'));
    out.replies = { subject: text(row.querySelector('.subject')), snippet: text(row.querySelector('.snippet')), count: text(row.querySelector('.cnt')) };
    await wait(() => document.querySelectorAll('.calendar-invitation.compact').length >= 1, 'compact reply card');
    out.replies.lines = [...document.querySelectorAll('.calendar-invitation.compact')].map((c) => text(c));
    if (out.replies.subject !== 'Responses: Ember offsite' || out.replies.snippet !== '2 accepted · 1 declined') throw String('Reply row: ' + JSON.stringify(out.replies));
  }
  if (step === "all" || step === "exchange") {
    stubExchange();
    await searchOpen('Kickoff (past)'); // remount the card under the stub
    await searchOpen('Roadmap review');
    await wait(() => card()?.innerText.includes('You accepted') && !!card().querySelector('.conflict'), 'answered card with conflict');
    out.exchange = { state: text(card().querySelector('.actions .state')), conflict: text(card().querySelector('.conflict')) };
    [...card().querySelectorAll('button')].find((b) => b.textContent.trim() === 'Change').click();
    await wait(() => !!card().querySelector('.rsvp') && !!card().querySelector('.notify'), 'change buttons');
    [...card().querySelectorAll('.rsvp button')].find((b) => b.textContent.includes('Add a note')).click();
    await wait(() => !!card().querySelector('textarea'), 'note box');
    const area = card().querySelector('textarea'); area.value = 'Running 5 min late'; area.dispatchEvent(new Event('input', { bubbles: true }));
    const box = card().querySelector('.notify input'); box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true }));
    out.exchange.notifyLabel = text(card().querySelector('.notify'));
    if (step === "exchange") { out.calls = calls; } // leave the note open for the screenshot
    else {
      [...card().querySelectorAll('.rsvp button')].find((b) => b.textContent.includes('Maybe')).click();
      await wait(() => calls.length > 0 && card().innerText.includes('You said maybe'), 'answered maybe');
      out.exchange.sent = calls[0];
      if (calls[0].response !== 'tentative' || calls[0].options.note !== 'Running 5 min late' || calls[0].options.send !== false) throw String('Exchange respond call: ' + JSON.stringify(calls[0]));
    }
  }
  if (step === "all" || step === "agenda") {
    stubExchange();
    window.dispatchEvent(new CustomEvent("spark:calendar-changed"));
    await wait(() => document.querySelectorAll('.agenda li').length >= 2, 'agenda');
    out.agenda = [...document.querySelectorAll('.agenda li')].map((li) => ({ text: text(li), join: li.querySelector('a.join')?.href || '', soon: !!li.querySelector('a.join.soon') }));
    if (out.agenda.length !== 2 || !out.agenda[0].text.startsWith('Now') || !out.agenda[0].soon || out.agenda[1].soon) throw String('Agenda: ' + JSON.stringify(out.agenda));
  }
  if (step === "cancel-exchange") {
    stubExchange();
    await searchOpen('Kickoff (past)');
    await searchOpen('Design review');
    await wait(() => !!card()?.querySelector('.actions button.primary'), 'remove button');
    out.cancelExchange = text(card().querySelector('.actions'));
  }
} finally {
  if (step === "all") restore();
}
return out;
