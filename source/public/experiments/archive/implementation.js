/* Archive that says what really happened (src/lib/archive-intents.ts). messages.archive resolves "complete" even
 * when Thunderbird's move to the archive folder fails (MessageArchiver only logs "Archive failed to copy"): on
 * Exchange that leaves the email in the Inbox, Ember showed it as archived, and it came back on the next restart.
 * This runs the same archiver, catches each batch's copy result, and then checks every email really left its
 * folder. Test-only pref extensions.spark.archive.testFail (honoured only while Marionette runs): "N" fails the
 * next N archive calls without moving anything (the pref counts down). */
"use strict";

/** Readable text for a failed copy's result (an nsresult). */
function archiveStatusText(status) {
  const code = Number(status) >>> 0;
  const known = {
    0x804b0010: "Thunderbird is offline",
    0x804b000e: "the mail server didn't answer in time",
    0x804b0014: "the connection to the mail server was reset",
    0x804b000d: "the mail server refused the connection",
    0x804b001e: "the mail server couldn't be found",
    0x804b0047: "the connection to the mail server was interrupted",
    0x80004004: "the move was cancelled",
  };
  const text = known[code] || "the mail server didn't accept the move";
  return code ? `${text} (0x${code.toString(16)})` : text;
}

if (typeof module === "object") module.exports = { archiveStatusText };

var sparkArchive = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    const { ExtensionError } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs").ExtensionUtils;
    const { MessageArchiver } = ChromeUtils.importESModule("resource:///modules/MessageArchiver.sys.mjs");
    const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    const ARCHIVE_WAIT_MS = 90000; // a copy that never reports back (Thunderbird's own archive would wait forever)

    /** "N" in the test pref, only while a Marionette test drives Thunderbird: fail this call, count down. */
    function testFailure() {
      const pref = "extensions.spark.archive.testFail";
      const left = Number(Services.prefs.getStringPref(pref, "")) || 0;
      if (!left) return false;
      try {
        if (!Cc["@mozilla.org/remote/marionette;1"]?.getService(Ci.nsIMarionette)?.running) return false;
      } catch { return false; }
      if (left > 1) Services.prefs.setStringPref(pref, String(left - 1)); else Services.prefs.clearUserPref(pref);
      return true;
    }
    /** Still in its folder: the move didn't happen (an IMAP "mark as deleted" copy left behind counts as moved). */
    function stillThere(hdr) {
      try {
        const db = hdr.folder && hdr.folder.msgDatabase;
        if (!db || !db.containsKey(hdr.messageKey)) return false;
        const fresh = db.getMsgHdrForKey(hdr.messageKey);
        return !(fresh.flags & (Ci.nsMsgMessageFlags.Expunged | Ci.nsMsgMessageFlags.IMAPDeleted));
      } catch { return false; }
    }

    return {
      sparkArchive: {
        async archive(messageIds) {
          const failed = [];
          const hdrs = [];
          for (const id of messageIds) {
            const hdr = context.extension.messageManager.get(id);
            if (!hdr || !hdr.folder) failed.push({ id, error: "Thunderbird no longer has this email" });
            // Already in an archive folder: there's nothing to move.
            else if (!hdr.folder.isSpecialFolder(Ci.nsMsgFolderFlags.Archive, true)) hdrs.push({ id, hdr });
          }
          if (!hdrs.length) return { failed };
          if (testFailure()) return { failed: [...failed, ...hdrs.map(({ id }) => ({ id, error: archiveStatusText(0x804b000e) }))] };

          const errors = [];
          let timedOut = false;
          try {
            await new Promise((resolve) => {
              const archiver = new MessageArchiver();
              // MessageArchiver passes itself to the copy service: its own onStopCopy sees each batch's result.
              archiver.onStopCopy = (status) => {
                if (!Components.isSuccessCode(status)) errors.push(status);
                return MessageArchiver.prototype.onStopCopy.call(archiver, status);
              };
              const timer = setTimeout(() => { timedOut = true; resolve(); }, ARCHIVE_WAIT_MS);
              archiver.oncomplete = () => { clearTimeout(timer); resolve(); };
              archiver.archiveMessages(hdrs.map(({ hdr }) => hdr));
            });
          } catch (error) {
            throw new ExtensionError(`Couldn't archive: ${error && error.message || error}`);
          }
          const reason = errors.length ? archiveStatusText(errors[0])
            : timedOut ? "the mail server didn't finish the move in time"
            : "Thunderbird didn't move it";
          for (const { id, hdr } of hdrs) if (stillThere(hdr)) failed.push({ id, error: reason });
          return { failed };
        },
      },
    };
  }
};
