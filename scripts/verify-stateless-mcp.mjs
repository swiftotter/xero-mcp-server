#!/usr/bin/env node
// Verifies the STATELESS MCP transport + per-user child pool end to end. Run
// after `npm run build`.
//
// Boots the real Cloud Run entrypoint with MCP_SERVER_ENTRYPOINT pointed at a
// fake stdio child (scripts/fixtures/fake-xero-child.mjs), mints real access
// tokens, and drives /mcp over HTTP. Asserts the properties that make instance
// replacement invisible:
//
//   1. initialize over a stateless transport issues NO mcp-session-id header.
//   2. tools/call works with NO prior initialize on the connection (every POST
//      is a fresh transport) — proving there is no initialize-first / session
//      requirement, hence no 404 path.
//   3. The spawned child's env is sandboxed: NO MCP_JWT_SECRET (which signs
//      every user's token), and XERO_MCP_DISABLE_LOCAL_FILES=1.
//   4. RECYCLE: after the child is evicted (= instance/pool loss), the next call
//      transparently respawns a new child and returns a valid result — never 404.
//   5. Concurrency: N parallel calls for one user share ONE child.
//   6. Isolation: two users get two distinct children, each with its own secret.
//   7. GET /mcp -> 405; DELETE /mcp -> 204.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import jwt from "jsonwebtoken";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const ENTRYPOINT = resolve(ROOT, "dist", "cloud-run-entrypoint.js");
const FAKE_CHILD = resolve(__dirname, "fixtures", "fake-xero-child.mjs");

const PORT = 8791;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = "verify-stateless-mcp-secret";

const checks = [];
const ok = (label, detail = "") => checks.push({ label, pass: true, detail });
const bad = (label, detail = "") => checks.push({ label, pass: false, detail });
const assert = (cond, label, detail = "") =>
  cond ? ok(label) : bad(label, detail);

const server = spawn("node", [ENTRYPOINT], {
  env: {
    ...process.env,
    PORT: String(PORT),
    PUBLIC_URL: BASE,
    GCP_PROJECT: "verify-project",
    XERO_APP_CLIENT_ID: "verify-app-id",
    XERO_APP_CLIENT_SECRET: "verify-app-secret",
    MCP_JWT_SECRET: JWT_SECRET,
    MCP_SERVER_ENTRYPOINT: FAKE_CHILD,
  },
  stdio: ["ignore", "pipe", "inherit"],
});

function token(sub, name = "Verify User") {
  return jwt.sign({ sub, name, typ: "access", client_id: "verify" }, JWT_SECRET, {
    algorithm: "HS256",
    issuer: "xero-mcp-server",
    audience: "xero-mcp-server",
    expiresIn: "1h",
  });
}

let nextId = 1;
async function post(sub, method, params) {
  return fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token(sub)}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params: params ?? {} }),
  });
}

async function readRpc(res) {
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean);
    return JSON.parse(data[data.length - 1]);
  }
  return JSON.parse(text);
}

async function callTool(sub) {
  const res = await post(sub, "tools/call", { name: "whoami", arguments: {} });
  const rpc = await readRpc(res);
  const payload = JSON.parse(rpc.result.content[0].text);
  return { status: res.status, rpc, payload };
}

async function waitForListen() {
  return new Promise((res, rej) => {
    const timer = global.setTimeout(
      () => rej(new Error("server did not start within 8s")),
      8000,
    );
    server.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("listening on port")) {
        global.clearTimeout(timer);
        res();
      }
    });
  });
}

