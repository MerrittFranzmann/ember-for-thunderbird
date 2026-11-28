/* "Can they open this link?" for the composer's link check (also: one-click unsubscribe, below). Google Drive, OneDrive/SharePoint and
 * Dropbox answer a visitor who isn't signed in differently: the file itself when anyone with the link
 * may open it, their sign-in page (or 401) when it is limited to an organization or to the people it was
 * shared with, and 404 when it doesn't exist. This asks the way such a visitor would: no cookies, no
 * Thunderbird sign-in, only these services. A page can't (their answers aren't readable across origins).
 * The pure helpers at the top are unit-tested (test/links-experiment.test.ts). */
"use strict";

/** A host on this computer's network: private IPv4 ranges, link-local, IPv6 local, or a .local / .lan name. */
function isPrivateHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (/\.(?:local|lan|internal|home|localdomain)$/.test(h) || !h.includes(".") && !h.includes(":")) return true;
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
  if (v4) { const [a, b] = [Number(v4[1]), Number(v4[2])]; return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127); }
  return h === "::1" || /^f[cd]/.test(h) || /^fe80:/.test(h) || /^::ffff:/.test(h);
}
const LINK_CHECK_HOSTS = /^(?:docs\.google\.com|drive\.google\.com|[a-z0-9-]+\.sharepoint\.com|onedrive\.live\.com|1drv\.ms|(?:www\.)?dropbox\.com)$/i;
const LINK_SIGN_IN_HOSTS = /^(?:accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|login\.microsoft\.com)$/i;

/** "public" (opens without signing in), "signin" (needs an account with access), "missing", or "unknown". */
function linkVerdict(status, finalUrl, title) {
  let host = "", path = "";
  try { const url = new URL(finalUrl); host = url.hostname; path = url.pathname; } catch { /* no final address */ }
  title = String(title || "").trim();
  if (LINK_SIGN_IN_HOSTS.test(host) || (/(?:^|\.)dropbox\.com$/i.test(host) && /^\/login\b/.test(path))) return "signin";
  if (status === 401 || status === 403) return "signin";
  if (status === 404 || status === 410) return "missing";
  if (status >= 200 && status < 300) {
    if (/^Google [A-Za-z ]+: Sign-in$|^Sign in to your account$/i.test(title)) return "signin";
    if (/^Dropbox - (?:Error|404)\b/i.test(title)) return "missing";
    return "public";
  }
  return "unknown";
}

/** The file's name from its page title ("Q3 plan - Google Docs" → "Q3 plan"). */
function linkTitle(title) {
  const text = String(title || "").replace(/&(amp|lt|gt|quot|#39|#x27|apos);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", apos: "'" })[e]).replace(/\s+/g, " ").trim();
  return text.replace(/\s+[-–|]\s+(?:Google (?:Docs|Sheets|Slides|Drive|Forms)|Microsoft (?:Word|Excel|PowerPoint)(?: Online)?|OneDrive|SharePoint|Dropbox)$/i, "").slice(0, 200);
}

if (typeof module === "object") module.exports = { linkVerdict, linkTitle, LINK_CHECK_HOSTS, isPrivateHost };

var sparkLinks = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    const { ExtensionError } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs").ExtensionUtils;
    const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    Cu.importGlobalProperties(["fetch", "AbortController", "TextDecoder", "URL"]); // not in the Experiment sandbox by default

    /** The start of a page, up to its title (a Google Doc's page is over a megabyte). */
    async function head(reply) {
      if (!reply.body) return "";
      const reader = reply.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      try {
        while (text.length < 300000) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          if (/<\/title>/i.test(text)) break;
        }
      } finally { reader.cancel().catch(() => {}); }
      return text;
    }

    return {
      sparkLinks: {
        async access(url) {
          let parsed;
          try { parsed = new URL(url); } catch { throw new ExtensionError("That isn't a link."); }
          if (parsed.protocol !== "https:" || !LINK_CHECK_HOSTS.test(parsed.hostname)) throw new ExtensionError("Ember checks only Google Drive, OneDrive, SharePoint and Dropbox links.");
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8000);
          try {
            const reply = await fetch(parsed.href, { credentials: "omit", cache: "no-store", redirect: "follow", signal: controller.signal });
            const page = reply.ok ? await head(reply) : "";
            const match = /<title[^>]*>([^<]*)/i.exec(page);
            const status = linkVerdict(reply.status, reply.url, match ? linkTitle(match[1]) : "");
            return { status, title: status === "public" && match ? linkTitle(match[1]) : "" };
          } catch {
            return { status: "unknown", title: "" };
          } finally { clearTimeout(timer); }
        },
        /** RFC 8058 one-click unsubscribe: the list's own public https address. A sender's link never reaches this
         *  Mac or its network (localhost, 10.x, 192.168.x …): this POST is privileged. Loopback only for the live
         *  tests, while Marionette (remote control) runs. */
        async unsubscribe(url) {
          let parsed;
          try { parsed = new URL(url); } catch { throw new ExtensionError("That isn't a link."); }
          const testing = (() => { try { return !!Cc["@mozilla.org/remote/marionette;1"]?.getService(Ci.nsIMarionette)?.running; } catch { return false; } })();
          const loopback = /^(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i.test(parsed.hostname);
          if (testing && loopback && /^https?:$/.test(parsed.protocol)) { /* the live test's local list server */ }
          else if (parsed.protocol !== "https:") throw new ExtensionError("One-click unsubscribe needs an https address.");
          else if (loopback || isPrivateHost(parsed.hostname)) throw new ExtensionError("That unsubscribe link points at this computer or its network, so Ember won't follow it.");
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15000);
          try {
            const reply = await fetch(parsed.href, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click", credentials: "omit", cache: "no-store", redirect: "manual", signal: controller.signal });
            reply.body?.cancel().catch(() => {});
            // Not followed (a public link could redirect to this Mac); the list answered, so it took the request.
            if (reply.type === "opaqueredirect") return { ok: true, status: 302 };
            return { ok: reply.ok, status: reply.status };
          } catch (error) {
            return { ok: false, status: 0, error: String(error?.message || error) };
          } finally { clearTimeout(timer); }
        },
      },
    };
  }
};
