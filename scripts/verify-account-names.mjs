#!/usr/bin/env node
// Verifies that GL account references render as "Name (code)" and never as a
// bare code. Run after `npm run build`. Offline — no Xero traffic.
//
// Why this exists: Xero returns ONLY `accountCode` on line items and journal
// lines; the account name lives on the separate chart-of-accounts resource. So
// every renderer has to join against getAccountNameMap() or the caller sees the
// number "2230" with nothing attached, and an assistant reading the output has
// no name it could use. The join is easy to drop when a new tool is added or a
// renderer is refactored, and nothing else fails when you do — output stays
// valid, just meaningless. Hence this guard.
//
// Pass criteria:
//   1. formatAccountRef: known code -> "Name (code)".
//   2. formatAccountRef: unknown code -> bare code (graceful, not a crash).
//   3. formatAccountRef: EMPTY map -> bare code. This is the degradation path
//      taken whenever the chart-of-accounts lookup fails; account naming must
//      never be able to break a list or a write preview.
//   4. formatLineItem emits `Account: Name (code)` — and no longer the bare
//      `Account Code:` label.
//   5. The write-confirmation preview carries an "Accounts referenced" legend.
//      That preview dumps raw parameters as JSON — bare "accountCode": "2230" —
//      and the user is told to read it verbatim before approving a write, so it
//      is the one surface where an unnamed code costs the most.
//   6. The cache: reuse within the TTL, refetch after it, concurrent callers
//      share one load, a FAILED load is never cached (so the next call retries),
//      and a successful-but-empty chart of accounts IS cached.
//   7. No source file interpolates an `accountCode` without routing it through
//      formatAccountRef — the exact regression that reintroduces the original
//      bug, in any phrasing.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, relative } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const checks = [];
const assert = (cond, label, detail = "") =>
  checks.push({ label, pass: Boolean(cond), detail });

// account-names.js imports the accounts handler, which pulls in xero-client —
// and that module throws at import time when no credentials are configured.
// Bogus creds satisfy it; nothing here ever calls Xero.
process.env.XERO_CLIENT_ID ||= "verify-client-id";
process.env.XERO_CLIENT_SECRET ||= "verify-client-secret";

const { formatAccountRef } = await import(
  resolve(ROOT, "dist", "helpers", "account-names.js")
);
const { formatLineItem } = await import(
  resolve(ROOT, "dist", "helpers", "format-line-item.js")
);

const names = new Map([
  ["2230", "Accrued Payroll"],
  ["4000", "Sales"],
]);
const EMPTY = new Map();

// 1-3: formatAccountRef
assert(
  formatAccountRef("2230", names) === "Accrued Payroll (2230)",
  "known code renders as Name (code)",
  formatAccountRef("2230", names),
);
assert(
  formatAccountRef("9999", names) === "9999",
  "unknown code falls back to the bare code",
  formatAccountRef("9999", names),
);
assert(
  formatAccountRef("2230", EMPTY) === "2230",
  "empty map (failed lookup) falls back to the bare code",
  formatAccountRef("2230", EMPTY),
);
assert(
  formatAccountRef(undefined, names) === "",
  "missing code renders empty, not 'undefined'",
  formatAccountRef(undefined, names),
);

// 4: formatLineItem
const line = formatLineItem(
  { description: "July accrual", accountCode: "2230", lineAmount: 4200 },
  names,
);
assert(
  line.includes("Account: Accrued Payroll (2230)"),
  "formatLineItem names the account",
  line,
);
assert(
  !line.includes("Account Code:"),
  "formatLineItem no longer emits the bare 'Account Code:' label",
  line,
);
assert(
  formatLineItem({ accountCode: "2230", lineAmount: 1 }, EMPTY).includes(
    "Account: 2230",
  ),
  "formatLineItem degrades to the bare code on a failed lookup",
);

// 5: write-confirmation preview legend
const { buildAccountLegend, collectAccountCodes } = await import(
  resolve(ROOT, "dist", "helpers", "require-write-confirmation.js")
);

const codesOf = (args) => {
  const found = new Set();
  collectAccountCodes(args, found);
  return found;
};

// Shaped like real create-invoice / create-manual-journal arguments: the codes
// live inside a nested array of line objects, not at the top level.
const writeArgs = {
  type: "ACCPAY",
  lineItems: [
    { description: "July accrual", accountCode: "2230", unitAmount: 4200 },
    { description: "Consulting", accountCode: "4000", unitAmount: 100 },
  ],
};

