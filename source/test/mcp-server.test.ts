// @ts-nocheck -- the project has no Node type definitions; this test runs the MCP server as a Node child process.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// The real server script against a stand-in for Ember's socket.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spark-mcp-"));
const socketPath = path.join(dir, "agent.sock");
const seen: any[] = [];
let spark: net.Server;
let child: ChildProcessWithoutNullStreams;
const answers = new Map<number, (value: any) => void>();
let lineBuffer = "";
function call(id: number, method: string, params: any = {}) {
  return new Promise<any>((resolve) => { answers.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
}
beforeAll(async () => {
  spark = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk;
      let end;
      while ((end = buf.indexOf("\n")) >= 0) {
        const request = JSON.parse(buf.slice(0, end)); buf = buf.slice(end + 1);
        seen.push(request);
        const reply = request.method === "find" ? { result: { total: 1, emails: [{ id: "a@x", subject: "Budget?", needs_reply: true }] } }
          : request.method === "mark" ? { result: { updated: request.params.ids.length } } : { error: "Ember says no." };
        conn.write(JSON.stringify({ id: request.id, ...reply }) + "\n");
      }
    });
  });
  await new Promise<void>((resolve) => spark.listen(socketPath, resolve));
  child = spawn(process.execPath, [path.resolve("mcp/spark-mcp.mjs")], { env: { ...process.env, SPARK_AGENT_SOCKET: socketPath } });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    lineBuffer += chunk;
    let end;
    while ((end = lineBuffer.indexOf("\n")) >= 0) { const message = JSON.parse(lineBuffer.slice(0, end)); lineBuffer = lineBuffer.slice(end + 1); answers.get(message.id)?.(message); }
  });
});
afterAll(() => { child?.kill(); spark?.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("Ember's MCP server", () => {
  it("introduces itself and lists its tools", async () => {
    const init = await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "ember" }, capabilities: { tools: {} } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const list = await call(2, "tools/list");
    expect(list.result.tools.map((t: any) => t.name)).toEqual(["find_emails", "read_email", "open_email", "mark_emails", "draft_reply", "list_marked", "ember_status", "calendar_events", "find_free_times", "hold_time"]);
    expect(list.result.tools.find((t: any) => t.name === "mark_emails").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    // Agents are told to give the user each email's link.
    expect(init.result.instructions).toContain("[subject](link)");
    expect(list.result.tools.find((t: any) => t.name === "find_emails").description).toContain("link");
    expect(list.result.tools.find((t: any) => t.name === "open_email").inputSchema.required).toEqual(["id"]);
    // Every tool takes an optional reason (shown in Ember's Agent Activity).
    expect(list.result.tools.every((t: any) => t.inputSchema.properties.reason?.type === "string" && !(t.inputSchema.required || []).includes("reason"))).toBe(true);
  });
  it("forwards tool calls to Ember and returns its answer", async () => {
    const found = await call(3, "tools/call", { name: "find_emails", arguments: { signal: "needs_reply", days: 7 } });
    expect(found.result.structuredContent).toEqual({ total: 1, emails: [{ id: "a@x", subject: "Budget?", needs_reply: true }] });
    expect(JSON.parse(found.result.content[0].text).total).toBe(1);
    const marked = await call(4, "tools/call", { name: "mark_emails", arguments: { ids: ["a@x"], top: true } });
    expect(marked.result.structuredContent).toEqual({ updated: 1 });
    // Ember hears which agent asked (the client's own name from initialize), for Agent Activity.
    expect(seen.map((r) => [r.method, r.params])).toEqual([["find", { signal: "needs_reply", days: 7, _agent: "test" }], ["mark", { ids: ["a@x"], top: true, _agent: "test" }]]);
  });
  it("reports Ember's errors as tool errors, and unknown methods as protocol errors", async () => {
    const status = await call(5, "tools/call", { name: "ember_status", arguments: {} });
    expect(status.result).toMatchObject({ isError: true, content: [{ type: "text", text: "Ember says no." }] });
    expect((await call(6, "tools/call", { name: "nope", arguments: {} })).error.code).toBe(-32602);
    expect((await call(7, "resources/list")).error.code).toBe(-32601);
  });
});
