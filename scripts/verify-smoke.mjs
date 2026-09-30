#!/usr/bin/env node
// Runs the post-deploy smoke checks (scripts/smoke-deploy.mjs) against a local
// boot of the real Cloud Run entrypoint. Run after `npm run build`.
//
// The deploy job runs the same checks against production after every rollout and
// rolls back on failure. This runs them BEFORE merge, inside `npm test`, which
// is the only check the central dependency gate trusts before it auto-merges a
// security update — so a bump that breaks the public surface is caught here
// rather than by a rollback.
//
// It also asserts the smoke CAN fail: the same checks against a wrong public
// URL must report failures. A smoke that passes against anything protects
// nothing.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { report, runSmoke } from "./smoke-deploy.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINT = resolve(__dirname, "..", "dist", "cloud-run-entrypoint.js");

const PORT = Number(process.env.VERIFY_PORT) || 8792;
const BASE = `http://127.0.0.1:${PORT}`;
const XERO_APP_CLIENT_ID = "verify-smoke-app-id";

const server = spawn("node", [ENTRYPOINT], {
  env: {
    ...process.env,
    PORT: String(PORT),
    PUBLIC_URL: BASE,
    GCP_PROJECT: "verify-project",
    // Trailing newline, as Secret Manager stores it: the smoke's trim check
    // must see the entrypoint strip it.
    XERO_APP_CLIENT_ID: `${XERO_APP_CLIENT_ID}\n`,
    XERO_APP_CLIENT_SECRET: "verify-app-secret",
    MCP_JWT_SECRET: "verify-smoke-secret",
  },
  stdio: ["ignore", "pipe", "inherit"],
});

function waitForListen() {
  return new Promise((res, rej) => {
    const timer = global.setTimeout(() => rej(new Error("server did not start within 20s")), 20000);
    server.on("exit", (code) => rej(new Error(`server exited with code ${code} before listening`)));
    server.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("listening on port")) {
        global.clearTimeout(timer);
        res();
      }
    });
  });
}

let passed = false;
try {
  await waitForListen();

  console.log("=== Post-deploy smoke against a local entrypoint ===\n");
  passed = report(
    await runSmoke({ baseUrl: BASE, expectXeroClientId: XERO_APP_CLIENT_ID, statusAttempts: 1 }),
  );

  console.log("\n=== The smoke must fail against a mismatched public URL ===\n");
  const wrong = await runSmoke({
    baseUrl: BASE,
    publicUrl: "https://wrong.example.com",
    statusAttempts: 1,
  });
  const failedLabels = wrong.filter((c) => !c.pass).map((c) => c.label);
  const expectFail = [
    "authorization-server metadata points at this service",
    "protected-resource metadata names /mcp",
    "GET /authorize -> redirect to Xero with this service's callback",
  ];
  const missed = expectFail.filter((l) => !failedLabels.includes(l));
  if (missed.length) {
    console.log(`FAIL  mismatched URL was not caught by: ${missed.join(", ")}`);
    passed = false;
  } else {
    console.log(`PASS  mismatched URL caught by ${expectFail.length} checks`);
  }
} catch (err) {
  console.log(`FAIL  ${err?.message ?? err}`);
  passed = false;
} finally {
  server.kill();
}
process.exit(passed ? 0 : 1);
