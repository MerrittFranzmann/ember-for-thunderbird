/* Links that open an email in Ember (src/lib/mail-links.ts). Thunderbird answers http://127.0.0.1:47391/email/<code>
 * on the loopback address only (no other computer can reach it): a click on such a link (in an AI agent's answer,
 * a note, the terminal) opens the browser here; the page it gets only says "Opening in Ember", and the background
 * (onOpen, which wakes it if it was asleep) finds the email and shows it. Nothing about any email is ever sent back.
 * Only a link the user opens counts: a web page loading the address in the background (an image, fetch, frame) or
 * another site's name for this address (DNS rebinding) is refused. The test-only pref
 * extensions.spark.mailLinkPort moves the port; extensions.spark.mailLinkActivate=false keeps a test Thunderbird
 * from coming to the front. The pure helper at the top is unit-tested (test/mail-links.test.ts). */
"use strict";

/** What to do with an HTTP request head: { status, page, code? } (code: open this email; page: what to answer). */
function mailLinkRequest(head, port) {
  const lines = String(head).split("\r\n");
  const [method = "", target = ""] = (lines[0] || "").split(" ");
  const headers = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim().toLowerCase();
  }
  // Only this machine's own names for the address: another site's name for it (DNS rebinding) is refused.
  if (headers.host !== `127.0.0.1:${port}` && headers.host !== `localhost:${port}`) return { status: 403, page: "refused" };
  if (method !== "GET" && method !== "HEAD") return { status: 405, page: "refused" };
  const path = target.split(/[?#]/)[0];
  const match = /^\/email\/([0-9a-z]{11})\/?$/.exec(path);
  if (!match) return path === "/" ? { status: 200, page: "home" } : { status: 404, page: "missing" };
  // A link the user opened (a top-level page), not one a web page loads in the background or in a frame.
  const mode = headers["sec-fetch-mode"], dest = headers["sec-fetch-dest"];
  if ((mode && mode !== "navigate") || (dest && dest !== "document")) return { status: 403, page: "refused" };
  if (method === "HEAD") return { status: 200, page: "open" }; // link previews look; only a real visit opens
  return { status: 200, page: "open", code: match[1] };
}

if (typeof module === "object") module.exports = { mailLinkRequest };

const MAIL_LINK_PAGES = {
  open: ["Opening in Ember", "The email is opening in Ember. You can close this tab."],
  home: ["Ember email links", "Links to emails open here in Ember while Thunderbird is running."],
  refused: ["Not allowed", "Only links you open yourself work here."],
  missing: ["No such link", "This isn't a link to an email."],
};
function mailLinkResponse(status, page, head) {
  const [title, text] = MAIL_LINK_PAGES[page] || MAIL_LINK_PAGES.missing;
  const body = head ? "" : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="light dark"><title>${title}</title><style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:Canvas;color:CanvasText}main{max-width:340px;padding:24px;text-align:center}h1{font-size:19px;font-weight:600;margin:0 0 6px}p{margin:0;opacity:.7}</style></head><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;
  const bytes = new TextEncoder().encode(body);
  const reason = { 200: "OK", 403: "Forbidden", 404: "Not Found", 405: "Method Not Allowed" }[status] || "OK";
  return `HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${bytes.length}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\n${status === 405 ? "Allow: GET, HEAD\r\n" : ""}Connection: close\r\n\r\n` + String.fromCharCode(...bytes);
}

/** One listener for Thunderbird (shared by every context); clicks that came while no one listened wait 30 s. */
const sparkMailLinkHub = { server: null, port: 0, listeners: new Set(), waiting: [] };

function mailLinkPort() { return Services.prefs.getIntPref("extensions.spark.mailLinkPort", 47391); }

function mailLinkOpened(code) {
  const hub = sparkMailLinkHub;
  if (hub.listeners.size) { for (const listener of hub.listeners) listener(code); return; }
  hub.waiting = [...hub.waiting.filter((w) => Date.now() - w.at < 30000), { code, at: Date.now() }];
}

