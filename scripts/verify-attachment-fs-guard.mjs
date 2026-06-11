#!/usr/bin/env node
// Verifies the hosted-deployment filesystem guard on the attachment tools by
// speaking real MCP JSON-RPC over stdio against the built server. Run after
// `npm run build`.
//
// In the hosted (Cloud Run) deployment the per-user child is spawned with
// XERO_MCP_DISABLE_LOCAL_FILES=1. This script boots the server with that flag
// and asserts the two arbitrary-filesystem primitives are refused BEFORE any
// file is touched:
//
//   1. create-attachment with filePath:/proc/self/environ — must be rejected
//      (no local-file read), forcing base64 fileContent. Closes the secret-leak
//      path that otherwise exposes MCP_JWT_SECRET.
//   2. get-attachment with outputPath:/app/dist/index.js — must be refused
//      (no local-file write). Closes the code-overwrite / RCE path.
//   3. get-attachment is registered as a write tool (its schema carries
//      `confirm`), not a read-only tool.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(__dirname, "..", "dist", "index.js");

// Bogus creds so the server boots; the guard must trip before any Xero/auth or
// filesystem work, so real creds are never needed.
const env = {
  ...process.env,
  XERO_CLIENT_ID: "test-client-id",
  XERO_CLIENT_SECRET: "test-client-secret",
  XERO_CLIENT_BEARER_TOKEN: "",
  XERO_MCP_DISABLE_LOCAL_FILES: "1",
};

const child = spawn("node", [SERVER_ENTRY], {
  env,
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolveRpc, rejectRpc) => {
    pending.set(id, (msg) => {
      if (msg.error) rejectRpc(new Error(JSON.stringify(msg.error)));
      else resolveRpc(msg.result);
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        rejectRpc(new Error(`timeout: ${method}`));
      }
    }, 10000);
  });
}

const checks = [];
const fail = (label, detail) => checks.push({ label, pass: false, detail });
const pass = (label, detail = "") => checks.push({ label, pass: true, detail });

function textOf(result) {
  return result?.content?.[0]?.text ?? "";
}

async function main() {
  await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "verify-fs-guard", version: "0.0.0" },
  });
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );

  const { tools } = await rpc("tools/list", {});
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

  // Check 1: get-attachment is a write tool (carries `confirm`), not read-only.
  const getAttachment = byName["get-attachment"];
  if (!getAttachment) {
    fail("get-attachment present", "tool not registered");
  } else if (getAttachment.inputSchema?.properties?.confirm) {
    pass("get-attachment is gated as a write tool (schema has confirm)");
  } else {
    fail(
      "get-attachment is gated as a write tool (schema has confirm)",
      "still annotated/registered as read-only",
    );
  }

  // Check 2: create-attachment with a local filePath is refused (no file read).
  const createRes = await rpc("tools/call", {
    name: "create-attachment",
    arguments: {
      entityType: "invoice",
      entityId: "00000000-0000-0000-0000-000000000000",
      filePath: "/proc/self/environ",
      confirm: true,
    },
  });
  const createText = textOf(createRes);
  if (/filePath is not supported/i.test(createText)) {
    pass("create-attachment refuses local filePath in hosted mode");
  } else {
    fail(
      "create-attachment refuses local filePath in hosted mode",
      `got: ${createText.slice(0, 160)}…`,
    );
  }

  // Check 3: get-attachment writing to a server path is refused (no file write).
  const getRes = await rpc("tools/call", {
    name: "get-attachment",
    arguments: {
      entityType: "invoice",
      entityId: "00000000-0000-0000-0000-000000000000",
      attachmentId: "00000000-0000-0000-0000-000000000000",
      outputPath: "/app/dist/index.js",
      confirm: true,
    },
  });
  const getText = textOf(getRes);
  if (/cannot write files on this server/i.test(getText)) {
    pass("get-attachment refuses local file write in hosted mode");
  } else {
    fail(
      "get-attachment refuses local file write in hosted mode",
      `got: ${getText.slice(0, 160)}…`,
    );
  }

  child.stdin.end();
}

main()
  .catch((err) => {
    fail("script ran to completion", err?.message ?? String(err));
  })
  .finally(() => {
    setTimeout(() => {
      console.log("\n=== Attachment Filesystem Guard Verification ===\n");
      let okCount = 0;
      for (const c of checks) {
        const mark = c.pass ? "PASS" : "FAIL";
        console.log(`[${mark}] ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
        if (c.pass) okCount++;
      }
      console.log(`\n${okCount}/${checks.length} checks passed.`);
      child.kill();
      process.exit(okCount === checks.length ? 0 : 1);
    }, 500);
  });
