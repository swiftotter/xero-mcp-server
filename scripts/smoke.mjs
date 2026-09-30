#!/usr/bin/env node
// Smoke test: proves the BUILT server really works, as far as it can without a real user, Xero org, database
// or credentials. The vulnerability manager's dependency gate runs it on every Dependabot PR (read-only, no
// secrets). After every rollout, Deploy runs scripts/smoke-deploy.mjs against production instead, because
// its rollback is wired to that script; SMOKE_URL mode below is for checking a deployed server by hand.
//
//   npm run build && npm run smoke                        -> starts dist/cloud-run-entrypoint.js locally
//   SMOKE_URL=https://xero-mcp-....run.app npm run smoke  -> checks a deployed server instead
//   SMOKE_VERBOSE=1 ...                                   -> also prints what the tool calls replied
//
// Locally it boots the real entrypoint AND the real per-user child (dist/index.js) with obviously fake
// settings, mints an access token for a fake user with a throwaway signing key, and drives /mcp. It gets an
// empty home folder and GCP's credential server is a closed port, so no call can reach GCP or Xero. Against SMOKE_URL it can't mint a token (it never holds the signing key), so it runs only the checks
// that need none: health, OAuth discovery, and that unauthenticated and forged requests are refused.
//
// It never writes: the one write tool it calls has no confirm flag, so at most it may return a preview.
// Node built-ins only (plus jsonwebtoken, already a dependency, and only in local mode), so SMOKE_URL mode
// runs without installing anything.

import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE = (process.env.SMOKE_URL || "").replace(/\/$/, "");
const PORT = Number(process.env.SMOKE_PORT) || 18000 + Math.floor(Math.random() * 1000);
const BASE = REMOTE || `http://127.0.0.1:${PORT}`;
const FAKE = {
  XERO_APP_CLIENT_ID: "smoke-not-a-real-client-id",
  XERO_APP_CLIENT_SECRET: "smoke-not-a-real-client-secret",
  MCP_JWT_SECRET: `smoke-not-a-real-signing-key-${Math.random().toString(36).slice(2)}`,
};
// Tools that must always be published. A dependency update that drops one of these is a broken server.
const MUST_HAVE_TOOLS = ["list-organisation-details", "list-invoices", "list-contacts", "list-accounts", "create-invoice"];
const MIN_TOOLS = 50;
const deadline = Date.now() + 90_000;

let failures = 0;
const pass = (label, detail = "") => console.log(`  ok    ${label}${detail ? ` (${detail})` : ""}`);
const fail = (label, detail = "") => {
  failures += 1;
  console.log(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
};
const check = (cond, label, detail) => (cond ? pass(label) : fail(label, detail));
const show = (label, text) => process.env.SMOKE_VERBOSE && console.log(`        ${label}: ${text.slice(0, 500)}`);

async function http(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(20_000), redirect: "manual" });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

function json(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// The MCP endpoint answers either plain JSON or a one-shot event stream; take the last JSON-RPC message.
function rpcBody(res) {
  if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
    const data = res.text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean);
    return json(data[data.length - 1] || "");
  }
  return json(res.text);
}