function mailLinkAccept(transport) {
  const hub = sparkMailLinkHub;
  const input = transport.openInputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
  const bytes = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
  bytes.init(input);
  let head = "", done = false;
  const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  const finish = (answer) => {
    if (done) return;
    done = true;
    timer.cancel();
    // The answer goes into the transport's buffer and out on the socket thread: closing both streams (not the
    // transport, which would drop what's still buffered) sends it and then closes the connection.
    let sent = false;
    try {
      if (answer) {
        const out = transport.openOutputStream(0, 0, 0);
        out.write(answer, answer.length);
        out.close();
        sent = true;
      }
    } catch { /* the browser went away */ }
    try { input.close(); } catch { /* closed */ }
    if (!sent) try { transport.close(Cr.NS_OK); } catch { /* closed */ }
  };
  timer.initWithCallback(() => finish(null), 10000, Ci.nsITimer.TYPE_ONE_SHOT);
  const wait = () => input.asyncWait({
    onInputStreamReady() {
      if (done) return;
      try {
        // Ready with nothing to read yet (it happens right after the connection opens): wait for the request. A
        // closed connection throws here; one that never sends anything ends with the timer.
        const available = input.available();
        if (!available) return wait();
        head += bytes.readBytes(Math.min(available, 16384));
      } catch { return finish(null); }
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) { if (head.length > 16384) return finish(mailLinkResponse(403, "refused", false)); return wait(); }
      const request = mailLinkRequest(head.slice(0, end), hub.port);
      if (request.code) mailLinkOpened(request.code);
      finish(mailLinkResponse(request.status, request.page, head.startsWith("HEAD ")));
    },
  }, 0, 0, Services.tm.mainThread);
  wait();
}

var sparkMailLinks = class extends ExtensionCommon.ExtensionAPIPersistent {
  onShutdown(isAppShutdown) {
    const hub = sparkMailLinkHub;
    try { hub.server?.close(); } catch { /* closed */ }
    hub.server = null;
    hub.listeners.clear();
  }
  PERSISTENT_EVENTS = {
    // A click: wakes the background if Thunderbird had put it to sleep, then tells it.
    onOpen({ fire }) {
      const listener = async (code) => {
        if (fire.wakeup) await fire.wakeup();
        fire.async(code);
      };
      sparkMailLinkHub.listeners.add(listener);
      const waiting = sparkMailLinkHub.waiting.filter((w) => Date.now() - w.at < 30000);
      sparkMailLinkHub.waiting = [];
      for (const w of waiting) listener(w.code);
      return {
        unregister() { sparkMailLinkHub.listeners.delete(listener); },
        convert(newFire) { fire = newFire; },
      };
    },
  };
  getAPI(context) {
    const { ExtensionError } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs").ExtensionUtils;
    const hub = sparkMailLinkHub;
    const address = () => `http://127.0.0.1:${hub.port}`;
    return {
      sparkMailLinks: {
        async start() {
          if (hub.server) return { url: address() };
          const port = mailLinkPort();
          const server = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
          try { server.init(port, true, -1); } // loopback only
          catch (error) { throw new ExtensionError(error?.result === Cr.NS_ERROR_SOCKET_ADDRESS_IN_USE ? `port ${port} is in use by another program` : `couldn't listen on port ${port}`); }
          server.asyncListen({ onSocketAccepted(_server, transport) { mailLinkAccept(transport); }, onStopListening() {} });
          hub.server = server;
          hub.port = port;
          return { url: address() };
        },
        async stop() {
          try { hub.server?.close(); } catch { /* closed */ }
          hub.server = null;
        },
        async address() { return hub.server ? address() : null; },
        /** Bring Thunderbird to the front (the click left the browser in front). */
        async activate() {
          if (!Services.prefs.getBoolPref("extensions.spark.mailLinkActivate", true)) return false;
          try { Cc["@mozilla.org/widget/macdocksupport;1"].getService(Ci.nsIMacDockSupport).activateApplication(true); return true; } catch { return false; }
        },
        onOpen: new ExtensionCommon.EventManager({ context, module: "sparkMailLinks", event: "onOpen", extensionApi: this }).api(),
      },
    };
  }
};
