/**
 * The pure decisions behind recovering from a rejected Xero access token, and the Secret
 * Manager version rules that keep a user's refresh token from being locked away.
 *
 * No I/O, so `scripts/verify-auth-recovery.mjs` asserts every branch.
 *
 * WHY THIS EXISTS. Two separate faults, both in the auth path.
 *
 * **1. `authenticate()` could not tell "I have a working token" from "I know a tenant".**
 * Its cache gate read `this.tenantId && this.accessTokenExpiresAt > now + buffer`.
 * `tenantId` is a public string meaning *which Xero org*, not *do I hold a credential* —
 * and this class has no access-token field at all, because the token lives inside
 * xero-node's private `_tokenSet` and as a plain property on each generated `*Api` object.
 * So a truthy tenantId plus a future timestamp skipped the refresh regardless of whether a
 * usable token existed, and nothing anywhere could force one.
 *
 * **2. An API 401 had no recovery.** The only retry was for `invalid_grant` at the *token
 * endpoint* — a different failure. When Xero rejected the access token itself (revoked
 * connection, removed scope, a token invalidated early), the 401 went straight to
 * `formatError`, which said "Authentication failed. Please check your Xero credentials." The
 * credentials were usually fine; the cached token was not.
 *
 * WHY XERO'S EXPOSURE IS SMALLER THAN THE SIBLING SERVERS', and why the fix is still worth
 * making: `child-pool.ts` keys children by `sub`, so there is one child per user rather than
 * one per session, and deployment pins `max-instances=1`. That removes most of the
 * cross-process token poisoning that made this urgent for the GitHub and Google servers. It
 * does not remove a token revoked or invalidated early, and it does not remove the rolling
 * deploy window that `authorization-code-xero-client.ts` already documents — two instances
 * briefly overlapping, each rotating a single-use refresh token.
 *
 * THE SECRET MANAGER BRICK MATTERS MOST HERE. Xero rotates the refresh token on every
 * refresh and the old one dies immediately, so the stored secret is the only copy of a live
 * credential. The old `disableOldVersions` disabled every ENABLED version except the one it
 * had just written, so two overlapping instances each treated the other's newer version as
 * old and disabled it — leaving no enabled version and a user who cannot authenticate at all
 * until someone re-runs the bootstrap script. `versionsToDestroy` makes that impossible by
 * construction.
 */

/** The HTTP status carried by an AxiosError, an ApiError, or a plain `{status}` object. */
export function statusOf(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as {
    response?: { status?: unknown };
    status?: unknown;
    statusCode?: unknown;
  };
  for (const candidate of [e.response?.status, e.status, e.statusCode]) {
    if (typeof candidate === "number") return candidate;
  }
  return undefined;
}

/**
 * Exactly Xero rejecting the access token — a 401 and nothing else.
 *
 * 403 is deliberately excluded. Xero uses it for a scope the connection does not have and
 * for org-level permission problems, neither of which a new token fixes, and unlike a 401 it
 * can follow work Xero already accepted. That matters because the retry re-sends the request
 * body, and this server creates invoices, credit notes and payments.
 */
export function isUnauthorized(err: unknown): boolean {
  return statusOf(err) === 401;
}

/**
 * Whether a failed API call should be re-sent after forcing a new access token.
 *
 * `alreadyRetried` is the hard bound: exactly one retry per call, so a genuinely dead
 * connection surfaces instead of looping against Xero's auth endpoint.
 */
export function shouldRetryAfterReauth(err: unknown, alreadyRetried: boolean): boolean {
  return !alreadyRetried && isUnauthorized(err);
}

/** Parse the trailing numeric id from a Secret Manager version resource name. */
export function parseVersionNumber(name: string | null | undefined): number | null {
  if (!name) return null;
  const match = /\/versions\/(\d+)$/.exec(name);
  return match ? Number(match[1]) : null;
}

/** Secret Manager reports version state as the enum string "ENABLED" or numeric 1. */
export function isEnabledState(state: string | number | null | undefined): boolean {
  return state === "ENABLED" || state === 1 || state === "1";
}

/** DESTROYED is enum 3. The payload is gone and the version is no longer billed. */
export function isDestroyedState(state: string | number | null | undefined): boolean {
  return state === "DESTROYED" || state === 3 || state === "3";
}

/**
 * The newest ENABLED version's resource name, or null if there is none.
 *
 * Not the `latest` alias: that resolves to the highest-numbered version regardless of state,
 * and `accessSecretVersion` throws `FAILED_PRECONDITION` on a DISABLED one rather than
 * falling back — so one disabled top version broke every read for that user. Taking the
 * highest ENABLED version lets the secret self-heal as soon as any usable version exists.
 */
export function newestEnabledVersion(
  versions: readonly { name?: string | null; state?: string | number | null }[],
): string | null {
  const enabled = versions
    .filter((v) => v.name && isEnabledState(v.state))
    .map((v) => ({ name: v.name as string, num: parseVersionNumber(v.name) ?? -1 }))
    .sort((a, b) => b.num - a.num);
  return enabled.length > 0 ? enabled[0].name : null;
}

/**
 * Which versions may be DESTROYED after writing a new one: ONLY those strictly older.
 *
 * See the header for why this is the load-bearing fix in this repo. The guarantee is that
 * the globally highest version always survives, whichever process wrote it — and it
 * matters more now than it did when this only disabled, because destroying is
 * irreversible, so the all-disabled race it prevents would no longer be recoverable.
 *
 * Destroy, not disable. Secret Manager bills every version that is not DESTROYED, at
 * $0.06/version/month, whether it is ENABLED or DISABLED — so disabling kept the secret
 * tidy and cost exactly as much as doing nothing. Xero rotates its refresh token on every
 * refresh, so this runs constantly: three secrets here had reached 194, 157 and 125
 * disabled versions, about $30/month for this service alone.
 *
 * DISABLED versions are candidates, not exclusions. Cleanup that only looked at ENABLED
 * could never retire a version left behind by the old code or by a half-failed pass, so
 * the backlog could only ever grow. Including them makes this self-healing.
 */
export function versionsToDestroy(
  versions: readonly { name?: string | null; state?: string | number | null }[],
  justWritten: string | null,
): string[] {
  const keep = parseVersionNumber(justWritten);
  if (keep === null) return []; // can't reason about ordering — leave everything alone
  return versions
    .filter((v) => {
      if (!v.name || isDestroyedState(v.state)) return false;
      const num = parseVersionNumber(v.name);
      return num !== null && num < keep;
    })
    .map((v) => v.name as string);
}
