/* Ember's AI sorting through Cloudflare Workers AI (Clef decision models). Pages can't call Cloudflare's API
 * (it sends no CORS headers), so this asks from Thunderbird's side, without cookies, only that API. The
 * account ID and token are the user's own, from Ember's Settings. A test-only pref
 * (extensions.spark.clefEndpoint, an http://127.0.0.1 address) points it at a local mock instead. */
"use strict";

const CLEF_MODELS = ["clef", "clef-flash"];
/** Cloudflare's endpoint for a model, or null when the account ID or model isn't valid. */
function clefEndpoint(accountId, model, override) {
  if (!CLEF_MODELS.includes(model)) return null;
  if (override) return /^http:\/\/127\.0\.0\.1:\d+(\/|$)/.test(override) ? `${override.replace(/\/$/, "")}/${model}` : null;
  if (!/^[0-9a-f]{32}$/i.test(String(accountId || ""))) return null;
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/${model}`;
}

/** Workers AI's text model that reads travel bookings out of an email (Trips). */
const TRAVEL_LLM = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
function llmEndpoint(accountId, override) {
  if (override) return /^http:\/\/127\.0\.0\.1:\d+(\/|$)/.test(override) ? `${override.replace(/\/$/, "")}/llm` : null;
  if (!/^[0-9a-f]{32}$/i.test(String(accountId || ""))) return null;
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${TRAVEL_LLM}`;
}

if (typeof module === "object") module.exports = { clefEndpoint, llmEndpoint };

var sparkAI = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    const { ExtensionError } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs").ExtensionUtils;
    const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
    Cu.importGlobalProperties(["fetch", "AbortController"]); // not in the Experiment sandbox by default
    async function post(url, token, body, ms) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), ms);
      try {
        const reply = await fetch(url, {
          method: "POST",
          credentials: "omit",
          cache: "no-store",
          signal: controller.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        let json = null;
        try { json = await reply.json(); } catch { /* not JSON */ }
        return { status: reply.status, body: json };
      } catch (error) {
        if (error && error.name === "AbortError") throw new ExtensionError("Cloudflare didn't answer in time.");
        throw new ExtensionError(`Couldn't reach Cloudflare: ${error && error.message || error}`);
      } finally { clearTimeout(timer); }
    }
    return {
      sparkAI: {
        /** One request to the travel model (messages + JSON schema). Returns { status, body }. */
        async llm(accountId, token, request) {
          const url = llmEndpoint(accountId, Services.prefs.getStringPref("extensions.spark.clefEndpoint", ""));
          if (!url) throw new ExtensionError("That Cloudflare account ID doesn't look right (32 letters and digits).");
          if (!/^[\w.-]{20,200}$/.test(String(token || ""))) throw new ExtensionError("That Cloudflare API token doesn't look right.");
          return post(url, token, request, 60000);
        },
        /** One Clef request. Returns { status, body } (body: Cloudflare's JSON answer, or null). */
        async clef(accountId, token, model, request) {
          const url = clefEndpoint(accountId, model, Services.prefs.getStringPref("extensions.spark.clefEndpoint", ""));
          if (!url) throw new ExtensionError("That Cloudflare account ID doesn't look right (32 letters and digits).");
          if (!/^[\w.-]{20,200}$/.test(String(token || ""))) throw new ExtensionError("That Cloudflare API token doesn't look right.");
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 20000);
          try {
            const reply = await fetch(url, {
              method: "POST",
              credentials: "omit",
              cache: "no-store",
              signal: controller.signal,
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
              body: JSON.stringify({ ...request, model }),
            });
            let body = null;
            try { body = await reply.json(); } catch { /* not JSON */ }
            return { status: reply.status, body };
          } catch (error) {
            if (error && error.name === "AbortError") throw new ExtensionError("Cloudflare didn't answer in time.");
            throw new ExtensionError(`Couldn't reach Cloudflare: ${error && error.message || error}`);
          } finally { clearTimeout(timer); }
        },
      },
    };
  }
};
