/* Ember's door for AI agents (MCP). An agent's MCP server (mcp/spark-mcp.mjs) connects to a Unix socket that only
 * the user's account can open (no network port), and sends one JSON request per line; the open Ember window
 * answers it (src/lib/agent-bridge.ts). Off until the user turns it on in Settings. Requests can read mail and
 * set Ember's own marks; nothing here can send, move or delete mail.
 * Socket: ~/Library/Application Support/Ember/agent.sock (the test-only pref
 * extensions.spark.agentSocket overrides it). The pure helper at the top is unit-tested. */
"use strict";

/** Complete lines from a buffer: [lines, the unfinished rest]. */
function agentLines(buffer) {
  const parts = String(buffer).split("\n");
  const rest = parts.pop();
  return [parts.map((line) => line.trim()).filter(Boolean), rest];
}

if (typeof module === "object") module.exports = { agentLines };

/** One server for every Ember page (each page gets its own API object). */
const sparkAgentHub = { server: null, starting: null, watch: null, path: "", handlers: new Set(), pending: new Map(), conns: new Set(), seq: 0 };

var sparkAgent = class extends ExtensionCommon.ExtensionAPI {
  onShutdown() {
    sparkAgentHub.watch?.cancel();
    sparkAgentHub.watch = null;
    for (const conn of [...sparkAgentHub.conns]) { try { conn.transport.close(Cr.NS_OK); } catch { /* gone */ } }
    sparkAgentHub.conns.clear();
    try { sparkAgentHub.server?.close(); } catch { /* already closed */ }
    sparkAgentHub.server = null;
  }
  getAPI(context) {
    const { ExtensionError } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs").ExtensionUtils;
    const hub = sparkAgentHub;

    function socketPath() {
      const override = Services.prefs.getStringPref("extensions.spark.agentSocket", "");
      if (override) return override;
      return PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, "Library", "Application Support", "Ember", "agent.sock");
    }
    function send(conn, message) {
      try { conn.out.writeString(JSON.stringify(message) + "\n"); conn.raw.flush?.(); } catch { close(conn); }
    }
    function close(conn) {
      if (conn.closed) return;
      conn.closed = true;
      hub.conns.delete(conn);
      for (const [id, entry] of hub.pending) if (entry.conn === conn) hub.pending.delete(id);
      try { conn.transport.close(Cr.NS_OK); } catch { /* gone */ }
    }
    function dispatch(conn, line) {
      let request;
      try { request = JSON.parse(line); } catch { return send(conn, { id: null, error: "Not JSON." }); }
      const handlers = [...hub.handlers];
      if (!handlers.length) return send(conn, { id: request.id, error: "Ember isn't open. Open Ember (its window can stay minimized) and try again." });
      const key = `r${++hub.seq}`;
      const timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      hub.pending.set(key, { conn, id: request.id, timer });
      timer.initWithCallback(() => { if (hub.pending.delete(key)) send(conn, { id: request.id, error: "Ember didn't answer in time." }); }, 60000, Ci.nsITimer.TYPE_ONE_SHOT);
      // Every open Ember page hears it; the first answer counts.
      for (const fire of handlers) fire.async(key, String(request.method || ""), JSON.stringify(request.params ?? {}));
    }
    function accept(transport) {
      const input = transport.openInputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
      // Buffered (64 KB × 256 segments): an answer bigger than the socket's own buffer (a few KB) is queued and
      // sent as the agent reads. Unbuffered, such a write failed ("would block") and the connection was dropped.
      const raw = transport.openOutputStream(0, 65536, 256);
      const out = Cc["@mozilla.org/intl/converter-output-stream;1"].createInstance(Ci.nsIConverterOutputStream);
      out.init(raw, "UTF-8");
      const reader = Cc["@mozilla.org/intl/converter-input-stream;1"].createInstance(Ci.nsIConverterInputStream);
      reader.init(input, "UTF-8", 0, 0);
      const conn = { transport, out, raw, closed: false, buffer: "" };
      hub.conns.add(conn);
      const wait = () => input.asyncWait({
        onInputStreamReady() {
          if (conn.closed) return;
          try {
            const chunk = {};
            let read = 0;
            while (input.available() > 0 && (read = reader.readString(65536, chunk))) conn.buffer += chunk.value;
            if (!read && input.available() === 0 && conn.buffer.length > 1 << 20) throw new Error("request too large");
            const [lines, rest] = agentLines(conn.buffer);
            conn.buffer = rest;
            for (const line of lines) dispatch(conn, line);
            wait();
          } catch { close(conn); }
        },
      }, 0, 0, Services.tm.mainThread);
      wait();
    }
    /** Whether something accepts connections on this socket file (another Thunderbird's Ember). */
    function answers(file) {
      return new Promise((resolve) => {
        let transport, timer;
        const done = (value) => { timer?.cancel(); try { transport?.close(Cr.NS_OK); } catch { /* closed */ } resolve(value); };
        try {
          transport = Cc["@mozilla.org/network/socket-transport-service;1"].getService(Ci.nsISocketTransportService).createUnixDomainTransport(file);
          transport.setEventSink({ onTransportStatus(_t, status) { if (status === Ci.nsISocketTransport.STATUS_CONNECTED_TO) done(true); } }, Services.tm.mainThread);
          const input = transport.openInputStream(0, 0, 0).QueryInterface(Ci.nsIAsyncInputStream);
          // Refused (a stale file) shows up as a closed stream.
          input.asyncWait({ onInputStreamReady() { try { input.available(); } catch { done(false); } } }, 0, 0, Services.tm.mainThread);
        } catch { done(false); return; }
        timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
        timer.initWithCallback(() => done(false), 1500, Ci.nsITimer.TYPE_ONE_SHOT);
      });
    }
    async function start() {
      if (hub.server) return hub.path;
      const path = socketPath();
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(path);
      if (!file.parent.exists()) file.parent.create(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
      if (file.exists()) {
        // Another Thunderbird (a second profile) may be answering here: leave it alone. Else it's a socket left
        // by a previous Thunderbird.
        if (await answers(file)) throw new Error("another Thunderbird is already answering agents");
        if (hub.server) return hub.path;
        file.remove(false);
      }
      const server = Cc["@mozilla.org/network/server-socket;1"].createInstance(Ci.nsIServerSocket);
      server.initWithFilename(file, 0o600, -1);
      server.asyncListen({
        onSocketAccepted(_server, transport) { accept(transport); },
        onStopListening() {},
      });
      hub.server = server;
      hub.path = path;
      watch();
      return path;
    }
    /** Every minute while listening: if the socket's file is gone (a cleanup, another program), agents can't
     *  reach Ember although it still listens; open it again. (The interval is a pref for tests.) */
    function watch() {
      hub.watch?.cancel();
      hub.watch = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
      hub.watch.initWithCallback(() => {
        if (!hub.server) { hub.watch?.cancel(); hub.watch = null; return; }
        if (hub.starting) return;
        const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        file.initWithPath(hub.path);
        if (file.exists()) return;
        try { hub.server.close(); } catch { /* closed */ }
        hub.server = null;
        hub.starting = start().catch((error) => Cu.reportError(error)).finally(() => { hub.starting = null; });
      }, Services.prefs.getIntPref("extensions.spark.agentSocketWatchMs", 60000), Ci.nsITimer.TYPE_REPEATING_SLACK);
    }
    function stop() {
      // Turning access off ends agents' open connections too, not only new ones.
      for (const conn of [...hub.conns]) close(conn);
      hub.watch?.cancel();
      hub.watch = null;
      if (!hub.server) return; // the socket file is only this Thunderbird's to remove if it opened it
      try { hub.server.close(); } catch { /* closed */ }
      hub.server = null;
      try { const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile); file.initWithPath(hub.path || socketPath()); if (file.exists()) file.remove(false); } catch { /* gone */ }
    }

    return {
      sparkAgent: {
        /** Put Ember's MCP server (shipped in the add-on) beside the socket, so `node …/ember-mcp.mjs` works on any
         *  Mac without copying anything. Older versions told agents to run …/Spark for Thunderbird/spark-mcp.mjs:
         *  a copy there is refreshed too, so an agent set up then keeps working. Returns the server's path. */
        async installServer(source) {
          const text = String(source || "");
          if (!text.startsWith("#!/usr/bin/env node")) throw new ExtensionError("That isn't Ember's MCP server.");
          const write = async (target) => {
            const current = await IOUtils.readUTF8(target).catch(() => null);
            if (current !== text) await IOUtils.writeUTF8(target, text, { tmpPath: `${target}.tmp` });
            await IOUtils.setPermissions(target, 0o755).catch(() => {});
          };
          const dir = PathUtils.parent(socketPath());
          await IOUtils.makeDirectory(dir, { createAncestors: true, permissions: 0o700 });
          const target = PathUtils.join(dir, "ember-mcp.mjs");
          await write(target);
          if (!Services.prefs.getStringPref("extensions.spark.agentSocket", "")) {
            const legacy = PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, "Library", "Application Support", "Spark for Thunderbird", "spark-mcp.mjs");
            if (await IOUtils.exists(legacy)) await write(legacy);
          }
          return target;
        },
        async start() {
          try { hub.starting ??= start().finally(() => { hub.starting = null; }); return { path: await hub.starting }; } catch (error) { throw new ExtensionError(`Couldn't open the agent socket: ${error && error.message || error}`); }
        },
        async stop() { stop(); },
        async running() { return hub.server ? { path: hub.path } : null; },
        async reply(key, json) {
          const entry = hub.pending.get(key);
          if (!entry) return false; // another Ember page answered first, or it timed out
          hub.pending.delete(key);
          entry.timer.cancel();
          let body;
          try { body = JSON.parse(json); } catch { body = { error: "Ember's answer wasn't JSON." }; }
          send(entry.conn, { id: entry.id, ...body });
          return true;
        },
        onRequest: new ExtensionCommon.EventManager({
          context,
          name: "sparkAgent.onRequest",
          register: (fire) => {
            hub.handlers.add(fire);
            return () => hub.handlers.delete(fire);
          },
        }).api(),
      },
    };
  }
};
