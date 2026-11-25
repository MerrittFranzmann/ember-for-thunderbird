/* VirusTotal for attachments (src/lib/virustotal.ts). Pages can't call VirusTotal's API (no CORS for extension
 * pages, and Ember asks for no host permissions), so this asks from Thunderbird's side, without cookies, only
 * that API, with the user's own key. Lookups send only a SHA-256; upload sends a file the user chose. A test-only
 * pref (extensions.spark.virustotalEndpoint, an http://127.0.0.1 address) points it at a local mock instead. */
"use strict";

/** VirusTotal's API base, or the local mock's (only a 127.0.0.1 address is taken). */
function scanBase(override) {
  if (override) return /^http:\/\/127\.0\.0\.1:\d+(\/|$)/.test(override) ? override.replace(/\/$/, "") : null;
  return "https://www.virustotal.com/api/v3";
}
/** The engines that call a file malicious, and their names for it (last_analysis_results → { engine: name }). */
function scanFlagged(results) {
  const out = {};
  for (const [engine, r] of Object.entries(results || {})) if (r && r.category === "malicious") out[engine] = r.result || "";
  return out;
}
const SCAN_DIRECT_MAX = 32 * 1024 * 1024; // larger files go to a one-time upload URL

if (typeof module === "object") module.exports = { scanBase, scanFlagged };

var sparkScan = class extends ExtensionCommon.ExtensionAPI {
  getAPI() {
    const { ExtensionError } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs").ExtensionUtils;
    const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    Cu.importGlobalProperties(["fetch", "AbortController", "FormData", "Blob"]);
    const base = () => {
      const url = scanBase(Services.prefs.getStringPref("extensions.spark.virustotalEndpoint", ""));
      if (!url) throw new ExtensionError("VirusTotal's address isn't valid.");
      return url;
    };
    const checkKey = (key) => {
      if (!/^[0-9a-f]{64}$/i.test(String(key || "").trim())) throw new ExtensionError("That VirusTotal API key doesn't look right (64 letters and digits).");
      return String(key).trim();
    };
    async function call(url, key, { method = "GET", body = null, ms = 30000 } = {}) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ms);
      try {
        const reply = await fetch(url, { method, body, credentials: "omit", cache: "no-store", signal: controller.signal, headers: { "x-apikey": key, accept: "application/json" } });
        let json = null;
        try { json = await reply.json(); } catch { /* not JSON */ }
        const error = reply.ok ? undefined
          : reply.status === 401 || reply.status === 403 ? "VirusTotal didn't accept the API key."
          : reply.status === 429 ? "VirusTotal's limit for this key was reached (4 a minute, 500 a day on a free key)."
          : json?.error?.message || `VirusTotal answered ${reply.status}.`;
        return { status: reply.status, json, error };
      } catch (error) {
        if (error && error.name === "AbortError") throw new ExtensionError("VirusTotal didn't answer in time.");
        throw new ExtensionError(`Couldn't reach VirusTotal: ${error && error.message || error}`);
      } finally { clearTimeout(timer); }
    }
    return {
      sparkScan: {
        async lookup(apiKey, sha256) {
          const key = checkKey(apiKey);
          if (!/^[0-9a-f]{64}$/i.test(String(sha256 || ""))) throw new ExtensionError("Not a SHA-256.");
          const r = await call(`${base()}/files/${sha256.toLowerCase()}`, key);
          const a = r.json?.data?.attributes;
          return { status: r.status, stats: a?.last_analysis_stats || null, flagged: a ? scanFlagged(a.last_analysis_results) : {}, error: r.status === 404 ? undefined : r.error };
        },
        async upload(apiKey, file, name) {
          const key = checkKey(apiKey);
          const bytes = await file.arrayBuffer();
          let url = `${base()}/files`;
          if (bytes.byteLength > SCAN_DIRECT_MAX) {
            const u = await call(`${base()}/files/upload_url`, key);
            if (!u.json?.data) return { status: u.status, error: u.error || "VirusTotal gave no upload address." };
            url = u.json.data;
          }
          const form = new FormData();
          form.append("file", new Blob([bytes], { type: "application/octet-stream" }), String(name || "attachment"));
          const r = await call(url, key, { method: "POST", body: form, ms: 300000 });
          return { status: r.status, analysis: r.json?.data?.id || null, error: r.error };
        },
        async analysis(apiKey, id) {
          const key = checkKey(apiKey);
          if (!/^[\w=:-]{4,200}$/.test(String(id || ""))) throw new ExtensionError("Not an analysis id.");
          const r = await call(`${base()}/analyses/${encodeURIComponent(id)}`, key);
          const a = r.json?.data?.attributes;
          return { status: r.status, state: a?.status || null, stats: a?.stats || null, flagged: a ? scanFlagged(a.results) : {}, sha256: r.json?.meta?.file_info?.sha256 || null, error: r.error };
        },
      },
    };
  }
};
