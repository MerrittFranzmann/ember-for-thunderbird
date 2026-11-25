/* Ember search of all mail. The MailExtension messages.query() matches fullText in JavaScript: it
 * rebuilds every message's MIME tree, turns HTML into text and compares case-sensitively, so Ember
 * needed four case variants (~19 s each at 21k emails). Thunderbird's own search engine (the
 * Search Messages dialog: nsIMsgSearchSession, C++) reads the offline stores once, ignores case and
 * takes ~2 s for the same mail. The pure helper at the top is unit-tested (test/search-experiment.test.ts). */
"use strict";

/** Words and "quoted phrases" of a query; each must appear (in the subject, sender, recipients or body). */
function searchWords(query) {
  const text = String(query || "");
  const phrases = [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1].trim()).filter(Boolean);
  const words = text.replace(/"[^"]*"/g, " ").replace(/"/g, " ").split(/\s+/).map((word) => word.trim()).filter(Boolean);
  const seen = new Set();
  return [...phrases, ...words].filter((word) => {
    const key = word.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);
}

if (typeof module === "object") module.exports = { searchWords };

var sparkSearch = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    const { ExtensionError } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs").ExtensionUtils;
    const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
    const Attrib = Ci.nsMsgSearchAttrib, Op = Ci.nsMsgSearchOp;
    let running = null;

    function addTerm(session, attrib, op, set, { and = true, begins = false, ends = false } = {}) {
      const term = session.createTerm();
      term.attrib = attrib;
      term.op = op;
      const value = term.value;
      value.attrib = attrib;
      set(value);
      term.value = value;
      term.booleanAnd = and;
      term.beginsGrouping = begins;
      term.endsGrouping = ends;
      session.appendTerm(term);
    }

    return {
      sparkSearch: {
        async search(query, options) {
          options = options || {}; // an omitted optional argument arrives as null
          const words = searchWords(query);
          if (!words.length) return { messages: [], total: 0, interrupted: false };
          if (running) running.stop(); // a newer search replaces the one in progress
          const session = Cc["@mozilla.org/messenger/searchSession;1"].createInstance(Ci.nsIMsgSearchSession);
          for (const server of MailServices.accounts.allServers) {
            for (const folder of server.rootFolder.descendants) {
              if (folder.noSelect || folder.getFlag(Ci.nsMsgFolderFlags.Virtual) || folder.getFlag(Ci.nsMsgFolderFlags.Junk)) continue;
              session.addScopeTerm(Ci.nsMsgSearchScope.offlineMail, folder);
            }
          }
          // (subject OR sender OR recipients OR body contains word) AND … for every word.
          const fields = [Attrib.Subject, Attrib.Sender, Attrib.ToOrCC, ...(options.headersOnly ? [] : [Attrib.Body])];
          for (const word of words) {
            fields.forEach((attrib, i) => addTerm(session, attrib, Op.Contains, (value) => { value.str = word; },
              { and: i === 0, begins: i === 0, ends: i === fields.length - 1 }));
          }
          const date = (iso) => Date.parse(iso) * 1000; // PRTime
          if (options.before) addTerm(session, Attrib.Date, Op.IsBefore, (value) => { value.date = date(options.before); });
          if (options.after) addTerm(session, Attrib.Date, Op.IsAfter, (value) => { value.date = date(options.after); });

          const hits = [];
          const interrupted = await new Promise((resolve, reject) => {
            let finished = false;
            const finish = (stopped) => { if (!finished) { finished = true; resolve(stopped); } };
            running = { session, stop() { try { session.interruptSearch(); } catch (e) { /* already done */ } finish(true); } };
            session.registerListener({
              onSearchHit(header) { hits.push(header); },
              onSearchDone() { finish(false); },
              onNewSearch() {},
            });
            try { session.search(null); } catch (error) { finished = true; reject(new ExtensionError(`Thunderbird couldn't search: ${error && error.message || error}`)); }
          }).finally(() => { if (running && running.session === session) running = null; });
          if (interrupted) return { messages: [], total: hits.length, interrupted: true };

          // Newest first; Thunderbird's own junk verdicts stay out, as in every Ember view.
          hits.sort((a, b) => b.date - a.date);
          const limit = Math.max(1, Math.min(options.limit || 1000, 5000));
          const threshold = Services.prefs.getIntPref("mail.adaptivefilters.junk_threshold", 90);
          const messages = [];
          for (const header of hits) {
            if ((parseInt(header.getStringProperty("junkscore"), 10) || 0) >= threshold) continue;
            const message = context.extension.messageManager.convert(header);
            if (message) messages.push(message);
            if (messages.length >= limit) break;
          }
          return { messages, total: hits.length, interrupted: false };
        },
        async cancel() {
          if (running) running.stop();
        },
        // messages.query({headerMessageId, folderId}) scans the whole folder in JavaScript (~100 ms at
        // 10k emails); the folder database's Message-ID index answers in microseconds.
        async locate(items) {
          const { getFolder } = ChromeUtils.importESModule("resource:///modules/ExtensionAccounts.sys.mjs");
          const databases = new Map();
          return (items || []).map(({ folderId, headerMessageId }) => {
            try {
              let db = databases.get(folderId);
              if (db === undefined) { db = getFolder(folderId).folder.msgDatabase || null; databases.set(folderId, db); }
              const header = db && db.getMsgHdrForMessageID(headerMessageId);
              return (header && context.extension.messageManager.convert(header)) || null;
            } catch (e) {
              return null; // unknown folder or unreadable database: the caller falls back to a query
            }
          });
        },
      },
    };
  }
};
this.sparkSearch = sparkSearch;
