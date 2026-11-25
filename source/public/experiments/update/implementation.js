/* Automatic updates.
 * - Everyone: Ember's public releases on GitHub. Each release has a latest.json:
 *     { "version": "1.0.0", "url": "https://github.com/…/releases/download/v1.0.0/ember-1.0.0.xpi",
 *       "sha256": "…", "signature": "…", "notes": "https://github.com/…/releases/tag/v1.0.0" }
 *   signed (ECDSA P-256) with the publisher's key; EMBER_PUBLIC_KEY below checks it, so only a release the
 *   publisher signed installs, even if the download host were tampered with. Read at most hourly.
 * - Tests and development: a local release folder with a latest.json naming an XPI beside it
 *   ({ "version", "xpi", "sha256", "notes" }), as before. The test-only pref extensions.spark.updateFeed
 *   replaces the GitHub address ("off": no remote check).
 * Thunderbird's own add-on updates would need an update_url and can't wait until Ember isn't in use; this
 * installs the XPI as "Install Add-on From File" would. The pure helpers are unit-tested
 * (test/update-experiment.test.ts). */
"use strict";

/** A latest.json, checked: plain file names inside the folder, a version and a SHA-256. */
function parseFeed(data) {
  const name = (value) => typeof value === "string" && /^[\w.-]+$/.test(value) && !/^\.+$/.test(value) ? value : null;
  if (!data || typeof data !== "object") throw new Error("latest.json isn't an object");
  const version = typeof data.version === "string" && /^\d+(\.\d+){1,3}$/.test(data.version) ? data.version : null;
  const xpi = name(data.xpi);
  const sha256 = typeof data.sha256 === "string" && /^[0-9a-f]{64}$/i.test(data.sha256) ? data.sha256.toLowerCase() : null;
  if (!version || !xpi || !xpi.endsWith(".xpi") || !sha256) throw new Error("latest.json needs version, xpi and sha256");
  return { version, xpi, sha256, notes: name(data.notes) };
}

const EMBER_RELEASES = "https://github.com/MerrittFranzmann/ember-for-thunderbird/releases/";
const EMBER_FEED = `${EMBER_RELEASES}latest/download/latest.json`;
const EMBER_PUBLIC_KEY = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEIVnxv2zhejmeF5ZJhCRRvE2z8OUOkyzGhb3vYoQ+lICRZxd4j8ij/5CaHphPtiskgr/06/BGUg/8JQm37maXeA==";

