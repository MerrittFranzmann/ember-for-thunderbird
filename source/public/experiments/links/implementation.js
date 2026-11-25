/* "Can they open this link?" for the composer's link check (also: one-click unsubscribe, below). Google Drive, OneDrive/SharePoint and
 * Dropbox answer a visitor who isn't signed in differently: the file itself when anyone with the link
 * may open it, their sign-in page (or 401) when it is limited to an organization or to the people it was
 * shared with, and 404 when it doesn't exist. This asks the way such a visitor would: no cookies, no
 * Thunderbird sign-in, only these services. A page can't (their answers aren't readable across origins).
 * The pure helpers at the top are unit-tested (test/links-experiment.test.ts). */
"use strict";

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

if (typeof module === "object") module.exports = { linkVerdict, linkTitle, LINK_CHECK_HOSTS };

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
        /** RFC 8058 one-click unsubscribe: the list's own https address (loopback http for tests only). */
        async unsubscribe(url) {
          let parsed;
          try { parsed = new URL(url); } catch { throw new ExtensionError("That isn't a link."); }
          if (!(parsed.protocol === "https:" || (parsed.protocol === "http:" && /^(?:127\.0\.0\.1|localhost)$/.test(parsed.hostname)))) throw new ExtensionError("One-click unsubscribe needs an https address.");
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 15000);
          try {
            const reply = await fetch(parsed.href, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click", credentials: "omit", cache: "no-store", redirect: "follow", signal: controller.signal });
            reply.body?.cancel().catch(() => {});
            return { ok: reply.ok, status: reply.status };
          } catch (error) {
            return { ok: false, status: 0, error: String(error?.message || error) };
          } finally { clearTimeout(timer); }
        },
      },
    };
  }
};