let rpcId = 1;
function mcp(method, params = {}, token) {
  return http("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
}

// Nothing a caller sees may carry a stack trace, a bearer token or one of our (fake) secrets.
function leaks(text) {
  const found = [];
  if (/\n\s+at .+\(.+:\d+:\d+\)/.test(text)) found.push("a stack trace");
  if (/Bearer\s+[A-Za-z0-9._-]{20,}/.test(text)) found.push("a bearer token");
  for (const secret of Object.values(FAKE)) if (text.includes(secret)) found.push("a secret value");
  return found;
}

function startLocalServer() {
  const home = mkdtempSync(join(tmpdir(), "xero-smoke-"));
  const env = {
    PATH: process.env.PATH,
    HOME: home, // no gcloud or ADC files from the machine running this
    NODE_ENV: "production",
    PORT: String(PORT),
    PUBLIC_URL: BASE,
    GCP_PROJECT: "smoke-not-a-real-project",
    GCE_METADATA_HOST: "127.0.0.1:9", // closed port: GCP's credential server is unreachable, as on any
    // machine without Google credentials (with the empty HOME above, there are none to find)
    MCP_SERVER_ENTRYPOINT: join(ROOT, "dist", "index.js"), // the real per-user child
    ...FAKE,
  };
  const child = spawn(process.execPath, [join(ROOT, "dist", "cloud-run-entrypoint.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (c) => (log += c));
  child.stderr.on("data", (c) => (log += c));
  const listening = new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`server did not start within 20s:\n${log.slice(-2000)}`)), 20_000);
    child.on("exit", (code) => rej(new Error(`server exited with ${code} before listening:\n${log.slice(-2000)}`)));
    child.stdout.on("data", () => {
      if (log.includes("listening on port")) {
        clearTimeout(timer);
        res();
      }
    });
  });
  return { child, home, listening, log: () => log };
}

async function mintToken(sub) {
  const { default: jwt } = await import("jsonwebtoken");
  return jwt.sign({ sub, name: "Smoke Test", typ: "access", client_id: "smoke" }, FAKE.MCP_JWT_SECRET, {
    algorithm: "HS256",
    issuer: "xero-mcp-server",
    audience: "xero-mcp-server",
    expiresIn: "5m",
  });
}

// A well-formed access token for a plausible user, signed with a key the server doesn't have. Only a real
// signature check can tell it apart from a genuine one. Built with node:crypto so it also works in SMOKE_URL mode.
function forgedToken() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub: "smoke-forged-user", name: "Forged", typ: "access", client_id: "smoke",
    iss: "xero-mcp-server", aud: "xero-mcp-server", iat: now, exp: now + 300 });
  const sig = createHmac("sha256", randomBytes(32)).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

async function checksThatNeedNoToken() {
  console.log("\nServer is up");
  const status = await http("/status");
  check(status.status === 200 && json(status.text)?.status === "ok", "GET /status answers ok", `${status.status} ${status.text.slice(0, 200)}`);

  console.log("\nSign-in is advertised correctly");
  const as = await http("/.well-known/oauth-authorization-server");
  const meta = json(as.text) || {};
  check(as.status === 200, "OAuth authorization-server metadata is published", `${as.status}`);
  check(
    typeof meta.authorization_endpoint === "string" && typeof meta.token_endpoint === "string",
    "it names the authorize and token endpoints",
    JSON.stringify(meta).slice(0, 300),
  );
  check((meta.code_challenge_methods_supported || []).includes("S256"), "it requires PKCE (S256)", JSON.stringify(meta.code_challenge_methods_supported));

  console.log("\nUnauthenticated and forged requests are refused");
  const anon = await mcp("tools/list");
  check(anon.status === 401, "a request with no token gets 401", `${anon.status} ${anon.text.slice(0, 200)}`);
  check(/Bearer/i.test(anon.headers.get("www-authenticate") || ""), "the 401 tells the client how to sign in (WWW-Authenticate)", anon.headers.get("www-authenticate"));
  const forged = await mcp("tools/list", {}, forgedToken());
  check(forged.status === 401, "a correctly shaped token signed with the wrong key gets 401", `${forged.status} ${forged.text.slice(0, 200)}`);
  for (const [label, res] of [["the no-token reply", anon], ["the forged-token reply", forged]]) {
    const found = leaks(res.text);
    check(found.length === 0, `${label} leaks nothing`, found.join(", "));
  }
}