/** A published latest.json, checked: a version, an XPI among Ember's own releases, a SHA-256 and a signature. */
function parseRemoteFeed(data, releases = EMBER_RELEASES) {
  if (!data || typeof data !== "object") throw new Error("latest.json isn't an object");
  const version = typeof data.version === "string" && /^\d+(\.\d+){1,3}$/.test(data.version) ? data.version : null;
  const url = typeof data.url === "string" && data.url.startsWith(`${releases}download/`) && /^[\w./:-]+\.xpi$/.test(data.url) && !data.url.includes("..") ? data.url : null;
  const sha256 = typeof data.sha256 === "string" && /^[0-9a-f]{64}$/i.test(data.sha256) ? data.sha256.toLowerCase() : null;
  const signature = typeof data.signature === "string" && /^[A-Za-z0-9+/]+=*$/.test(data.signature) ? data.signature : null;
  if (!version || !url || !sha256 || !signature) throw new Error("latest.json needs version, url (an Ember release), sha256 and signature");
  const notes = typeof data.notes === "string" && data.notes.startsWith(releases) ? data.notes : `${releases}tag/v${version}`;
  return { version, url, sha256, signature, notes };
}
/** What the publisher signs: the version and the XPI's hash (so neither can be swapped). */
function signedText(feed) { return `ember-update\n${feed.version}\n${feed.sha256}`; }
function base64Bytes(text) { return Uint8Array.from(atob(text), (c) => c.charCodeAt(0)); }
/** Whether the feed carries the publisher's signature (WebCrypto, ECDSA P-256 / SHA-256, raw r‖s). */
async function verifyFeed(feed, subtle, publicKey = EMBER_PUBLIC_KEY) {
  try {
    const key = await subtle.importKey("spki", base64Bytes(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, base64Bytes(feed.signature), new TextEncoder().encode(signedText(feed)));
  } catch { return false; }
}

if (typeof module === "object") module.exports = { parseFeed, parseRemoteFeed, signedText, verifyFeed, EMBER_FEED, EMBER_RELEASES };

var sparkUpdate = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    const { ExtensionError } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs").ExtensionUtils;
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
    const extension = context.extension;
    Cu.importGlobalProperties(["fetch", "crypto", "TextEncoder", "atob", "AbortController"]);
    const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    // Experiments share one global, and the window Experiment has its own PREF_UPDATING.
    const PREF_UPDATING = "extensions.spark.updating";

    function folder(path) {
      if (path) return new FileUtils.File(path);
      const dir = Services.dirsvc.get("ULibDir", Ci.nsIFile);
      dir.append("Application Support");
      dir.append("Ember");
      dir.append("Updates");
      return dir;
    }
    function child(dir, name) { const file = dir.clone(); file.append(name); return file; }

    async function readFeed(path) {
      const dir = folder(path);
      const file = child(dir, "latest.json");
      if (!file.exists()) return { dir, feed: null };
      try { return { dir, feed: parseFeed(await IOUtils.readJSON(file.path)) }; }
      catch (error) { throw new ExtensionError(`Couldn't read ${file.path}: ${error.message || error}`); }
    }
    // ---- The public feed ----
    function feedUrl() {
      const override = Services.prefs.getStringPref("extensions.spark.updateFeed", "");
      return override === "off" ? "" : override || EMBER_FEED;
    }
    async function download(url, kind) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), kind === "json" ? 20000 : 120000);
      try {
        const reply = await fetch(url, { cache: "no-store", credentials: "omit", signal: controller.signal });
        if (reply.status === 404 && kind === "json") return null; // no release published yet
        if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
        return kind === "json" ? await reply.json() : new Uint8Array(await reply.arrayBuffer());
      } catch (error) {
        throw new ExtensionError(`Couldn't reach Ember's releases: ${error?.name === "AbortError" ? "no answer in time" : error?.message || error}`);
      } finally { clearTimeout(timer); }
    }
    // Read at most hourly (every Ember asks GitHub); Update now and installing read it fresh.
    const remote = { at: 0, feed: null };
    async function readRemote(fresh) {
      const url = feedUrl();
      if (!url) return null;
      if (!fresh && remote.at && Date.now() - remote.at < 55 * 60000) return remote.feed;
      const data = await download(url, "json");
      let feed = null;
      if (data) {
        // A test feed (the pref) names its own releases folder; else Ember's GitHub releases.
        const releases = url !== EMBER_FEED && url.includes("/releases/") ? url.slice(0, url.indexOf("/releases/") + 10) : EMBER_RELEASES;
        try { feed = parseRemoteFeed(data, releases); } catch (error) { throw new ExtensionError(`Ember's latest release is malformed: ${error.message}`); }
        if (!(await verifyFeed(feed, crypto.subtle))) throw new ExtensionError("Ember's latest release isn't signed by its publisher, so it won't be installed.");
      }
      Object.assign(remote, { at: Date.now(), feed });
      return feed;
    }
    function hashBytes(bytes) {
      const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
      hash.init(Ci.nsICryptoHash.SHA256);
      hash.update(bytes, bytes.length);
      return Array.from(hash.finish(false), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    }
    /** Install a verified XPI file; Ember restarts as the new version. */
    async function installFile(file, version, label) {
      const install = await AddonManager.getInstallForFile(file, "application/x-xpinstall");
      if (!install || install.error || !install.addon) throw new ExtensionError(`${label} isn't an installable add-on`);
      if (install.addon.id !== extension.id || install.addon.version !== version) {
        install.cancel();
        throw new ExtensionError(`${label} is ${install.addon.id} ${install.addon.version}, not Ember ${version}`);
      }
      // Ember-only mode: the window Experiment keeps Thunderbird's window hidden across the restart.
      Services.prefs.setStringPref(PREF_UPDATING, String(Date.now()));
      try { await install.install(); }
      catch (error) { Services.prefs.clearUserPref(PREF_UPDATING); throw new ExtensionError(`Install failed: ${error?.message || error}`); }
      if (install.state !== AddonManager.STATE_INSTALLED) {
        Services.prefs.clearUserPref(PREF_UPDATING);
        throw new ExtensionError(`Install failed (error ${install.error})`);
      }
      return true;
    }

    async function sha256(file) {
      const bytes = await IOUtils.read(file.path);
      const hash = Cc["@mozilla.org/security/hash;1"].createInstance(Ci.nsICryptoHash);
      hash.init(Ci.nsICryptoHash.SHA256);
      hash.update(bytes, bytes.length);
      return Array.from(hash.finish(false), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    }

    return {
      sparkUpdate: {
        async check(path, fresh) {
          const current = extension.version;
          const temporary = !!extension.temporarilyInstalled;
          if (!path) {
            const feed = await readRemote(!!fresh);
            return { folder: "", source: "github", current, temporary, version: feed?.version ?? null, newer: !!feed && Services.vc.compare(feed.version, current) > 0 };
          }
          const { dir, feed } = await readFeed(path);
          return {
            folder: dir.path,
            source: "folder",
            current,
            temporary,
            version: feed?.version ?? null,
            newer: !!feed && Services.vc.compare(feed.version, current) > 0,
          };
        },
        /** Install the offered version (it must still be the one checked). The add-on restarts as the
         *  new version, so on success this call never answers. */
        async install(version, path) {
          if (!path) {
            const feed = await readRemote(true);
            if (!feed || feed.version !== version) throw new ExtensionError(`Ember's releases no longer offer ${version}`);
            if (Services.vc.compare(feed.version, extension.version) <= 0) throw new ExtensionError(`${version} isn't newer than ${extension.version}`);
            const bytes = await download(feed.url, "xpi");
            if (hashBytes(bytes) !== feed.sha256) throw new ExtensionError(`The download of Ember ${version} doesn't match its signed release`);
            const target = await IOUtils.createUniqueFile(PathUtils.tempDir, `ember-${version}.xpi`, 0o600);
            await IOUtils.write(target, bytes);
            try { return await installFile(new FileUtils.File(target), version, `Ember ${version}`); }
            finally { await IOUtils.remove(target, { ignoreAbsent: true }).catch(() => {}); }
          }
          const { dir, feed } = await readFeed(path);
          if (!feed || feed.version !== version) throw new ExtensionError(`The update folder no longer offers ${version}`);
          if (Services.vc.compare(feed.version, extension.version) <= 0) throw new ExtensionError(`${version} isn't newer than ${extension.version}`);
          const file = child(dir, feed.xpi);
          if (!file.exists()) throw new ExtensionError(`${feed.xpi} is missing`);
          if (await sha256(file) !== feed.sha256) throw new ExtensionError(`${feed.xpi} doesn't match latest.json (still being copied?)`);
          return installFile(file, version, feed.xpi);
        },
        /** Open a release's notes (the folder's notes file) in the default app. */
        async openNotes(path) {
          if (!path) {
            const feed = await readRemote(false).catch(() => null);
            const url = feed?.notes || `${EMBER_RELEASES}latest`;
            Cc["@mozilla.org/uriloader/external-protocol-service;1"].getService(Ci.nsIExternalProtocolService).loadURI(Services.io.newURI(url));
            return true;
          }
          const { dir, feed } = await readFeed(path);
          if (!feed?.notes) return false;
          const file = child(dir, feed.notes);
          if (!file.exists()) return false;
          file.launch();
          return true;
        },
      },
    };
  }
};
this.sparkUpdate = sparkUpdate;
