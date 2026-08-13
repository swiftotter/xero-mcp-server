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
// It also guards the JSON-string argument coercion (coerceJsonishShape, applied
// in ToolFactory's register()). That shim exists because some clients serialize a
// complex argument as a JSON string — Cowork sends create-manual-journal's
// `manualJournalLines` as "[{…},{…}]" — and it must be INVISIBLE: same published
// schema, scalars still strict.
//
// Pass criteria:
//   1. Every declared tool is present on tools/list.
//   2. Every published tool has inputSchema.type === "object" and does NOT drop
//      declared properties.
//   3. update-invoice publishes the real types (the tool the bug hit):
//      invoiceId + purpose present, lineItems is an array, confirm is a boolean.
//   4. No schema drift: every tool's published inputSchema is deep-equal to what
//      the same tool publishes when registered WITHOUT the coercion shim.
//   5. A JSON-string array is accepted: create-manual-journal called with
//      `manualJournalLines` as a string (and no confirm) returns the write
//      preview — validation passed and the gate held, with no Xero traffic.
//   6. Nested case: create-invoice with a real lineItems array whose `tracking`
//      is a JSON string also reaches the preview. And the object branch, which
//      no array case exercises: add-timesheet-line with its `timesheetLine`
//      object as a JSON string.
//   7. Coercion stays narrow: a non-JSON string still fails with the original
//      "Expected array" error, and confirm:"true" is still rejected (a
//      stringified boolean must never satisfy the confirmation gate).

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
const { requireWriteConfirmation } = await distImport(
  "helpers/require-write-confirmation.js",
);
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

// ---------------------------------------------------------------------------
// Check 4: the JSON-string coercion shim must not change a published schema.
//
// Register the same tools on a second server with the RAW shapes (no
// coerceJsonishShape) and deep-compare per tool. Write tools get `confirm`
// injected by the real requireWriteConfirmation so the property sets match; the
// action argument only affects description text, never the schema, so passing
// "create" for all of them is fine here.
// ---------------------------------------------------------------------------
const writeNames = new Set(
  [...CreateTools, ...DeleteTools, ...UpdateTools].map((factory) => factory().name),
);
writeNames.add("get-attachment"); // annotated as a write in ToolFactory

const rawServer = new McpServer({ name: "verify-raw", version: "0.0.0" });
for (const group of [CreateTools, DeleteTools, GetTools, ListTools, UpdateTools]) {
  for (const factory of group) {
    let tool = factory();
    if (writeNames.has(tool.name)) tool = requireWriteConfirmation("create", tool);
    rawServer.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      tool.handler,
    );
  }
}
const [rawClientTransport, rawServerTransport] = InMemoryTransport.createLinkedPair();
await rawServer.connect(rawServerTransport);
const rawClient = new Client({ name: "verify-raw", version: "0.0.0" });
await rawClient.connect(rawClientTransport);
const rawByName = Object.fromEntries(
  (await rawClient.listTools()).tools.map((t) => [t.name, t]),
);

// Key order can differ between two conversions of the same shape; compare on
// value, not on serialization order.
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable(value[k])]),
    );
  }
  return value;
};
const stableJson = (value) => JSON.stringify(stable(value));

