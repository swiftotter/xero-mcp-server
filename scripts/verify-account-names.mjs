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
//   6. No source file under src/ still emits a bare "Account Code: ${...}" —
//      the exact regression that reintroduces the original bug.

import { readFileSync, readdirSync, statSync } from "node:fs";
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
const { buildAccountLegend } = await import(
  resolve(ROOT, "dist", "helpers", "require-write-confirmation.js")
);

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
  buildAccountLegend(writeArgs, names) ===
    "Accounts referenced: 2230 = Accrued Payroll, 4000 = Sales",
  "write preview names every account referenced in nested line items",
  String(buildAccountLegend(writeArgs, names)),
);
assert(
  buildAccountLegend(writeArgs, EMPTY) === null,
  "write preview omits the legend entirely on a failed lookup",
  String(buildAccountLegend(writeArgs, EMPTY)),
);
assert(
  buildAccountLegend({ contactId: "abc", reference: "no accounts" }, names) ===
    null,
  "write preview omits the legend when no account is referenced",
);

// 6: no source file reintroduces a bare account code
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Matches `Account Code: ${...}` in a template literal — the un-joined render.
// A plain "accountCode" identifier (schemas, filters, handlers) is fine.
const BARE = /Account Code:\s*\$\{/;
const offenders = walk(resolve(ROOT, "src"))
  .filter((file) => BARE.test(readFileSync(file, "utf8")))
  .map((file) => relative(ROOT, file));

assert(
  offenders.length === 0,
  "no source file emits a bare 'Account Code: ${...}'",
  offenders.join(", "),
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
