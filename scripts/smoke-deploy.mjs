#!/usr/bin/env node
// Post-deploy smoke test for the shared Cloud Run service. Dependency-free
// (global fetch) so the deploy job can run it without `npm ci`.
//
//   node scripts/smoke-deploy.mjs <baseUrl>
//
// `/status` alone proves only that Express started — it is a hardcoded handler.
// Security updates auto-merge and deploy with nobody watching, so this drives the
// public surface a dependency bump can break without failing the build: the MCP
// SDK's OAuth router (metadata, /register, /authorize), body parsing, the JWT
// bearer verifier on /mcp, the Xero redirect built from the mounted app secret,
// and the /callback router. It sends no credential and never reaches Xero.
//
// Env:
//   SMOKE_PUBLIC_URL             URL the server believes it lives at (its
//                                PUBLIC_URL). Defaults to <baseUrl>; CI sets it
//                                because the container is reached on an
//                                ephemeral host port.
//   SMOKE_EXPECT_XERO_CLIENT_ID  If set, the /authorize redirect must carry
//                                exactly this Xero client_id.
//
// Side effects on the live service: one in-memory client registration and one
// pending authorize state (expires in 10 min). Both are well inside the SDK's
// rate limits.

import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const XERO_AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize";
const LOOPBACK_REDIRECT = "http://127.0.0.1:9/callback";
const REQUEST_TIMEOUT_MS = 20_000;

function base64url(buf) {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function request(url, init = {}) {
  return fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...init,
  });
}

async function readJson(res) {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

// A deploy lands on a cold instance; give /status a short window to come up
// before treating a refusal or 5xx as a failure.
async function waitForStatus(url, attempts, delayMs) {
  let last = "no response";
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await request(url);
      const body = await readJson(res);
      if (res.status === 200 && body?.status === "ok") return { pass: true };
      last = `HTTP ${res.status} ${JSON.stringify(body)}`;
    } catch (err) {
      last = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err);
    }
    if (i < attempts - 1) await sleep(delayMs);
  }
  return { pass: false, detail: last };
}

/**
 * Run every check against `baseUrl`. Returns [{ label, pass, detail }]; never
 * throws for a failed check, so one broken endpoint doesn't hide the rest.
 */
