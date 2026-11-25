/* Spam the user teaches (src/lib/spam.ts). Thunderbird's Junk button trains its adaptive (Bayesian) junk filter
 * (nsMsgDBView::SetAsJunkByIndex → nsIJunkMailPlugin.setMessageClassification) and then sets the junk status;
 * messages.update({ junk }) only sets the status, so the filter never learned from Ember. This does both, the same
 * way: the old classification is the user's earlier verdict (junkscoreorigin "user"), so re-marking doesn't count
 * twice and "unknown" takes a verdict back out of the filter. */
"use strict";

/** The filter's classification for a verdict, and the user's earlier one from a header's junk properties. */
function junkClassification(verdict, P) {
  return verdict === "spam" ? P.JUNK : verdict === "good" ? P.GOOD : P.UNCLASSIFIED;
}
function userClassification(origin, score, P) {
  if (origin !== "user") return P.UNCLASSIFIED;
  return score === "100" ? P.JUNK : score === "0" ? P.GOOD : P.UNCLASSIFIED;
}

/** Who the junk status is from: the user's verdict, or ("unknown", a verdict taken back) not the user's, so a later
 *  verdict isn't taken for a change from "good" (which would untrain good mail that was never trained). */
function junkOrigin(verdict) { return verdict === "unknown" ? "plugin" : "user"; }

/** Whether an email's junk mark is the adaptive filter's own guess ("plugin"), not the user's verdict, a message
 *  filter's rule or the server's flag. */
function isFilterGuess(score, origin) { return score === "100" && (origin === "plugin" || origin === ""); }
if (typeof module === "object") module.exports = { junkClassification, userClassification, junkOrigin, isFilterGuess };

var sparkJunk = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
    const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    const P = Ci.nsIJunkMailPlugin;

    /** One email through the filter; resolves when it reports back (or after 10 s: training is local and quick). */
    function train(hdr, from, to) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 10000);
        const listener = { onMessageClassified() { clearTimeout(timer); resolve(true); } };
        try {
          MailServices.junk.setMessageClassification(hdr.folder.getUriForMsg(hdr), from, to, null, listener);
        } catch (error) { clearTimeout(timer); console.error("sparkJunk: training failed", error); resolve(false); }
      });
    }

    return {
      sparkJunk: {
        /** Of these emails, the ones marked junk only by the adaptive filter's guess. */
        async guesses(messageIds) {
          return (messageIds || []).filter((id) => {
            const hdr = context.extension.messageManager.get(id);
            return !!hdr && isFilterGuess(hdr.getStringProperty("junkscore"), hdr.getStringProperty("junkscoreorigin"));
          });
        },
        async classify(messageIds, verdict) {
          const to = junkClassification(verdict, P);
          let trained = 0, missing = 0;
          const byFolder = new Map();
          for (const id of messageIds) {
            const hdr = context.extension.messageManager.get(id);
            if (!hdr || !hdr.folder) { missing++; continue; }
            const from = userClassification(hdr.getStringProperty("junkscoreorigin"), hdr.getStringProperty("junkscore"), P);
            if (from !== to && await train(hdr, from, to)) trained++;
            if (!byFolder.has(hdr.folder)) byFolder.set(hdr.folder, []);
            byFolder.get(hdr.folder).push(hdr);
          }
          // The user's verdict as the email's junk status ("unknown": not junk and not the user's, as before Ember's mark).
          let updated = 0;
          for (const [folder, hdrs] of byFolder) {
            folder.setJunkScoreForMessages(hdrs, verdict === "spam" ? String(P.IS_SPAM_SCORE) : String(P.IS_HAM_SCORE), junkOrigin(verdict), -1);
            updated += hdrs.length;
          }
          return { trained, updated, missing };
        },
      },
    };
  }
};