async function checksWithAFakeUser() {
  const token = await mintToken("smoke-test-user");

  console.log("\nA signed-in request reaches the real server (fake user, no Xero connection)");
  const init = await mcp(
    "initialize",
    { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1.0.0" } },
    token,
  );
  const initRpc = rpcBody(init);
  check(init.status === 200, "initialize succeeds", `${init.status} ${init.text.slice(0, 300)}`);
  check(Boolean(initRpc?.result?.serverInfo?.name), "it reports the server's name and version", JSON.stringify(initRpc?.result?.serverInfo));
  check(Boolean(initRpc?.result?.capabilities?.tools), "it advertises tools", JSON.stringify(initRpc?.result?.capabilities));

  const list = await mcp("tools/list", {}, token);
  const tools = rpcBody(list)?.result?.tools || [];
  check(tools.length >= MIN_TOOLS, `tools/list publishes at least ${MIN_TOOLS} tools`, `got ${tools.length}`);
  const names = new Set(tools.map((t) => t.name));
  const missing = MUST_HAVE_TOOLS.filter((n) => !names.has(n));
  check(missing.length === 0, "the tools that must always exist are there", `missing: ${missing.join(", ")}`);
  const badSchema = tools.filter((t) => t.inputSchema?.type !== "object").map((t) => t.name);
  check(badSchema.length === 0, "every tool publishes an object input schema", badSchema.join(", "));
  if (tools.length) pass("published", `${tools.length} tools`);

  // Limit of this test: a tool call reads the user's stored Xero token from Google Secret Manager first, and
  // with no Google credentials at all the per-user process exits inside Google's client library (an error it
  // raises where nothing can catch it). Production always has Google credentials, so the checks below assert
  // only what holds everywhere: no data comes back, nothing leaks, and the server recovers.
  console.log("\nWithout a Xero connection, tools return nothing and the server recovers");
  const read = rpcBody(await mcp("tools/call", { name: "list-organisation-details", arguments: {} }, token));
  const readText = JSON.stringify(read || {});
  show("reply", readText);
  check(Boolean(read?.error || read?.result?.isError), "a read tool with no Xero connection returns an error, not data", readText.slice(0, 300));
  let found = leaks(readText);
  check(found.length === 0, "that error leaks nothing", found.join(", "));

  const write = rpcBody(
    await mcp("tools/call", { name: "create-contact", arguments: { name: "Smoke Test - do not create", purpose: "smoke test" } }, token),
  );
  const writeText = JSON.stringify(write || {});
  show("reply", writeText);
  const created = /ContactID|contactID|"Contacts"\s*:\s*\[\s*\{/.test(writeText) && !write?.result?.isError;
  check(!created, "a write tool without confirmation creates nothing", writeText.slice(0, 300));
  found = leaks(writeText);
  check(found.length === 0, "that reply leaks nothing", found.join(", "));

  const after = await http("/status");
  check(after.status === 200, "the server is still healthy afterwards", `${after.status}`);
  const again = rpcBody(await mcp("tools/list", {}, token));
  check((again?.result?.tools || []).length >= MIN_TOOLS, "the next request for that user works (a fresh per-user process)", JSON.stringify(again).slice(0, 300));
}

async function main() {
  console.log(REMOTE ? `Smoke test against ${REMOTE}` : "Smoke test of the built server (fake settings, no credentials)");
  let server;
  try {
    if (!REMOTE) {
      server = startLocalServer();
      await server.listening;
    }
    await checksThatNeedNoToken();
    if (!REMOTE) await checksWithAFakeUser();
  } catch (err) {
    fail("the smoke test could not finish", String(err?.stack || err).slice(0, 2000));
  } finally {
    if (server) {
      server.child.kill("SIGTERM");
      const exited = await new Promise((res) => {
        if (server.child.exitCode !== null) return res(true);
        const t = setTimeout(() => res(false), 5000);
        server.child.on("exit", () => (clearTimeout(t), res(true)));
      });
      check(exited, "the server shuts down cleanly");
      if (!exited) server.child.kill("SIGKILL");
      if (process.env.SMOKE_VERBOSE) console.log(`\n--- server log ---\n${server.log().slice(-4000)}`);
      rmSync(server.home, { recursive: true, force: true });
    }
  }
  if (Date.now() > deadline) fail("finished within 90 seconds");
  console.log(failures ? `\n${failures} check(s) failed.` : "\nAll smoke checks passed.");
  process.exit(failures ? 1 : 0);
}

main();