export async function runSmoke({
  baseUrl,
  publicUrl = baseUrl,
  expectXeroClientId,
  statusAttempts = 6,
  statusDelayMs = 5_000,
} = {}) {
  const base = baseUrl.replace(/\/$/, "");
  const pub = publicUrl.replace(/\/$/, "");
  const checks = [];
  const record = (label, pass, detail = "") => checks.push({ label, pass, detail });
  const check = async (label, fn) => {
    try {
      const detail = await fn();
      record(label, detail === undefined, detail ?? "");
    } catch (err) {
      record(label, false, err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err));
    }
  };

  // /status, not /healthz: Cloud Run's frontend reserves paths ending in "z"
  // and answers /healthz with its own 404 before the request reaches us.
  const status = await waitForStatus(`${base}/status`, statusAttempts, statusDelayMs);
  record("GET /status -> ok", status.pass, status.detail ?? "");
  if (!status.pass) return checks; // nothing else can pass against a dead service

  await check("authorization-server metadata points at this service", async () => {
    const res = await request(`${base}/.well-known/oauth-authorization-server`);
    if (res.status !== 200) return `HTTP ${res.status}`;
    const meta = await readJson(res);
    if (!meta) return "body is not JSON";
    const problems = [];
    if (new URL(meta.issuer ?? "", "http://invalid").origin !== new URL(pub).origin) {
      problems.push(`issuer ${meta.issuer} != ${pub}`);
    }
    for (const [key, path] of [
      ["authorization_endpoint", "/authorize"],
      ["token_endpoint", "/token"],
      ["registration_endpoint", "/register"],
    ]) {
      if (meta[key] !== `${pub}${path}`) problems.push(`${key} ${meta[key]} != ${pub}${path}`);
    }
    if (!meta.code_challenge_methods_supported?.includes("S256")) {
      problems.push("S256 not in code_challenge_methods_supported");
    }
    if (problems.length) return problems.join("; ");
  });

  await check("protected-resource metadata names /mcp", async () => {
    const res = await request(`${base}/.well-known/oauth-protected-resource/mcp`);
    if (res.status !== 200) return `HTTP ${res.status}`;
    const meta = await readJson(res);
    if (meta?.resource !== `${pub}/mcp`) return `resource ${meta?.resource} != ${pub}/mcp`;
  });

  const mcpPost = (headers = {}) =>
    request(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

  await check("POST /mcp without a token -> 401 Bearer challenge", async () => {
    const res = await mcpPost();
    const challenge = res.headers.get("www-authenticate") ?? "";
    if (res.status !== 401) return `HTTP ${res.status}`;
    if (!/^Bearer\b/i.test(challenge)) return `WWW-Authenticate: ${challenge || "(missing)"}`;
  });

  // Exercises the JWT verifier itself (jsonwebtoken + the loaded signing key);
  // the no-token case above is rejected before the verifier runs.
  await check("POST /mcp with a forged token -> 401 invalid_token", async () => {
    const res = await mcpPost({ Authorization: "Bearer smoke.not-a.jwt" });
    const body = await readJson(res);
    if (res.status !== 401) return `HTTP ${res.status}`;
    if (body?.error !== "invalid_token") return `error ${JSON.stringify(body)}`;
  });

  await check("GET /mcp without a token -> 401", async () => {
    const res = await request(`${base}/mcp`);
    if (res.status !== 401) return `HTTP ${res.status}`;
  });

  let clientId;
  await check("POST /register (loopback client) -> client_id", async () => {
    const res = await request(`${base}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "xero-mcp deploy smoke",
        redirect_uris: [LOOPBACK_REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });
    const body = await readJson(res);
    if (res.status !== 201 || typeof body?.client_id !== "string") {
      return `HTTP ${res.status} ${JSON.stringify(body)}`;
    }
    clientId = body.client_id;
  });

  await check("GET /authorize -> redirect to Xero with this service's callback", async () => {
    if (!clientId) return "skipped: /register did not return a client_id";
    const url = new URL(`${base}/authorize`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", LOOPBACK_REDIRECT);
    url.searchParams.set(
      "code_challenge",
      base64url(createHash("sha256").update(base64url(randomBytes(32))).digest()),
    );
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", "deploy-smoke");
    const res = await request(url);
    const location = res.headers.get("location") ?? "";
    if (res.status !== 302 || !location) return `HTTP ${res.status} location=${location || "(none)"}`;
    const xero = new URL(location);
    const problems = [];
    if (`${xero.origin}${xero.pathname}` !== XERO_AUTHORIZE_URL) problems.push(`redirects to ${xero.origin}${xero.pathname}`);
    const xeroClientId = xero.searchParams.get("client_id") ?? "";
    // The app id is mounted from Secret Manager, which keeps a trailing newline
    // verbatim; the entrypoint trims it, and Xero rejects an untrimmed one.
    if (!xeroClientId || xeroClientId !== xeroClientId.trim()) problems.push("Xero client_id is empty or untrimmed");
    if (expectXeroClientId && xeroClientId !== expectXeroClientId) problems.push(`Xero client_id != ${expectXeroClientId}`);
    if (xero.searchParams.get("redirect_uri") !== `${pub}/callback`) {
      problems.push(`redirect_uri ${xero.searchParams.get("redirect_uri")} != ${pub}/callback`);
    }
    if (!(xero.searchParams.get("scope") ?? "").split(" ").includes("offline_access")) {
      problems.push("scope lacks offline_access");
    }
    if (xero.searchParams.get("code_challenge_method") !== "S256") problems.push("no S256 PKCE to Xero");
    if (problems.length) return problems.join("; ");
  });

  await check("GET /callback without state -> 400", async () => {
    const res = await request(`${base}/callback`);
    if (res.status !== 400) return `HTTP ${res.status}`;
  });

  return checks;
}

export function report(checks) {
  for (const c of checks) {
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.label}${c.detail ? `  — ${c.detail}` : ""}`);
  }
  const failed = checks.filter((c) => !c.pass).length;
  console.log(failed ? `\n${failed} of ${checks.length} smoke checks failed.` : `\nAll ${checks.length} smoke checks passed.`);
  return failed === 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const baseUrl = process.argv[2];
  if (!baseUrl) {
    console.error("usage: node scripts/smoke-deploy.mjs <baseUrl>");
    process.exit(2);
  }
  const checks = await runSmoke({
    baseUrl,
    publicUrl: process.env.SMOKE_PUBLIC_URL || baseUrl,
    expectXeroClientId: process.env.SMOKE_EXPECT_XERO_CLIENT_ID || undefined,
  });
  process.exit(report(checks) ? 0 : 1);
}
