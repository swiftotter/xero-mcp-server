#!/usr/bin/env node
/**
 * Guards the `overrides` block in package.json.
 *
 * We force brace-expansion into the @google-cloud/secret-manager chain
 * (google-gax -> rimraf -> glob -> minimatch@9). Secret Manager is where this server reads
 * every user's rotating Xero refresh token, and Xero's rotation is single-use — so a
 * module-resolution or API break there does not just fail a call, it can leave a user
 * unable to authenticate at all. None of it is visible to `tsc` or `eslint`, because it
 * only appears at require() time.
 *
 * We also force axios, which xero-node uses for every API call and which
 * src/clients/xero-client.ts imports directly.
 *
 * The specific hazard, which has bitten the sibling repos twice: brace-expansion 5.x
 * exports `{ expand }` with NO `default`, while minimatch@9's compiled output calls
 * `brace_expansion_1.default()`. Pinning 5.x therefore makes `npm audit` report zero
 * advisories while silently breaking glob's brace expansion at runtime. This repo stays in
 * the 2.x line for that reason, and the version assertion below is written to FAIL if
 * someone raises it out of 2.x without also moving minimatch — rather than letting the
 * breakage reach production.
 *
 * Adapted from swiftotter-github-mcp/scripts/smoke-deps.mjs, which pins the 5.x/minimatch@10
 * pairing instead. Cheap, no network.
 *
 * Run: npm run verify:deps
 */
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * Resolve a module the way the Secret Manager chain does, by walking it step by step.
 *
 * This must NOT use the hoisted top level. Both this repo and its siblings hoist a
 * different glob/minimatch major out of the dev tree (glob@7 + minimatch@3 here), and a
 * check that resolved those would PASS while the real chain — the one that reads every
 * user's refresh token — was broken. That is exactly the failure this script exists to
 * catch, so it would have been worse than no check at all.
 */
const SM_CHAIN = ["@google-cloud/secret-manager", "google-gax", "rimraf"];

function walk(...steps) {
  let r = require;
  for (const step of steps) {
    let from;
    try {
      from = r.resolve(`${step}/package.json`);
    } catch {
      // Some packages (google-gax) declare an `exports` map that does not expose
      // ./package.json. Resolving the package entry lands in the same directory and is
      // enough to root a require() at it.
      from = r.resolve(step);
    }
    r = createRequire(from);
  }
  return r;
}

/** require() rooted at rimraf — use for glob. */
const rimrafRequire = walk(...SM_CHAIN);
/** require() rooted at the chain's glob — use for minimatch. */
const globRequire = walk(...SM_CHAIN, "glob");
/** require() rooted at the chain's minimatch — use for brace-expansion. */
const chainRequire = () => walk(...SM_CHAIN, "glob", "minimatch");

const checks = [];
const fail = [];

function check(name, fn) {
  try {
    fn();
    checks.push(name);
  } catch (e) {
    fail.push(`${name}: ${e.message}`);
  }
}

check("brace-expansion is in the 2.x line and clears the 2.0.0-2.1.3 advisories", () => {
  const pkg = chainRequire()("brace-expansion/package.json");
  const [major, minor, patch] = pkg.version.split(".").map(Number);
  assert.equal(
    major,
    2,
    `expected the 2.x line (minimatch@9 needs its \`default\` export), got ${pkg.version} — ` +
      `if you meant to move to 5.x you must also pin minimatch@10; see //overrides`,
  );
  assert.ok(
    minor > 1 || (minor === 1 && patch >= 4),
    `expected >=2.1.4 to clear the brace-expansion DoS advisories, got ${pkg.version}`,
  );
});

check("brace-expansion is requirable as CJS and expands correctly", () => {
  // minimatch@9 is CJS; this is the exact resolution path it uses.
  const expand = chainRequire()("brace-expansion");
  const fn = typeof expand === "function" ? expand : (expand.default ?? expand.expand);
  assert.equal(typeof fn, "function", "brace-expansion did not export a callable");
  assert.deepEqual(fn("a{b,c}d"), ["abd", "acd"]);
  assert.deepEqual(fn("x{1..3}"), ["x1", "x2", "x3"]);
  assert.deepEqual(fn("plain"), ["plain"]);
});

check("brace-expansion still has the `default` export minimatch@9 calls", () => {
  // The exact shape that breaks when someone jumps to 5.x. Asserted directly so the
  // failure names the cause instead of surfacing as "expand is not a function" from
  // somewhere inside glob.
  const mod = chainRequire()("brace-expansion");
  const viaDefault = typeof mod === "function" ? mod : mod.default;
  assert.equal(
    typeof viaDefault,
    "function",
    "brace-expansion has no callable default export — minimatch@9 calls " +
      "brace_expansion_1.default() and will throw at runtime",
  );
});

