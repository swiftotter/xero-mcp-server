#!/usr/bin/env node
/**
 * Guards the decision logic of scripts/audit-new-advisories.mjs, CI's PR-time audit gate.
 *
 * Two ways it could silently break: blocking on advisories already on base (re-creating the
 * Dependabot deadlock it exists to prevent), or passing a branch that adds one. Worse still
 * would be treating an npm error or an empty stdout as "no advisories", so the fail-closed
 * parse is asserted too. Offline: fixtures only, no npm audit, no network.
 *
 * Run: npm run verify:audit-gate
 */
import assert from "node:assert";
import { introducedBlocking, parseAuditReport } from "./audit-new-advisories.mjs";

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`PASS  ${name}`);
}

const GHSA = (id) => `https://github.com/advisories/GHSA-${id}`;
const report = (vulns) =>
  JSON.stringify({
    vulnerabilities: Object.fromEntries(
      Object.entries(vulns).map(([name, via]) => [name, { name, via }]),
    ),
  });

const base = parseAuditReport(
  report({
    "proxy-addr": [{ severity: "critical", url: GHSA("aaaa") }],
    hono: [{ severity: "moderate", url: GHSA("bbbb") }],
  }),
);

check("an advisory already on base does not block", () => {
  assert.deepStrictEqual(introducedBlocking(base, base), []);
});

check("a fix PR with other advisories still open on base passes", () => {
  const head = parseAuditReport(report({ hono: [{ severity: "moderate", url: GHSA("bbbb") }] }));
  assert.deepStrictEqual(introducedBlocking(head, base), []);
});

check("a NEW high advisory blocks", () => {
  const head = parseAuditReport(
    report({
      "proxy-addr": [{ severity: "critical", url: GHSA("aaaa") }],
      "follow-redirects": [{ severity: "high", url: GHSA("cccc") }],
    }),
  );
  assert.deepStrictEqual(introducedBlocking(head, base), [
    `high follow-redirects ${GHSA("cccc")}`,
  ]);
});

check("a NEW critical advisory blocks", () => {
  const head = parseAuditReport(report({ x: [{ severity: "critical", url: GHSA("dddd") }] }));
  assert.strictEqual(introducedBlocking(head, base).length, 1);
});

check("a NEW moderate or low advisory does not block", () => {
  const head = parseAuditReport(
    report({
      a: [{ severity: "moderate", url: GHSA("eeee") }],
      b: [{ severity: "low", url: GHSA("ffff") }],
    }),
  );
  assert.deepStrictEqual(introducedBlocking(head, base), []);
});

check("the same advisory on a different package counts as new", () => {
  const head = parseAuditReport(report({ other: [{ severity: "critical", url: GHSA("aaaa") }] }));
  assert.strictEqual(introducedBlocking(head, base).length, 1);
});

check("string `via` entries (pointers to another package) are not double-counted", () => {
  const head = parseAuditReport(
    report({ express: ["proxy-addr"], "proxy-addr": [{ severity: "critical", url: GHSA("aaaa") }] }),
  );
  assert.strictEqual(head.size, 1);
});

check("a clean report parses to an empty map, not null", () => {
  const empty = parseAuditReport(report({}));
  assert.ok(empty instanceof Map);
  assert.strictEqual(empty.size, 0);
});

check("fails closed: empty stdout is not a report", () => {
  assert.strictEqual(parseAuditReport(""), null);
});

check("fails closed: garbled stdout is not a report", () => {
  assert.strictEqual(parseAuditReport("npm ERR! network"), null);
});

check("fails closed: an npm error object is not a report", () => {
  assert.strictEqual(
    parseAuditReport(JSON.stringify({ error: { code: "ENOLOCK" }, vulnerabilities: {} })),
    null,
  );
});

check("fails closed: JSON without `vulnerabilities` is not a report", () => {
  assert.strictEqual(parseAuditReport(JSON.stringify({ auditReportVersion: 2 })), null);
});

console.log(`${passed}/${passed} checks passed`);