const drifted = [];
for (const tool of tools) {
  const raw = rawByName[tool.name];
  if (!raw) {
    drifted.push(`${tool.name} (missing from raw registration)`);
    continue;
  }
  if (stableJson(tool.inputSchema) !== stableJson(raw.inputSchema)) {
    drifted.push(tool.name);
  }
}
if (drifted.length === 0) {
  pass("JSON-string coercion does not change any published schema", `${tools.length} tools compared`);
} else {
  fail(
    "JSON-string coercion does not change any published schema",
    `drifted: ${drifted.join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Checks 5-7: the coercion behaves at call time. These all stop at the write
// confirmation gate, so nothing reaches Xero.
// ---------------------------------------------------------------------------
const callText = async (name, args) => {
  try {
    const result = await client.callTool({ name, arguments: args });
    return result?.content?.[0]?.text ?? JSON.stringify(result);
  } catch (error) {
    return `THREW: ${error.message}`;
  }
};

const journalLines = [
  { lineAmount: 100, accountCode: "200", description: "coercion check" },
  { lineAmount: -100, accountCode: "400", description: "coercion check" },
];

const stringifiedArrayText = await callText("create-manual-journal", {
  narration: "schema verification — never written",
  manualJournalLines: JSON.stringify(journalLines),
  purpose: "verify JSON-string array coercion",
});
if (stringifiedArrayText.startsWith("[CONFIRMATION REQUIRED")) {
  pass("stringified manualJournalLines is accepted (and stops at the gate)");
} else {
  fail(
    "stringified manualJournalLines is accepted (and stops at the gate)",
    `got: ${stringifiedArrayText.slice(0, 160)}…`,
  );
}

const nestedText = await callText("create-invoice", {
  type: "ACCREC",
  contactId: "00000000-0000-0000-0000-000000000000",
  lineItems: [
    {
      description: "coercion check",
      quantity: 1,
      unitAmount: 1,
      accountCode: "200",
      taxType: "NONE",
      tracking: JSON.stringify([
        { name: "Main", option: "Build", trackingCategoryID: "00000000-0000-0000-0000-000000000000" },
      ]),
    },
  ],
  purpose: "verify nested JSON-string array coercion",
});
if (nestedText.startsWith("[CONFIRMATION REQUIRED")) {
  pass("stringified nested tracking array is accepted");
} else {
  fail("stringified nested tracking array is accepted", `got: ${nestedText.slice(0, 160)}…`);
}

// The ZodObject branch of the coercion needs its own call-time check: several
// tools take a required, non-array object param, and check 4 cannot see this gap
// (a no-op object branch publishes an identical schema), so a regression that
// disabled object coercion while leaving arrays working would otherwise pass.
const objectParamText = await callText("add-timesheet-line", {
  timesheetID: "00000000-0000-0000-0000-000000000000",
  timesheetLine: JSON.stringify({
    earningsRateID: "00000000-0000-0000-0000-000000000000",
    numberOfUnits: 8,
    date: "2026-01-01",
  }),
  purpose: "verify JSON-string object coercion",
});
if (objectParamText.startsWith("[CONFIRMATION REQUIRED")) {
  pass("stringified object param (timesheetLine) is accepted");
} else {
  fail(
    "stringified object param (timesheetLine) is accepted",
    `got: ${objectParamText.slice(0, 160)}…`,
  );
}

const notJsonText = await callText("create-manual-journal", {
  narration: "schema verification — never written",
  manualJournalLines: "not json",
  purpose: "verify non-JSON string still fails",
});
if (/Expected array, received string/.test(notJsonText)) {
  pass("a non-JSON string still fails with the original type error");
} else {
  fail(
    "a non-JSON string still fails with the original type error",
    `got: ${notJsonText.slice(0, 160)}…`,
  );
}

const stringConfirmText = await callText("create-manual-journal", {
  narration: "schema verification — never written",
  manualJournalLines: journalLines,
  purpose: "verify stringified boolean cannot confirm",
  confirm: "true",
});
if (/Expected boolean, received string/.test(stringConfirmText)) {
  pass('confirm:"true" is still rejected (scalars stay strict)');
} else {
  fail(
    'confirm:"true" is still rejected (scalars stay strict)',
    `got: ${stringConfirmText.slice(0, 160)}…`,
  );
}

console.log("\n=== Tool Schema Verification ===\n");
let okCount = 0;
for (const c of checks) {
  console.log(`[${c.pass ? "PASS" : "FAIL"}] ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
  if (c.pass) okCount++;
}
console.log(`\n${okCount}/${checks.length} checks passed.`);
process.exit(okCount === checks.length ? 0 : 1);
