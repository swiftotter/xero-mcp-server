#!/usr/bin/env node
/**
 * Verifies that a Xero 401 forces a new access token and re-sends the call once, plus the
 * pure predicates behind that. Run after `npm run build`.
 *
 * WHY THIS NEEDS AN END-TO-END CHECK. The recovery is implemented as a Proxy over the
 * generated `accountingApi` / `payrollNZApi` objects, because there is no other single
 * place to put it: every handler calls those methods directly (78 call sites), xero-node
 * assigns the access token as a plain property rather than exposing a hook, and the
 * generated methods use the *global* axios default so there is no per-client interceptor to
 * register. A Proxy is the right tool but an easy one to get subtly wrong — in particular it
 * must let `setAccessToken()` WRITE through it, or every refresh silently stops taking
 * effect. That failure is invisible to a unit test of any pure function.
 */

import { MCPXeroClient } from "../dist/clients/auth/mcp-xero-client.js";
import {
  isUnauthorized,
  newestEnabledVersion,
  parseVersionNumber,
  shouldRetryAfterReauth,
  statusOf,
  versionsToDisable,
} from "../dist/clients/auth/token-recovery.js";

const checks = [];
const ok = (label, cond, detail = "") => checks.push({ label, ok: !!cond, detail });
const eq = (label, actual, expected) =>
  checks.push({
    label,
    ok: JSON.stringify(actual) === JSON.stringify(expected),
    detail:
      JSON.stringify(actual) === JSON.stringify(expected)
        ? ""
        : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  });

// ------------------------------------------------------------------ predicates
const axiosErr = (status) => ({ response: { status }, message: "boom" });

ok("a 401 is unauthorized", isUnauthorized(axiosErr(401)));
ok("a 403 is NOT (a new token cannot fix a missing scope)", !isUnauthorized(axiosErr(403)));
ok("a 404 is not", !isUnauthorized(axiosErr(404)));
ok("a 500 is not", !isUnauthorized(axiosErr(500)));
ok("a bare Error is not", !isUnauthorized(new Error("nope")));
ok("null is not", !isUnauthorized(null));
eq("statusOf reads response.status", statusOf(axiosErr(401)), 401);
eq("statusOf reads a flat status", statusOf({ status: 401 }), 401);
eq("statusOf reads statusCode", statusOf({ statusCode: 401 }), 401);
eq("statusOf gives up cleanly", statusOf({}), undefined);

ok("retry a first 401", shouldRetryAfterReauth(axiosErr(401), false));
ok("never retry twice", !shouldRetryAfterReauth(axiosErr(401), true));
ok("never retry a non-401", !shouldRetryAfterReauth(axiosErr(403), false));

// -------------------------------------------------- Secret Manager version rules
const vname = (n) => `projects/p/secrets/s/versions/${n}`;
const V = (n, state = "ENABLED") => ({ name: vname(n), state });

eq("parseVersionNumber", parseVersionNumber(vname(12)), 12);
eq("newestEnabledVersion picks the highest", newestEnabledVersion([V(1), V(3), V(2)]), vname(3));
eq("newestEnabledVersion orders numerically", newestEnabledVersion([V(9), V(10)]), vname(10));
eq(
  "newestEnabledVersion falls back past a DISABLED newer version",
  newestEnabledVersion([V(1), V(2), V(3, "DISABLED")]),
  vname(2),
);
eq("newestEnabledVersion returns null when none are enabled", newestEnabledVersion([V(1, "DISABLED")]), null);

eq("versionsToDisable takes strictly older only", versionsToDisable([V(1), V(2), V(3)], vname(3)), [
  vname(1),
  vname(2),
]);
eq(
  "THE BRICK GUARD: a version newer than ours is never disabled",
  versionsToDisable([V(1), V(2), V(3)], vname(2)),
  [vname(1)],
);
eq("versionsToDisable never takes our own", versionsToDisable([V(5)], vname(5)), []);
eq("versionsToDisable does nothing when it cannot order", versionsToDisable([V(1), V(2)], null), []);

// ------------------------------------------------- the reauth-retry Proxy
/** Minimal client: counts authenticate/invalidate and hands out a fresh token each time. */
class ProbeClient extends MCPXeroClient {
  constructor() {
    super();
    this.authCalls = 0;
    this.invalidateCalls = 0;
    this.tokenSerial = 1;
  }
  async authenticate() {
    this.authCalls += 1;
    // Mirrors what the real clients do: setAccessToken() writes the token onto each api
    // object. This is the write that must survive the Proxy.
    this.setTokenSet({ access_token: `token-${this.tokenSerial}` });
  }
  invalidateAccessToken() {
    this.invalidateCalls += 1;
    this.tokenSerial += 1;
  }
}

