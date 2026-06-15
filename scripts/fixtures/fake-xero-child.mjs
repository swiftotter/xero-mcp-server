#!/usr/bin/env node
// Minimal fake Xero MCP stdio child, used by scripts/verify-stateless-mcp.mjs.
//
// Speaks newline-delimited JSON-RPC (the MCP stdio framing) so the real
// ChildPool can spawn and drive it exactly as it would the production child.
// Its tool result reports the child's pid plus the sandbox-relevant env vars,
// which lets the harness assert child identity/reuse and verify the env sandbox
// (no MCP_JWT_SECRET, XERO_MCP_DISABLE_LOCAL_FILES=1) on the ACTUAL spawned
// process — end to end, not just by inspecting the filter function.
import process from "node:process";

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handle(line);
  }
});
process.stdin.on("end", () => process.exit(0));

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  // A response, or a notification (no id) such as notifications/initialized:
  // nothing to answer.
  if (method === undefined || id === undefined || id === null) return;

  if (method === "initialize") {
    const requested = params?.protocolVersion;
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion:
          typeof requested === "string" ? requested : "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "Xero MCP Server", version: "1.0.0" },
        instructions: "fake xero child",
      },
    });
    return;
  }
  if (method === "ping") {
    write({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "whoami",
            description: "report child identity + env",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
    return;
  }
  if (method === "tools/call") {
    const payload = {
      pid: process.pid,
      hasJwtSecret: Boolean(process.env.MCP_JWT_SECRET),
      disableLocalFiles: process.env.XERO_MCP_DISABLE_LOCAL_FILES ?? null,
      userName: process.env.XERO_USER_NAME ?? null,
      secretName: process.env.XERO_REFRESH_TOKEN_SECRET_NAME ?? null,
    };
    write({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
    });
    return;
  }
  write({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `method not found: ${method}` },
  });
}
