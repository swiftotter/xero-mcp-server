#!/usr/bin/env node
// Verifies that Xero writes are refused unless the connected Xero user is a
// dedicated Claude account. Run after `npm run build`. Offline — no Xero traffic.
//
// Why this exists: the `confirm` gate only asks the agent to check with the
// user; it authorizes nothing. The account gate is what keeps someone's
// everyday Xero login from writing through this connector, so Xero's History
// shows Claude's writes under an account that is visibly Claude's. Nothing else
// fails if the wrapper is dropped from a write path — writes simply succeed —
// hence this guard.
//
// Pass criteria:
//   1. isClaudeAccountEmail: swiftotter.com with "claude" in the local part
//      passes, case-insensitively; everything else (regular login, other
//      domain, look-alike domain, empty) fails.
//   2. A non-Claude email never reaches the inner handler — including with
//      confirm: true — and returns a WRITE BLOCKED error, not a preview.
//   3. A Claude email passes through untouched.
//   4. A failed identity lookup blocks (fail closed) and is NOT cached, so the
//      next write retries; concurrent writes share one lookup; a success is
//      cached.
//   5. Disabled (no Xero user behind the connection) is a pass-through.
//   6. In authorization-code mode — the hosted deployment — the real gate is
//      enabled.
//   7. tool-factory.ts calls requireWriteConfirmation only via gateWrite, so
//      every write path gets the account gate too.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const checks = [];
const assert = (cond, label, detail = "") =>
  checks.push({ label, pass: Boolean(cond), detail });

// Authorization-code config makes xero-client build the per-user client the
// hosted service uses, which is what enables the real gate (criterion 6).
// Bogus values: constructing the client touches neither Xero nor Secret Manager.
process.env.XERO_APP_CLIENT_ID ||= "verify-client-id";
process.env.XERO_APP_CLIENT_SECRET ||= "verify-client-secret";
process.env.XERO_REFRESH_TOKEN_SECRET_NAME ||=
  "projects/verify/secrets/xero-refresh-token-verify";

const { isClaudeAccountEmail, createClaudeAccountGate, requireClaudeAccount } =
  await import(resolve(ROOT, "dist", "helpers", "claude-account-gate.js"));

// 1. The matcher.
for (const email of [
  "sarah+claude@swiftotter.com",
  "jesseclaude2@swiftotter.com",
  "JesseClaude2@SwiftOtter.com",
  "  claude@swiftotter.com ",
]) {
  assert(isClaudeAccountEmail(email), `allows ${JSON.stringify(email)}`);
}
for (const email of [
  "sarah@swiftotter.com",
  "sarah+claude@gmail.com",
  "claude@evil.com",
  "sarah@swiftotter.com.claude.io",
  "sarah@claude.swiftotter.com",
  "@swiftotter.com",
  "",
  null,
  undefined,
]) {
  assert(!isClaudeAccountEmail(email), `blocks ${JSON.stringify(email)}`);
}

// A stand-in write tool that records whether it ran.
function fakeTool() {
  const calls = [];
  return {
    calls,
    tool: {
      name: "create-invoice",
      description: "fake",
      schema: {},
      handler: async (args) => {
        calls.push(args);
        return { content: [{ type: "text", text: "WROTE" }] };
      },
    },
  };
}

const textOf = (result) => result?.content?.[0]?.text ?? "";

// Silence the gate's block log lines while the checks run.
const realConsoleError = console.error;
const logged = [];
console.error = (...args) => logged.push(args.join(" "));