async function main() {
  await waitForListen();
  await sleep(150);

  // 1. initialize -> 200, no mcp-session-id, correct serverInfo/capabilities.
  {
    const res = await post("user-a", "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "verify", version: "0.0.0" },
    });
    const rpc = await readRpc(res);
    assert(res.status === 200, "initialize returns 200", `got ${res.status}`);
    assert(
      res.headers.get("mcp-session-id") === null,
      "initialize issues NO mcp-session-id header (stateless)",
      `got ${res.headers.get("mcp-session-id")}`,
    );
    assert(
      rpc.result?.serverInfo?.name === "Xero MCP Server",
      "initialize returns the child serverInfo",
      JSON.stringify(rpc.result?.serverInfo),
    );
    assert(
      Boolean(rpc.result?.capabilities?.tools),
      "initialize advertises tools capability",
      JSON.stringify(rpc.result?.capabilities),
    );
    assert(
      rpc.result?.protocolVersion === "2025-06-18",
      "initialize negotiates the client's protocol version",
      rpc.result?.protocolVersion,
    );
  }

  // 2. tools/call with NO prior initialize on the connection.
  {
    const { status, rpc, payload } = await callTool("fresh-user");
    assert(status === 200, "tools/call (no prior initialize) returns 200", `got ${status}`);
    assert(
      !rpc.error && typeof payload.pid === "number",
      "tools/call relays a result with no initialize-first requirement",
      JSON.stringify(rpc.error ?? rpc.result),
    );
  }

  // 3. Env sandbox on the actual spawned child.
  {
    const { payload } = await callTool("sandbox-user");
    assert(
      payload.hasJwtSecret === false,
      "spawned child does NOT see MCP_JWT_SECRET",
      `hasJwtSecret=${payload.hasJwtSecret}`,
    );
    assert(
      payload.disableLocalFiles === "1",
      "spawned child has XERO_MCP_DISABLE_LOCAL_FILES=1",
      `disableLocalFiles=${payload.disableLocalFiles}`,
    );
    assert(
      payload.secretName === "projects/verify-project/secrets/xero-refresh-token-sandbox-user",
      "spawned child gets the per-user refresh-token secret path",
      payload.secretName,
    );
  }

  // 4. RECYCLE: evict the child (= instance/pool loss) then call again.
  {
    const first = await callTool("recycle-user");
    const del = await fetch(`${BASE}/mcp`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token("recycle-user")}` },
    });
    assert(del.status === 204, "DELETE /mcp returns 204", `got ${del.status}`);
    await sleep(100); // let the evicted child tear down
    const second = await callTool("recycle-user");
    assert(
      second.status === 200 && typeof second.payload.pid === "number",
      "tools/call after recycle returns a valid result (never 404)",
      `status=${second.status}`,
    );
    assert(
      first.payload.pid !== second.payload.pid,
      "recycle respawns a NEW child transparently",
      `pid before=${first.payload.pid} after=${second.payload.pid}`,
    );
  }

  // 5. Concurrency: N parallel calls share one child.
  {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => callTool("concurrent-user")),
    );
    const pids = new Set(results.map((r) => r.payload.pid));
    assert(
      results.every((r) => r.status === 200) && pids.size === 1,
      "5 concurrent calls for one user share exactly one child",
      `pids=${[...pids].join(",")}`,
    );
  }

  // 6. Isolation: two users -> two children, each with its own secret.
  {
    const a = await callTool("iso-a");
    const b = await callTool("iso-b");
    assert(
      a.payload.pid !== b.payload.pid,
      "distinct users get distinct child processes",
      `a=${a.payload.pid} b=${b.payload.pid}`,
    );
    assert(
      a.payload.secretName.endsWith("iso-a") && b.payload.secretName.endsWith("iso-b"),
      "each child is bound to its own user's refresh-token secret",
      `${a.payload.secretName} | ${b.payload.secretName}`,
    );
  }

  // 7. GET -> 405; DELETE (idle, no child) -> 204.
  {
    const get = await fetch(`${BASE}/mcp`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token("user-a")}` },
    });
    assert(
      get.status === 405 && (get.headers.get("allow") ?? "").includes("POST"),
      "GET /mcp returns 405 with Allow: POST",
      `status=${get.status} allow=${get.headers.get("allow")}`,
    );
    const del = await fetch(`${BASE}/mcp`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token("never-spawned")}` },
    });
    assert(del.status === 204, "DELETE for an unknown user returns 204", `got ${del.status}`);
  }

  // 8. Missing/invalid bearer -> 401.
  {
    const res = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert(res.status === 401, "POST without a bearer token returns 401", `got ${res.status}`);
  }
}

main()
  .catch((err) => bad("script ran to completion", err?.stack ?? String(err)))
  .finally(() => {
    console.log("\n=== Stateless MCP / Child-Pool Verification ===\n");
    let okCount = 0;
    for (const c of checks) {
      console.log(`[${c.pass ? "PASS" : "FAIL"}] ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
      if (c.pass) okCount++;
    }
    console.log(`\n${okCount}/${checks.length} checks passed.`);
    server.kill();
    process.exit(okCount === checks.length ? 0 : 1);
  });