check("minimatch IN THE glob CHAIN still brace-expands", () => {
  // Resolve minimatch the way glob does, not the way the hoisted tree does: the top-level
  // minimatch is a different major with a different export shape, and testing that one
  // would prove nothing about the chain this override touches.
  const mod = globRequire("minimatch");
  const minimatch = typeof mod === "function" ? mod : mod.minimatch;
  assert.equal(typeof minimatch, "function", "could not load glob's minimatch");
  assert.equal(minimatch("src/a.ts", "src/*.{ts,js}"), true);
  assert.equal(minimatch("src/a.md", "src/*.{ts,js}"), false);
  assert.equal(minimatch("a/b/c.ts", "a/**/*.ts"), true);
  // The brace path specifically — this is what brace-expansion powers.
  assert.equal(minimatch("x2", "x{1..3}"), true);
  assert.equal(minimatch("x9", "x{1..3}"), false);
});

check("glob loads and globs (rimraf's consumer in the google-gax chain)", () => {
  const glob = rimrafRequire("glob");
  assert.equal(typeof glob.globSync, "function");
  const hits = glob.globSync("package.json");
  assert.ok(hits.length === 1, `expected to find package.json, got ${JSON.stringify(hits)}`);
});

check("fast-uri clears the host-confusion advisories (>=3.1.5)", () => {
  const pkg = require("fast-uri/package.json");
  const [major, minor, patch] = pkg.version.split(".").map(Number);
  assert.ok(
    major > 3 || (major === 3 && (minor > 1 || (minor === 1 && patch >= 5))),
    `expected >=3.1.5, got ${pkg.version}`,
  );
});

check("ajv (fast-uri's consumer, used by the MCP SDK) still compiles a schema", () => {
  const Ajv = require("ajv");
  const ajv = new (Ajv.default ?? Ajv)();
  const validate = ajv.compile({
    type: "object",
    properties: { a: { type: "string" } },
    required: ["a"],
  });
  assert.equal(validate({ a: "x" }), true);
  assert.equal(validate({ a: 1 }), false);
});

check("ip-address clears the SSRF advisories (>=10.3.1)", () => {
  const pkg = require("ip-address/package.json");
  const [major, minor, patch] = pkg.version.split(".").map(Number);
  assert.ok(
    major > 10 || (major === 10 && (minor > 3 || (minor === 3 && patch >= 1))),
    `expected >=10.3.1, got ${pkg.version}`,
  );
});

check("express-rate-limit (ip-address's consumer) still loads", () => {
  const mod = require("express-rate-limit");
  const rateLimit = typeof mod === "function" ? mod : (mod.default ?? mod.rateLimit);
  assert.equal(typeof rateLimit, "function", "express-rate-limit did not export a callable");
});

check("axios clears the advisories (>=1.17.1) and still exposes its API", () => {
  const pkg = require("axios/package.json");
  const [major, minor, patch] = pkg.version.split(".").map(Number);
  assert.ok(
    major > 1 || (major === 1 && (minor > 17 || (minor === 17 && patch >= 1))),
    `expected >=1.17.1, got ${pkg.version}`,
  );
  const mod = require("axios");
  const axios = mod.default ?? mod;
  // The surface xero-node's generated clients and src/clients/xero-client.ts actually use.
  assert.equal(typeof axios, "function", "axios is not callable");
  assert.equal(typeof axios.post, "function");
  assert.equal(typeof axios.get, "function");
  assert.equal(typeof axios.isAxiosError, "function");
});

check("xero-node still loads and builds its API clients (axios is its transport)", () => {
  const { XeroClient } = require("xero-node");
  const client = new XeroClient({
    clientId: "verify",
    clientSecret: "verify",
    grantType: "client_credentials",
  });
  // The two api objects the MCPXeroClient reauth Proxy wraps.
  assert.equal(typeof client.accountingApi, "object");
  assert.equal(typeof client.payrollNZApi, "object");
  assert.equal(typeof client.accountingApi.getContacts, "function");
  assert.equal(typeof client.setTokenSet, "function");
});

check("Secret Manager client still constructs (production auth path)", () => {
  const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
  // No network and no ADC needed to construct; this exercises the whole
  // google-gax -> rimraf -> glob -> minimatch -> brace-expansion module graph.
  const client = new SecretManagerServiceClient({ projectId: "smoke-test" });
  assert.equal(typeof client.accessSecretVersion, "function");
  assert.equal(typeof client.addSecretVersion, "function");
  assert.equal(typeof client.listSecretVersions, "function");
});

if (fail.length > 0) {
  console.error(`\ndependency smoke: ${fail.length} FAILED, ${checks.length} passed\n`);
  for (const f of fail) console.error(`  FAIL  ${f}`);
  console.error(
    "\nAn override in package.json is likely incompatible. See the //overrides note there.",
  );
  process.exit(1);
}
console.log(`dependency smoke: ${checks.length} passed`);
