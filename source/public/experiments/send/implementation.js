/* Replies without Thunderbird's composer window (src/lib/delivery.ts). messages.sendMessage sends new mail without
 * a window, but can't thread a reply: it refuses In-Reply-To and References. Replies, reply drafts and forwards
 * without attachments went through compose.beginReply/beginForward, whose window showed (and, for an email sent
 * later from the background, popped up over whatever the user was doing). This sends them the way
 * messages.sendMessage does (nsIMsgCompose.sendMsg, no window), with the thread's References (Thunderbird writes
 * In-Reply-To from its last entry), then marks the original as replied or forwarded, as the composer would.
 * Ember's body already holds the quoted email. A forward with attachments still uses the composer, which carries
 * them over. */
"use strict";

/** The References of a reply: the original's own references, then the original (each <id> once). */
function sendReferences(originalReferences, originalMessageId) {
  const ids = [];
  for (const id of [...(originalReferences || []), originalMessageId]) {
    const bare = String(id || "").trim().replace(/^<|>$/g, "");
    if (bare && !ids.includes(`<${bare}>`)) ids.push(`<${bare}>`);
  }
  return ids.join(" ");
}
/** A header's References, as Thunderbird's database keeps them (without brackets). */
function headerReferences(hdr) {
  const ids = [];
  for (let i = 0; i < hdr.numReferences; i++) ids.push(hdr.getStringReference(i));
  return ids;
}

if (typeof module === "object") module.exports = { sendReferences, headerReferences };

var sparkSend = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    const { ExtensionError } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs").ExtensionUtils;
    const { MailServices } = ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");
    Cu.importGlobalProperties(["DOMParser", "IOUtils", "PathUtils"]);

    const header = (id) => {
      const hdr = id === undefined || id === null ? null : context.extension.messageManager.get(id);
      if (!hdr) throw new ExtensionError("The email this answers isn't in Thunderbird any more.");
      return hdr;
    };
    function identityFor(identityId) {
      const identity = identityId ? MailServices.accounts.getIdentity(identityId) : MailServices.accounts.defaultAccount?.defaultIdentity;
      if (!identity) throw new ExtensionError("Ember couldn't find the address to send from.");
      const account = MailServices.accounts.accounts.find((a) => a.identities.some((i) => i.key === identity.key));
      if (!account) throw new ExtensionError("Ember couldn't find the account to send from.");
      return { identity, account };
    }
    /** "Name <address>" entries as one header value (names with commas quoted). */
    function addresses(list) {
      const all = (list || []).flatMap((entry) => MailServices.headerParser.makeFromDisplayAddress(String(entry)));
      return MailServices.headerParser.makeMimeHeader(all);
    }
    /** A file the page gave, written where the composer can read it (removed when Thunderbird quits). */
    async function attachmentFor(item) {
      const file = item.file;
      const path = await IOUtils.createUniqueFile(PathUtils.tempDir, String(item.name || file.name || "attachment").replaceAll(/[/:*?"<>|\\]/g, "_"), 0o600);
      await IOUtils.write(path, new Uint8Array(await file.arrayBuffer()));
      const local = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      local.initWithPath(path);
      Cc["@mozilla.org/uriloader/external-helper-app-service;1"].getService(Ci.nsPIExternalAppLauncher).deleteTemporaryFileOnExit(local);
      const attachment = Cc["@mozilla.org/messengercompose/attachment;1"].createInstance(Ci.nsIMsgAttachment);
      attachment.name = item.name || file.name;
      attachment.size = file.size;
      attachment.url = Services.io.newFileURI(local).spec;
      attachment.contentType = file.type || "";
      attachment.temporary = true;
      return attachment;
    }

    return {
      sparkSend: {
        /** Sends an email that answers (or forwards) another, without a window. Returns { headerMessageId }. */
        async send(details, options) {
          options = options || {};
          const kind = options.kind;
          if (!["reply", "forward", "draft"].includes(kind)) throw new ExtensionError(`Unknown kind: ${kind}`);
          const related = header(options.relatedId);
          if (kind === "forward" && related.flags & Ci.nsMsgMessageFlags.Attachment) throw new ExtensionError("A forward with attachments needs Thunderbird's composer.");
          const { identity, account } = identityFor(details.identityId);

          const msgCompose = Cc["@mozilla.org/messengercompose/compose;1"].createInstance(Ci.nsIMsgCompose);
          const params = Cc["@mozilla.org/messengercompose/composeparams;1"].createInstance(Ci.nsIMsgComposeParams);
          params.type = Ci.nsIMsgCompType.New;
          params.identity = identity;
          params.composeFields = Cc["@mozilla.org/messengercompose/composefields;1"].createInstance(Ci.nsIMsgCompFields);
          msgCompose.initialize(params);
          const fields = msgCompose.compFields;
          fields.from = identity.fullName ? MailServices.headerParser.makeMimeAddress(identity.fullName, identity.email) : identity.email;
          fields.to = addresses(details.to);
          fields.cc = addresses(details.cc);
          fields.bcc = addresses(details.bcc);
          fields.subject = String(details.subject || "").replace(/\s{74,}/g, "    ").trimEnd();
          // In the thread: a reply follows the original; a reply draft keeps the thread it was saved in.
          fields.references = kind === "draft"
            ? sendReferences(headerReferences(related))
            : sendReferences(headerReferences(related), related.messageId);

          fields.body = details.body || "";
          if (details.isPlainText) {
            fields.forcePlainText = true;
            fields.useMultipartAlternative = false;
            fields.deliveryFormat = Ci.nsIMsgCompSendFormat.PlainText;
          } else {
            // As messages.sendMessage decides: plain text when the HTML has nothing text can't say, else both.
            let plain = false;
            try { plain = msgCompose.nodeTreeConvertible(new DOMParser().parseFromString(fields.body, "text/html").documentElement) === Ci.nsIMsgCompConvertible.Plain; } catch {}
            fields.deliveryFormat = Ci.nsIMsgCompSendFormat.Auto;
            fields.forcePlainText = plain;
            fields.useMultipartAlternative = !plain;
          }
          for (const item of details.attachments || []) if (item?.file) fields.addAttachment(await attachmentFor(item));

          let headerMessageId = null;
          const listener = {
            QueryInterface: ChromeUtils.generateQI(["nsIMsgSendListener"]),
            onStartSending() {}, onProgress() {}, onStatus() {}, onGetDraftFolderURI() {}, onSendNotPerformed() {}, onTransportSecurityError() {},
            onStopSending(msgID, status) { if (Components.isSuccessCode(status)) headerMessageId = String(msgID || "").replace(/^<|>$/g, ""); },
          };
          msgCompose.addMsgSendListener(listener);
          try {
            await msgCompose.sendMsg(Services.io.offline ? Ci.nsIMsgCompDeliverMode.Later : Ci.nsIMsgCompDeliverMode.Now, identity, account.key, null);
          } catch (error) {
            throw new ExtensionError(`Thunderbird couldn't send it: ${error && error.message || error}`);
          } finally { msgCompose.removeMsgSendListener(listener); }
          // As the composer does after sending: the original shows as answered (or forwarded).
          if (kind !== "draft") {
            try {
              related.folder.addMessageDispositionState(related, kind === "forward" ? Ci.nsIMsgFolder.nsMsgDispositionState_Forwarded : Ci.nsIMsgFolder.nsMsgDispositionState_Replied);
            } catch { /* sent anyway */ }
          }
          return { headerMessageId };
        },
      },
    };
  }
};
