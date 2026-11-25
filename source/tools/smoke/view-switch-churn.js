// Counts Thunderbird list aborts and cache register round trips while switching mailboxes.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const counts = { abortList: 0, register: 0, registerHeaders: 0, continueList: 0 };
const m = messenger.messages, rt = messenger.runtime;
const orig = { abortList: m.abortList, continueList: m.continueList, send: rt.sendMessage };
m.abortList = (...a) => { counts.abortList++; return orig.abortList.apply(m, a); };
m.continueList = (...a) => { counts.continueList++; return orig.continueList.apply(m, a); };
rt.sendMessage = (msg, ...rest) => { if (msg?.command === 'register') { counts.register++; counts.registerHeaders += msg.messages?.length || 0; } return orig.send.call(rt, msg, ...rest); };
try {
  const click = (label) => [...document.querySelectorAll('aside button, nav button')].find((b) => b.textContent.trim().startsWith(label))?.click();
  for (const label of ['Sent', 'Inbox', 'Archive', 'Inbox', 'Sent', 'Inbox', 'Archive', 'Inbox']) { click(label); await pause(1800); }
} finally { m.abortList = orig.abortList; m.continueList = orig.continueList; rt.sendMessage = orig.send; }
return counts;