assert(
  buildAccountLegend(codesOf(writeArgs), names) ===
    "Accounts referenced: 2230 = Accrued Payroll, 4000 = Sales",
  "write preview names every account referenced in nested line items",
  String(buildAccountLegend(codesOf(writeArgs), names)),
);
assert(
  buildAccountLegend(codesOf(writeArgs), EMPTY) === null,
  "write preview omits the legend entirely on a failed lookup",
  String(buildAccountLegend(codesOf(writeArgs), EMPTY)),
);
assert(
  buildAccountLegend(
    codesOf({ contactId: "abc", reference: "no accounts" }),
    names,
  ) === null,
  "write preview omits the legend when no account is referenced",
);

// 6: the cache itself — TTL reuse, concurrent de-duplication, no-cache-on-failure.
// Exercised against a stub loader, so this stays offline.
const { createAccountNameCache } = await import(
  resolve(ROOT, "dist", "helpers", "account-names.js")
);

let loads = 0;
const ttlCache = createAccountNameCache(async () => {
  loads++;
  return names;
}, 60);
await ttlCache.get();
await ttlCache.get();
assert(loads === 1, "second call within the TTL reuses the cached map", `loads=${loads}`);
await sleep(80);
await ttlCache.get();
assert(loads === 2, "a call after the TTL expires refetches", `loads=${loads}`);

let concurrentLoads = 0;
const dedupeCache = createAccountNameCache(async () => {
  concurrentLoads++;
  await sleep(20);
  return names;
});
const parallel = await Promise.all(
  Array.from({ length: 5 }, () => dedupeCache.get()),
);
assert(
  concurrentLoads === 1,
  "five concurrent callers share ONE load (in-flight de-duplication)",
  `loads=${concurrentLoads}`,
);
assert(
  parallel.every((map) => map.get("2230") === "Accrued Payroll"),
  "every concurrent caller receives the loaded map",
);

let failLoads = 0;
const failCache = createAccountNameCache(async () => {
  failLoads++;
  throw new Error("Xero unavailable");
});
const failed1 = await failCache.get();
assert(
  failed1.size === 0,
  "a throwing loader resolves to an empty map, never rejects",
);
await failCache.get();
assert(
  failLoads === 2,
  "a failed lookup is NOT cached — the next call retries",
  `loads=${failLoads}`,
);

// An org with no accounts is a real answer, distinct from a failure, so it must
// be cached — otherwise every tool call refetches forever.
let emptyLoads = 0;
const emptyCache = createAccountNameCache(async () => {
  emptyLoads++;
  return new Map();
});
await emptyCache.get();
await emptyCache.get();
assert(
  emptyLoads === 1,
  "a successful but EMPTY chart of accounts is cached, not retried forever",
  `loads=${emptyLoads}`,
);

// 7: no source file reintroduces a bare account code
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Any template interpolation of an accountCode that isn't routed through
// formatAccountRef renders a bare number to the user. Matching the interpolation
// (rather than one fixed label like "Account Code: ${") is deliberate: the first
// version of this guard checked only that label and missed
// `on account ${accountCode}` in the list-invoices/list-manual-journals filter
// summaries — a real instance of this very bug. A plain `accountCode` identifier
// outside a template literal (schemas, filters, handlers) is fine.
const INTERPOLATED = /\$\{[^}]*accountCode[^}]*\}/gi;
const offenders = [];
for (const file of walk(resolve(ROOT, "src"))) {
  const bare = (readFileSync(file, "utf8").match(INTERPOLATED) ?? []).filter(
    (match) => !match.includes("formatAccountRef"),
  );
  if (bare.length > 0) {
    offenders.push(`${relative(ROOT, file)}: ${bare.join(" | ")}`);
  }
}

assert(
  offenders.length === 0,
  "no source file interpolates an accountCode without formatAccountRef",
  offenders.join("; "),
);

let failed = 0;
for (const check of checks) {
  if (check.pass) {
    console.log(`  PASS  ${check.label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${check.label}${check.detail ? ` — ${check.detail}` : ""}`);
  }
}
console.log(
  `\n${checks.length - failed}/${checks.length} checks passed${failed ? " — FAILED" : ""}`,
);
process.exit(failed ? 1 : 0);
