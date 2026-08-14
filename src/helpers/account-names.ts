import { listXeroAccounts } from "../handlers/list-xero-accounts.handler.js";

/**
 * Account code -> account name, for rendering GL references as
 * "Accrued Payroll (2230)" instead of a bare "2230".
 *
 * Xero returns only `accountCode` on line items and journal lines — the name
 * lives on the separate chart-of-accounts resource — so every renderer that
 * shows a code has to join against this map or the caller sees a number with no
 * meaning attached.
 */
export type AccountNameMap = ReadonlyMap<string, string>;

const EMPTY: AccountNameMap = new Map<string, string>();

// The chart of accounts is small and changes rarely, but a single list-invoices
// call can render dozens of lines — so memoize per process. One long-lived child
// process per user (see child-pool.ts) means this cache is per-user and dies
// with the child; it is an in-process memo, not transport state.
const TTL_MS = 5 * 60 * 1000;

/**
 * A loader resolves the current chart of accounts, or `null` if it could not be
 * read. `null` and "an org with no accounts" are deliberately distinct: an empty
 * map is a real, cacheable answer, while a failure must not be cached.
 */
export type AccountNameLoader = () => Promise<AccountNameMap | null>;

export interface AccountNameCache {
  get(): Promise<AccountNameMap>;
  reset(): void;
}

/**
 * Memoize a loader for `ttlMs`, collapsing concurrent callers onto one load and
 * never caching a failure. Exported (rather than inlined) so the caching itself
 * is testable against a stub loader — see scripts/verify-account-names.mjs.
 */
export function createAccountNameCache(
  load: AccountNameLoader,
  ttlMs: number = TTL_MS,
): AccountNameCache {
  let cached: AccountNameMap | null = null;
  let cachedAt = 0;
  let inFlight: Promise<AccountNameMap> | null = null;

  return {
    async get(): Promise<AccountNameMap> {
      if (cached && Date.now() - cachedAt < ttlMs) {
        return cached;
      }
      // Assigned synchronously below, so a second caller arriving before the
      // first load settles joins it instead of starting its own.
      if (inFlight) {
        return inFlight;
      }

      inFlight = load()
        .catch(() => null)
        .then((map) => {
          // Never cache a failure — the next call should retry. An empty map
          // from a successful read IS cached; it's a valid answer.
          if (map !== null) {
            cached = map;
            cachedAt = Date.now();
            return map;
          }
          return EMPTY;
        })
        .finally(() => {
          inFlight = null;
        });

      return inFlight;
    },

    reset(): void {
      cached = null;
      cachedAt = 0;
      inFlight = null;
    },
  };
}

const loadAccountNames: AccountNameLoader = async () => {
  const response = await listXeroAccounts();

  // Never throw: an account-name lookup must not be able to break a list or a
  // write preview. On failure callers degrade to showing the bare code.
  if (response.isError || !response.result) {
    return null;
  }

  const map = new Map<string, string>();
  for (const account of response.result) {
    if (account.code && account.name) {
      map.set(account.code, account.name);
    }
  }
  return map;
};

const accountNameCache = createAccountNameCache(loadAccountNames);

/**
 * Chart of accounts as code -> name. Cached for TTL_MS; concurrent callers share
 * one request. Resolves to an empty map rather than rejecting.
 */
export function getAccountNameMap(): Promise<AccountNameMap> {
  return accountNameCache.get();
}

/**
 * Render a GL account reference as "Name (code)", falling back to the bare code
 * when the name is unknown (unmapped code, or a failed/empty lookup).
 */
export function formatAccountRef(
  code: string | undefined | null,
  accountNames: AccountNameMap,
): string {
  if (!code) {
    return "";
  }
  const name = accountNames.get(String(code));
  return name ? `${name} (${code})` : String(code);
}
