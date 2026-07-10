#!/usr/bin/env node
// Regression guard: no tool may DROP its declared parameters when the schema is
// published. Run after `npm run build`.
//
// Why this exists: the server registers each tool by handing the SDK a Zod raw
// shape. If that shape is ever misclassified (e.g. read as annotations instead
// of the schema — the classic failure of the positional server.tool() overload
// when the SDK sees a mismatched Zod copy), the SDK silently falls back to an
// EMPTY object schema ({"type":"object"} with no properties). Clients then
// serialize every argument as a string and confirmed writes break — with no
// error anywhere. This asserts against that silent failure in CI.
//
// It runs the REAL ToolFactory (the registration code) through an in-memory MCP
// client and compares, per tool, the number of DECLARED parameters (from the
// tool factories) against the number of PUBLISHED properties a client sees on
// tools/list:
//
//   published property count >= declared parameter count   (for every tool)
//
// This has no false positives: parameter-less tools (several list-* tools) are
// 0 >= 0; write tools publish one EXTRA property (the injected `confirm`), so
// >= still holds; only a tool that declares N params but publishes fewer fails.
//
// Pass criteria:
//   1. Every declared tool is present on tools/list.
//   2. Every published tool has inputSchema.type === "object" and does NOT drop
//      declared properties.
//   3. update-invoice publishes the real types (the tool the bug hit):
//      invoiceId + purpose present, lineItems is an array, confirm is a boolean.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

// The tool modules import the Xero client, which throws at import unless these
// are set. We only list tools — never call Xero — so bogus values are fine and
// keep the check self-contained (mirrors verify-confirmation-gate.mjs).
process.env.XERO_CLIENT_ID = "test-client-id";
process.env.XERO_CLIENT_SECRET = "test-client-secret";
process.env.XERO_CLIENT_BEARER_TOKEN = "";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(__dirname, "..", "dist");
const distImport = (rel) => import(pathToFileURL(resolve(DIST, rel)).href);

const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const { ToolFactory } = await distImport("tools/tool-factory.js");
const { CreateTools } = await distImport("tools/create/index.js");
const { DeleteTools } = await distImport("tools/delete/index.js");
const { GetTools } = await distImport("tools/get/index.js");
const { ListTools } = await distImport("tools/list/index.js");
const { UpdateTools } = await distImport("tools/update/index.js");

const checks = [];
const fail = (label, detail) => checks.push({ label, pass: false, detail });
const pass = (label, detail = "") => checks.push({ label, pass: true, detail });

// Declared parameter count per tool, straight from the factories.
const declared = {};
for (const group of [CreateTools, DeleteTools, GetTools, ListTools, UpdateTools]) {
  for (const factory of group) {
    const tool = factory();
    declared[tool.name] = Object.keys(tool.schema ?? {}).length;
  }
}

// Published schemas, via the REAL ToolFactory through an in-memory MCP client.
const server = new McpServer({ name: "verify-tool-schemas", version: "0.0.0" });
ToolFactory(server);
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: "verify", version: "0.0.0" });
await client.connect(clientTransport);

const { tools } = await client.listTools();
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

// Check 1: every declared tool is published.
const missing = Object.keys(declared).filter((name) => !byName[name]);
if (missing.length === 0) {
  pass("all declared tools are published", `${tools.length} tools`);
} else {
  fail("all declared tools are published", `missing: ${missing.join(", ")}`);
}

// Check 2: no tool drops its declared parameters (the empty-schema regression).
const dropped = [];
for (const tool of tools) {
  const schema = tool.inputSchema ?? {};
  const publishedCount = Object.keys(schema.properties ?? {}).length;
  const declaredCount = declared[tool.name] ?? 0;
  if (schema.type !== "object" || publishedCount < declaredCount) {
    dropped.push(`${tool.name} (declared ${declaredCount}, published ${publishedCount})`);
  }
}
if (dropped.length === 0) {
  pass("no tool drops declared parameters");
} else {
  fail("no tool drops declared parameters", dropped.join("; "));
}

// Check 3: update-invoice publishes the real types (the tool the bug hit).
const ui = byName["update-invoice"];
if (!ui) {
  fail("update-invoice present", "tool not registered");
} else {
  const p = ui.inputSchema?.properties ?? {};
  const problems = [];
  if (!p.invoiceId) problems.push("missing invoiceId");
  if (!p.purpose) problems.push("missing purpose");
  if (p.lineItems?.type !== "array")
    problems.push(`lineItems.type=${p.lineItems?.type} (want array)`);
  if (p.confirm?.type !== "boolean")
    problems.push(`confirm.type=${p.confirm?.type} (want boolean)`);
  if (problems.length === 0) {
    pass("update-invoice publishes real types (lineItems:array, confirm:boolean)");
  } else {
    fail("update-invoice publishes real types (lineItems:array, confirm:boolean)", problems.join("; "));
  }
}

console.log("\n=== Tool Schema Verification ===\n");
let okCount = 0;
for (const c of checks) {
  console.log(`[${c.pass ? "PASS" : "FAIL"}] ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
  if (c.pass) okCount++;
}
console.log(`\n${okCount}/${checks.length} checks passed.`);
process.exit(okCount === checks.length ? 0 : 1);