try {
  // 2. Regular login is blocked, with or without confirm.
  {
    const { calls, tool } = fakeTool();
    const gate = createClaudeAccountGate({
      enabled: true,
      loadEmail: async () => "sarah@swiftotter.com",
    });
    const wrapped = gate.wrap(tool);
    const preview = await wrapped.handler({ amount: 1 }, {});
    const confirmed = await wrapped.handler({ amount: 1, confirm: true }, {});
    assert(calls.length === 0, "non-Claude login never reaches the handler");
    assert(
      preview.isError && confirmed.isError,
      "non-Claude login returns an error result",
    );
    assert(
      textOf(confirmed).includes("WRITE BLOCKED") &&
        textOf(confirmed).includes("sarah@swiftotter.com"),
      "block message says WRITE BLOCKED and names the signed-in email",
      textOf(confirmed),
    );
    assert(
      logged.some((line) => line.includes("sarah@swiftotter.com")),
      "block is logged with the signed-in email",
    );
  }

  // 3. Claude account passes through.
  {
    const { calls, tool } = fakeTool();
    const gate = createClaudeAccountGate({
      enabled: true,
      loadEmail: async () => "sarah+claude@swiftotter.com",
    });
    const result = await gate.wrap(tool).handler({ amount: 1 }, {});
    assert(
      calls.length === 1 && textOf(result) === "WROTE",
      "Claude account reaches the handler",
    );
  }

  // 4. Fail closed, no failure caching, shared in-flight lookup, success cached.
  {
    const { calls, tool } = fakeTool();
    let loads = 0;
    let fail = true;
    const gate = createClaudeAccountGate({
      enabled: true,
      loadEmail: async () => {
        loads += 1;
        await new Promise((r) => setTimeout(r, 10));
        if (fail) throw new Error("Xero userinfo returned 503");
        return "jesseclaude2@swiftotter.com";
      },
    });
    const wrapped = gate.wrap(tool);

    const failed = await wrapped.handler({}, {});
    assert(
      failed.isError && calls.length === 0,
      "failed identity lookup blocks the write",
      textOf(failed),
    );

    fail = false;
    loads = 0;
    const [a, b] = await Promise.all([
      wrapped.handler({}, {}),
      wrapped.handler({}, {}),
    ]);
    assert(
      !a.isError && !b.isError && calls.length === 2,
      "a failed lookup is not cached — the next write retries",
    );
    assert(loads === 1, "concurrent writes share one lookup", `loads=${loads}`);

    await wrapped.handler({}, {});
    assert(loads === 1, "a successful lookup is cached", `loads=${loads}`);
  }

  // 5. Disabled is a pass-through, and never looks anything up.
  {
    const { tool } = fakeTool();
    let loads = 0;
    const gate = createClaudeAccountGate({
      enabled: false,
      loadEmail: async () => {
        loads += 1;
        return "sarah@swiftotter.com";
      },
    });
    assert(gate.wrap(tool) === tool, "disabled gate returns the tool unchanged");
    assert(loads === 0, "disabled gate does no lookup");
  }

  // 6. The real gate is on in authorization-code mode.
  {
    const { tool } = fakeTool();
    const wrapped = requireClaudeAccount(tool);
    assert(
      wrapped !== tool && wrapped.handler !== tool.handler,
      "requireClaudeAccount wraps the handler in authorization-code mode",
    );
    assert(
      wrapped.schema === tool.schema,
      "requireClaudeAccount leaves the schema untouched",
    );
  }
} finally {
  console.error = realConsoleError;
}

// 7. Every write path in the factory goes through gateWrite.
{
  const source = readFileSync(
    resolve(ROOT, "src", "tools", "tool-factory.ts"),
    "utf8",
  );
  const bareCalls = source
    .split("\n")
    .filter(
      (line) =>
        !line.trim().startsWith("//") &&
        line.includes("requireWriteConfirmation(") &&
        !line.includes("requireClaudeAccount(requireWriteConfirmation("),
    );
  assert(
    bareCalls.length === 0,
    "tool-factory.ts calls requireWriteConfirmation only inside gateWrite",
    bareCalls.join("\n"),
  );
  assert(
    (source.match(/gateWrite\(/g) ?? []).length >= 5,
    "tool-factory.ts routes delete, get-attachment, create and update through gateWrite",
  );
}

let failed = 0;
for (const { label, pass, detail } of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}`);
  if (!pass) {
    failed += 1;
    if (detail) console.log(`      ${detail.split("\n").join("\n      ")}`);
  }
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
