#!/usr/bin/env node
/**
 * The pull-request half of CI's production `npm audit` gate: fail only on HIGH/CRITICAL
 * advisories this branch INTRODUCES, i.e. ones absent from the base branch's lockfile.
 *
 * A whole-tree audit deadlocks Dependabot. It opens one PR per advisory when advisories land
 * in different runs (the `security` group in .github/dependabot.yml only batches a single
 * run), and with two open each fix PR fails on the OTHER advisory, so none can go green.
 * Comparing against base breaks that without letting a regression through: a PR that adds or
 * downgrades its way into an advisory still fails. Advisories already on base are printed but
 * don't block here; they stay loud on `main`, where CI's push run keeps the whole-tree audit.
 *
 * Fails closed: if either audit cannot produce a report (npm error, registry outage), that
 * is a failure, never "no advisories".
 *
 * Run: node scripts/audit-new-advisories.mjs [base-ref]   (default: origin/$GITHUB_BASE_REF)
 * Covered offline by: npm run verify:audit-gate
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const BLOCKING = new Set(["high", "critical"]);

/**
 * Map of "<package> <advisory url>" -> severity from `npm audit --json` stdout, or null when
 * that output is not a usable report. npm audit exits non-zero whenever it finds anything, so
 * the exit code alone says nothing; a parseable report with a `vulnerabilities` object is what
 * proves it ran.
 */
export function parseAuditReport(stdout) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!report || typeof report.vulnerabilities !== "object" || report.error) return null;
  const found = new Map();
  for (const [name, vuln] of Object.entries(report.vulnerabilities)) {
    for (const via of vuln.via ?? []) {
      // String entries point at another package's advisory; that package lists it itself.
      if (typeof via === "object") found.set(`${name} ${via.url}`, via.severity);
    }
  }
  return found;
}

/** HIGH+ advisories on head that base does not have, as "<severity> <package> <url>". */
export function introducedBlocking(head, base) {
  const introduced = [];
  for (const [key, severity] of head) {
    if (!base.has(key) && BLOCKING.has(severity)) introduced.push(`${severity} ${key}`);
  }
  return introduced;
}

function audit(cwd, label, extraArgs = []) {
  const run = spawnSync("npm", ["audit", "--omit=dev", "--json", ...extraArgs], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const found = parseAuditReport(run.stdout);
  if (!found) {
    console.error(`npm audit of ${label} produced no report:`);
    console.error(run.stderr || run.stdout);
    process.exit(2);
  }
  return found;
}

function main() {
  const baseRef =
    process.argv[2] ?? (process.env.GITHUB_BASE_REF && `origin/${process.env.GITHUB_BASE_REF}`);
  if (!baseRef) {
    console.error("No base ref: pass one as an argument or set GITHUB_BASE_REF.");
    process.exit(2);
  }

  const head = audit(process.cwd(), "this branch");

  const baseDir = mkdtempSync(join(tmpdir(), "audit-base-"));
  let base;
  try {
    for (const file of ["package.json", "package-lock.json"]) {
      writeFileSync(
        join(baseDir, file),
        execFileSync("git", ["show", `${baseRef}:${file}`], { maxBuffer: 64 * 1024 * 1024 }),
      );
    }
    base = audit(baseDir, baseRef, ["--package-lock-only"]);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }

  for (const [key, severity] of head) {
    console.log(`${severity.padEnd(8)} ${(base.has(key) ? "already on base" : "NEW").padEnd(15)} ${key}`);
  }
  if (head.size === 0) console.log("No production advisories on this branch.");

  const introduced = introducedBlocking(head, base);
  if (introduced.length > 0) {
    console.error(`\nThis branch introduces ${introduced.length} HIGH+ production advisory(ies):`);
    for (const line of introduced) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(`\nNo HIGH+ production advisories introduced relative to ${baseRef}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