const unauthorized = () => Object.assign(new Error("Unauthorized"), {
  response: { status: 401 },
});

/**
 * Where the token actually lands. `accessToken` on a generated api object is a WRITE-ONLY
 * setter on the prototype (`set accessToken(token) { this.authentications.OAuth2.accessToken
 * = token }`), so reading it back gives undefined by design — this is the real storage. The
 * distinction matters for the Proxy: because the setter lives on the prototype and is invoked
 * with `this` bound to the receiver, adding a naive `set` trap that wrote straight to the
 * target would bypass it and silently break every refresh.
 */
const tokenOn = (api) => api.authentications?.OAuth2?.accessToken;

{
  const client = new ProbeClient();
  await client.authenticate();

  const seen = [];
  let n = 0;
  // Assigning through the Proxy lands on the target; reading it back returns the wrapped
  // version, which is what exercises the retry.
  client.accountingApi.getContacts = async function () {
    n += 1;
    seen.push(tokenOn(this));
    if (n === 1) throw unauthorized();
    return { body: { contacts: [] } };
  };

  const result = await client.accountingApi.getContacts("tenant");
  ok("a 401 no longer surfaces to the handler", !!result?.body);
  eq("exactly two attempts", n, 2);
  eq("it re-authenticated once", client.authCalls, 2);
  eq("it invalidated the token once", client.invalidateCalls, 1);
  ok(
    "SETTING THROUGH THE PROXY WORKS: the retry carried the NEW token",
    seen[0] === "token-1" && seen[1] === "token-2",
    `saw ${JSON.stringify(seen)} — if the second is not token-2, setAccessToken() is not reaching the api object through the Proxy`,
  );
}

{
  const client = new ProbeClient();
  await client.authenticate();
  let n = 0;
  client.accountingApi.getContacts = async () => {
    n += 1;
    throw unauthorized();
  };
  let threw = null;
  try {
    await client.accountingApi.getContacts("tenant");
  } catch (e) {
    threw = e;
  }
  ok("a persistent 401 still surfaces", threw !== null);
  eq("it retried exactly once — the Proxy must not recurse", n, 2);
}

{
  const client = new ProbeClient();
  await client.authenticate();
  let n = 0;
  client.accountingApi.getContacts = async () => {
    n += 1;
    throw Object.assign(new Error("Not Found"), { response: { status: 404 } });
  };
  let threw = null;
  try {
    await client.accountingApi.getContacts("tenant");
  } catch (e) {
    threw = e;
  }
  ok("a 404 surfaces", threw !== null);
  eq("a 404 is not retried", n, 1);
  eq("a 404 does not force a re-auth", client.authCalls, 1);
}

{
  const client = new ProbeClient();
  await client.authenticate();
  // Non-function properties must pass through untouched, or setAccessToken() breaks and
  // tenantId-style reads start returning wrapped functions.
  ok(
    "a non-function property reads through the Proxy unchanged",
    typeof client.accountingApi.authentications === "object" &&
      tokenOn(client.accountingApi) === "token-1",
    JSON.stringify({ token: tokenOn(client.accountingApi) }),
  );
  ok(
    "accessToken really is write-only, so reading it back is undefined by design",
    client.accountingApi.accessToken === undefined,
    String(client.accountingApi.accessToken),
  );
  ok("payrollNZApi is wrapped too", typeof client.payrollNZApi === "object");
}

{
  // A client whose credential cannot change must not be retried — the bearer-token client's
  // token comes from the environment and is re-stamped verbatim, so a second attempt would
  // present the identical token. This is the case the shared Proxy used to retry anyway.
  class UnchangingClient extends MCPXeroClient {
    constructor() {
      super();
      this.authCalls = 0;
    }
    async authenticate() {
      this.authCalls += 1;
      this.setTokenSet({ access_token: "fixed-token" });
    }
    invalidateAccessToken() {
      // nothing to invalidate
    }
  }

  const client = new UnchangingClient();
  await client.authenticate();
  let n = 0;
  client.accountingApi.getContacts = async () => {
    n += 1;
    throw unauthorized();
  };
  let threw = null;
  try {
    await client.accountingApi.getContacts("tenant");
  } catch (e) {
    threw = e;
  }
  ok("an unchanging credential surfaces the 401", threw !== null);
  eq("an unchanging credential is NOT retried", n, 1);
}

console.log("\n=== Xero Auth Recovery Checks ===\n");
let okCount = 0;
for (const c of checks) {
  console.log(`[${c.ok ? "PASS" : "FAIL"}] ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
  if (c.ok) okCount++;
}
console.log(`\n${okCount}/${checks.length} checks passed.`);
process.exit(okCount === checks.length ? 0 : 1);
